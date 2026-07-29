import * as vscode from 'vscode';
import * as path from 'path';
import {
  AccountSnapshot,
  CONFIG_DIR_VAR,
  DEFAULT_CONFIG_DIR,
  ProjectAudit,
  ResolvedConsumer,
  WindowState,
  auditProjects,
  cliError,
  cliStatus,
  effectiveEmail,
  effectiveOrg,
  isExplicitDir,
  isVerified,
  primaryConsumer,
  realConsumers,
  storeLabel,
  tilde,
  windowVerdict,
  worstConsumer,
  watchTargets,
} from './accountReader';
import { config, currentFolderPath, loadWindowState, projectsRoot } from './settings';
import { ERROR, INFO, PASS, WARN, verdictCopy } from './verdictCopy';

export class AccountItem extends vscode.TreeItem {
  children?: AccountItem[];
  /** Value put on the clipboard by claudeAccount.copyValue. */
  copyValue?: string;
  /** File opened by claudeAccount.openFile. */
  filePath?: string;

  constructor(id: string, label: string, collapsed?: vscode.TreeItemCollapsibleState) {
    super(label, collapsed ?? vscode.TreeItemCollapsibleState.None);
    // A stable id keeps expansion state and selection across the frequent
    // refreshes this extension does; without it VS Code derives identity from
    // the label path and collapses nodes under the user.
    this.id = id;
  }
}

function icon(id: string, color?: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

/** Context for the verdict copy of a given consumer. */
export function copyContextFor(state: WindowState, consumer: ResolvedConsumer) {
  const { snapshot } = consumer;
  return {
    email: effectiveEmail(snapshot),
    expected: state.expectedAccount,
    store: storeLabel(snapshot),
    offender: consumer.kind === 'terminal' ? undefined : consumer.name,
    apiKeySource: cliStatus(snapshot)?.apiKeySource,
    verified: isVerified(snapshot),
    shared: !state.isolated,
  };
}

export function windowCopy(state: WindowState) {
  const consumer = worstConsumer(state);
  return verdictCopy(windowVerdict(state), copyContextFor(state, consumer));
}

export function accountTooltip(snapshot: AccountSnapshot, heading: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${heading}**\n\n`);

  const status = cliStatus(snapshot);
  md.appendMarkdown(`- Account: \`${effectiveEmail(snapshot) ?? 'none'}\`\n`);
  const org = effectiveOrg(snapshot);
  if (org) {
    md.appendMarkdown(`- Organization: ${org}\n`);
  }
  if (status?.subscriptionType) {
    md.appendMarkdown(`- Plan: ${status.subscriptionType}\n`);
  }
  if (status?.authMethod) {
    md.appendMarkdown(`- Auth method: ${status.authMethod}\n`);
  }
  if (status?.apiKeySource) {
    md.appendMarkdown(`- **API key in use:** \`${status.apiKeySource}\` — supersedes the OAuth login\n`);
  }
  md.appendMarkdown(`- Store: ${storeLabel(snapshot)} _(${snapshot.source})_\n`);

  if (isVerified(snapshot)) {
    md.appendMarkdown('- Source: **live `claude auth status`** for this store\n');
  } else {
    md.appendMarkdown(
      `- Source: on-disk ${snapshot.accountFile ? `\`${tilde(snapshot.accountFile)}\`` : '_no account file found_'}\n`
    );
    const error = cliError(snapshot);
    if (error) {
      md.appendMarkdown(`- CLI error: ${error}\n`);
    }
  }
  if (snapshot.error) {
    md.appendMarkdown(`- **Error:** ${snapshot.error}\n`);
  }

  md.appendMarkdown(`\nRead at ${snapshot.readAt.toLocaleTimeString()} — never cached.`);
  return md;
}

export class AccountProvider implements vscode.TreeDataProvider<AccountItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<AccountItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Fires after every load so ambient surfaces can react even when hidden. */
  private _onDidLoad = new vscode.EventEmitter<WindowState>();
  readonly onDidLoad = this._onDidLoad.event;

  private watchers: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private watched: string = '';

  private state: WindowState | undefined;
  private inFlight: Promise<WindowState> | undefined;
  private generation = 0;
  lastLoadedAt = 0;

  constructor() {
    this.restartWatchers();
    this.restartPolling();
  }

  /**
   * Read and verify, coalescing concurrent callers.
   *
   * Every ambient surface is driven from here rather than from `getChildren`,
   * because VS Code only calls `getChildren` while the view is visible — which
   * previously froze the status bar and the wrong-account alert for the whole
   * life of a window whose Explorer was not selected.
   */
  async load(): Promise<WindowState> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const generation = ++this.generation;
    this.inFlight = loadWindowState().finally(() => {
      this.inFlight = undefined;
    });

    const state = await this.inFlight;
    if (generation !== this.generation) {
      return state; // A newer load already won; do not publish stale data.
    }

    this.state = state;
    this.lastLoadedAt = Date.now();
    this.restartWatchers(state);
    this._onDidLoad.fire(state);
    this._onDidChangeTreeData.fire();
    return state;
  }

  /**
   * Trailing-edge debounce. The CLI rewrites several files during one login, and
   * driving a load per write would turn a sign-in into a subprocess storm.
   */
  scheduleLoad(delayMs = 400): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.load();
    }, delayMs);
  }

  refresh(): void {
    void this.load();
  }

  getTreeItem(element: AccountItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AccountItem): Promise<AccountItem[]> {
    if (element) {
      return element.children ?? [];
    }
    // An empty root is what lets viewsWelcome render its onboarding copy.
    if (!vscode.workspace.workspaceFolders) {
      return [];
    }
    return this.buildRoot(this.state ?? (await this.load()));
  }

  private buildRoot(state: WindowState): AccountItem[] {
    const items: AccountItem[] = [this.verdictItem(state)];

    if (windowVerdict(state) === 'wrong' || windowVerdict(state) === 'api-key') {
      items.push(this.expectedItem(state));
    }
    items.push(this.storeItem(state));

    const notIsolated = this.notIsolatedItem(state);
    if (notIsolated) {
      items.push(notIsolated);
    }
    const leak = this.repoLeakItem(state);
    if (leak) {
      items.push(leak);
    }
    if (state.overrides.kind === 'unreadable') {
      items.push(this.unreadableItem(state.overrides.file, state.overrides.error));
    }

    const overrides = this.overridesItem(state);
    if (overrides) {
      items.push(overrides);
    }

    items.push(this.consumersItem(state));

    const projects = this.projectsItem(state);
    if (projects) {
      items.push(projects);
    }
    return items;
  }

  /** The headline: is this the account this project is supposed to use? */
  private verdictItem(state: WindowState): AccountItem {
    const consumer = worstConsumer(state);
    const copy = windowCopy(state);

    const item = new AccountItem('verdict', copy.label);
    item.description = copy.treeDescription;
    item.iconPath = icon(copy.icon, copy.color);
    item.contextValue = 'copyable';
    item.copyValue = effectiveEmail(consumer.snapshot) ?? '';
    item.command = { command: copy.command, title: copy.label };

    const tooltip = new vscode.MarkdownString(`${copy.detail}\n\n`);
    tooltip.appendMarkdown(accountTooltip(consumer.snapshot, consumer.name).value);
    item.tooltip = tooltip;
    return item;
  }

  private expectedItem(state: WindowState): AccountItem {
    const item = new AccountItem('expected', 'Expected');
    item.description = state.expectedAccount;
    item.iconPath = icon('pin', INFO);
    item.tooltip = new vscode.MarkdownString(
      `This project is pinned to \`${state.expectedAccount}\`. Change it with **Pin Expected Account**, or switch which account the project uses with **Use a Specific Account For This Project**.`
    );
    item.command = { command: 'claudeAccount.setExpectedAccount', title: 'Pin Expected Account' };
    return item;
  }

  private storeItem(state: WindowState): AccountItem {
    const snapshot = primaryConsumer(state).snapshot;
    const item = new AccountItem('store', storeLabel(snapshot));
    item.description = snapshot.source;
    item.iconPath = icon('folder-library');
    item.tooltip = new vscode.MarkdownString(
      `The credential store the integrated terminal uses.\n\n` +
        `On macOS, credentials are stored in the Keychain keyed by \`${CONFIG_DIR_VAR}\`, so a distinct dir is a fully distinct login. ` +
        `Leaving the variable unset is itself a distinct store — not the same as setting it to \`${tilde(DEFAULT_CONFIG_DIR)}\`.`
    );
    item.contextValue = 'copyable';
    item.copyValue = snapshot.configDir;
    if (state.overrides.kind === 'parsed') {
      item.contextValue = 'copyable openable';
      item.filePath = state.overrides.file;
    }
    return item;
  }

  /**
   * The row that turns "this project shares a login" from an invisible default
   * into a one-click fix.
   */
  private notIsolatedItem(state: WindowState): AccountItem | undefined {
    if (!state.workspaceRoot || state.isolated) {
      return undefined;
    }
    const item = new AccountItem('notIsolated', 'Not isolated');
    item.description = 'shares one login with every other project';
    item.iconPath = icon('warning', WARN);
    item.command = {
      command: 'claudeAccount.useAccountForThisProject',
      title: 'Use a Specific Account For This Project',
    };
    item.tooltip = new vscode.MarkdownString(
      state.processConfigDir
        ? `This window inherits \`${CONFIG_DIR_VAR}\` from its environment, but the folder itself declares nothing — so the isolation is not part of the project and will not follow it.\n\nClick to give this folder its own account.`
        : `This folder declares no \`${CONFIG_DIR_VAR}\`, so it uses the same credential store as every other unconfigured project. Signing in here changes the account for all of them.\n\nClick to give this folder its own account.`
    );
    return item;
  }

  /**
   * A committed settings file carrying a personal CLAUDE_CONFIG_DIR is a change
   * your teammates would receive. Worth saying out loud, because git status is
   * the only other place it shows up and it looks like an ordinary edit.
   */
  private repoLeakItem(state: WindowState): AccountItem | undefined {
    if (!state.isolated || state.overrides.kind !== 'parsed') {
      return undefined;
    }
    if (state.settingsTracking !== 'tracked') {
      return undefined;
    }

    const item = new AccountItem('repoLeak', 'Committed to this repo');
    item.description = 'teammates would get your config dir';
    item.iconPath = icon('warning', WARN);
    item.tooltip = new vscode.MarkdownString(
      `\`${tilde(state.overrides.file)}\` is tracked by git and declares \`${CONFIG_DIR_VAR}\`, which is a machine-local fact about **your** login — not something your teammates want.\n\n` +
        'Fix it one of these ways:\n\n' +
        '- **Use a Specific Account For This Project** again and choose *All my projects*, which writes to user settings and leaves the repo alone\n' +
        `- \`git update-index --skip-worktree ${path.relative(state.workspaceRoot ?? '', state.overrides.file)}\` to mask your local edit\n` +
        '- Move the folder into an external `.code-workspace` file kept outside the repo'
    );
    item.contextValue = 'openable';
    item.filePath = state.overrides.file;
    return item;
  }

  private unreadableItem(file: string, error: string): AccountItem {
    const item = new AccountItem('overridesError', 'Workspace settings unreadable');
    item.description = tilde(file);
    item.iconPath = icon('error', ERROR);
    item.tooltip = new vscode.MarkdownString(
      `${error}\n\nThe setup flow refuses to write to this file until it parses.`
    );
    item.contextValue = 'openable';
    item.filePath = file;
    item.command = { command: 'claudeAccount.openFile', title: 'Open', arguments: [item] };
    return item;
  }

  /**
   * Everything that can supersede or undermine the account, under one node so a
   * window with several of them cannot push the rest of the tree below the fold.
   */
  private overridesItem(state: WindowState): AccountItem | undefined {
    const children: AccountItem[] = [];
    const snapshot = primaryConsumer(state).snapshot;

    const apiKeySource = cliStatus(snapshot)?.apiKeySource;
    if (apiKeySource) {
      const child = new AccountItem(`apikey:live:${apiKeySource}`, `API key in use: ${apiKeySource}`);
      child.description = 'supersedes the login';
      child.iconPath = icon('key', ERROR);
      child.tooltip = new vscode.MarkdownString(
        `\`claude auth status\` reports it is using an API key from \`${apiKeySource}\`. Requests are billed to that key, not to the account shown above.`
      );
      children.push(child);
    }

    for (const name of state.processApiKeyVars) {
      const child = new AccountItem(`apikey:env:${name}`, `${name} is set`);
      child.description = "this window's environment";
      child.iconPath = icon('warning', WARN);
      child.tooltip = new vscode.MarkdownString(
        `\`${name}\` is present in this window's environment. Claude Code prefers it over any logged-in account.`
      );
      children.push(child);
    }

    for (const entry of state.settingsApiKeys) {
      const child = new AccountItem(`apikey:file:${entry.variable}:${entry.file}`, `${entry.variable} in settings`);
      child.description = tilde(entry.file);
      child.iconPath = icon('warning', WARN);
      child.tooltip = new vscode.MarkdownString(
        `\`${entry.variable}\` is declared in \`${tilde(entry.file)}\`. An API key takes precedence over a logged-in account.`
      );
      child.contextValue = 'openable';
      child.filePath = entry.file;
      child.command = { command: 'claudeAccount.openFile', title: 'Open', arguments: [child] };
      children.push(child);
    }

    for (const problem of state.settingsProblems) {
      const child = new AccountItem(`problem:${problem.file}`, 'Settings file unreadable');
      child.description = tilde(problem.file);
      child.iconPath = icon('error', ERROR);
      child.tooltip = new vscode.MarkdownString(
        `\`${tilde(problem.file)}\` could not be parsed (${problem.error}), so any \`env\` block in it — including an API key — is not being checked.`
      );
      child.contextValue = 'openable';
      child.filePath = problem.file;
      child.command = { command: 'claudeAccount.openFile', title: 'Open', arguments: [child] };
      children.push(child);
    }

    const trap = this.defaultDirTrapChild(state);
    if (trap) {
      children.push(trap);
    }

    if (children.length === 0) {
      return undefined;
    }

    const item = new AccountItem(
      'overrides',
      'Account overrides',
      children.length > 2
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded
    );
    item.description = `${children.length} in effect`;
    item.iconPath = icon('warning', WARN);
    item.children = children;
    return item;
  }

  /**
   * Pointing CLAUDE_CONFIG_DIR at `~/.claude` looks like "use the default
   * account" but is a separate, usually empty, store. The symptom is a
   * mysteriously logged-out project.
   */
  private defaultDirTrapChild(state: WindowState): AccountItem | undefined {
    const offender = realConsumers(state).find(
      consumer =>
        isExplicitDir(consumer.snapshot.source) &&
        path.resolve(consumer.snapshot.configDir) === DEFAULT_CONFIG_DIR
    );
    if (!offender) {
      return undefined;
    }

    const item = new AccountItem('trap', `${CONFIG_DIR_VAR} is set to the default dir`);
    item.description = 'not the same as leaving it unset';
    item.iconPath = icon('warning', WARN);
    item.tooltip = new vscode.MarkdownString(
      `\`${CONFIG_DIR_VAR}\` is explicitly set to \`${tilde(DEFAULT_CONFIG_DIR)}\`.\n\n` +
        `That is **not** equivalent to leaving it unset: an explicit value selects a separate store at ` +
        `\`${tilde(path.join(DEFAULT_CONFIG_DIR, '.claude.json'))}\`, while unset uses the legacy ` +
        `\`~/.claude.json\`. A project set up this way appears logged out even though the default account works.\n\n` +
        `Either remove the override, or point it at a dedicated dir such as \`~/.claude-work\`.`
    );
    return item;
  }

  private consumersItem(state: WindowState): AccountItem {
    const primaryEmail = effectiveEmail(primaryConsumer(state).snapshot);
    // Agreement is about the *account*, not the directory. Two stores holding
    // the same login are equivalent in effect and must not raise a warning.
    const disagreeing = realConsumers(state).filter(
      c => effectiveEmail(c.snapshot) !== primaryEmail
    );
    const agree = disagreeing.length === 0;

    const item = new AccountItem(
      'consumers',
      'Who uses what',
      agree ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded
    );

    if (agree) {
      item.description = 'terminal and sidebar agree';
      item.iconPath = icon('check', PASS);
      item.tooltip = new vscode.MarkdownString(
        'Every Claude Code surface in this window resolves the same account.'
      );
    } else {
      const names = disagreeing.map(c => c.name.toLowerCase()).join(' and ');
      item.description = `${names} on a different account`;
      item.iconPath = icon('warning', WARN);
      item.tooltip = new vscode.MarkdownString(
        `The terminal resolves \`${primaryEmail ?? 'no account'}\`, but the ${names} resolves ` +
          `${disagreeing.map(c => `\`${effectiveEmail(c.snapshot) ?? 'no account'}\``).join(' and ')}. ` +
          'They can be signed in as different accounts in the same window.'
      );
    }

    item.children = state.consumers.map(consumer => {
      const email = effectiveEmail(consumer.snapshot);
      const differs = !consumer.diagnosticOnly && email !== primaryEmail;
      const child = new AccountItem(`consumer:${consumer.kind}`, consumer.name);

      // When something disagrees, every row shows its email so the two can
      // actually be compared; otherwise the store alone is the useful detail.
      child.description = agree
        ? storeLabel(consumer.snapshot)
        : `${email ?? 'not logged in'} · ${storeLabel(consumer.snapshot)}`;

      child.iconPath = consumer.diagnosticOnly
        ? icon('info')
        : differs
          ? icon('warning', WARN)
          : email
            ? icon('pass', PASS)
            : icon('circle-outline');

      const tooltip = accountTooltip(consumer.snapshot, consumer.name);
      if (consumer.caveat) {
        tooltip.appendMarkdown(`\n\n_${consumer.caveat}_`);
      }
      child.tooltip = tooltip;
      child.contextValue = 'copyable';
      child.copyValue = consumer.snapshot.configDir;
      return child;
    });
    return item;
  }

  private projectsItem(state: WindowState): AccountItem | undefined {
    if (!config().get<boolean>('scanProjects', true)) {
      return undefined;
    }
    const root = projectsRoot(state.workspaceRoot);
    if (!root) {
      return undefined;
    }
    const audits = auditProjects(root);
    if (audits.length === 0) {
      return undefined;
    }

    const shared = audits.filter(a => a.sharesWith.length > 0);
    const item = new AccountItem('projects', 'Projects', vscode.TreeItemCollapsibleState.Collapsed);
    item.description =
      shared.length > 0
        ? `${audits.length} projects, ${shared.length} sharing a login`
        : `${audits.length} projects, each isolated`;
    item.iconPath =
      shared.length > 0 ? icon('warning', WARN) : icon('checklist');
    item.tooltip = new vscode.MarkdownString(
      `Projects under \`${tilde(root)}\` that declare their own \`${CONFIG_DIR_VAR}\`.\n\n` +
        'Accounts here are read from disk, not verified with the CLI — that would mean one subprocess per project.'
    );
    item.children = audits.map(audit => this.projectChild(audit, state.workspaceRoot));
    return item;
  }

  private projectChild(audit: ProjectAudit, currentRoot: string | undefined): AccountItem {
    const child = new AccountItem(`project:${audit.root}`, audit.name);
    const email = audit.snapshot.account?.email;
    child.description = `${email ?? 'not logged in'} · ${tilde(audit.snapshot.configDir)}`;

    const isCurrent = currentRoot !== undefined && path.resolve(currentRoot) === path.resolve(audit.root);
    child.iconPath =
      audit.sharesWith.length > 0
        ? icon('warning', WARN)
        : isCurrent
          ? icon('circle-filled', INFO)
          : icon('folder');

    const tooltip = accountTooltip(audit.snapshot, audit.name);
    if (audit.sharesWith.length > 0) {
      tooltip.appendMarkdown(
        `\n\n**Shares this store with:** ${audit.sharesWith.join(', ')} — these projects are one login, not separate ones.`
      );
    }
    if (isCurrent) {
      tooltip.appendMarkdown('\n\n_This is the current workspace._');
    }
    child.tooltip = tooltip;
    child.contextValue = 'copyable openable';
    child.copyValue = audit.snapshot.configDir;
    child.filePath = path.join(audit.root, '.vscode', 'settings.json');
    return child;
  }

  /**
   * Watch every file a snapshot depends on. Recreated only when the target set
   * actually changes, so an ordinary refresh does not tear down and rebuild
   * every watcher — which can drop events in the gap.
   */
  private restartWatchers(state?: WindowState): void {
    const folder = currentFolderPath();
    const source = state ?? this.state;

    const paths = new Set<string>();
    if (source) {
      for (const consumer of source.consumers) {
        for (const target of watchTargets(
          consumer.snapshot.configDir,
          isExplicitDir(consumer.snapshot.source)
        )) {
          paths.add(target);
        }
      }
    }
    if (folder) {
      paths.add(path.join(folder, '.vscode', 'settings.json'));
    }

    const signature = [...paths].sort().join('\n');
    if (signature === this.watched && this.watchers.length > 0) {
      return;
    }
    this.watched = signature;

    this.disposeWatchers();
    for (const target of paths) {
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(path.dirname(target)), path.basename(target))
        );
        this.watchers.push(
          watcher,
          watcher.onDidChange(() => this.scheduleLoad()),
          watcher.onDidCreate(() => this.scheduleLoad()),
          watcher.onDidDelete(() => this.scheduleLoad())
        );
      } catch {
        // A non-existent parent directory cannot be watched; the next load picks
        // it up once the directory appears.
      }
    }
  }

  restartPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const seconds = config().get<number>('refreshInterval', 0);
    if (seconds > 0) {
      // Clamped: a fractional value would otherwise spawn many CLI calls a second.
      this.timer = setInterval(() => void this.load(), Math.max(seconds, 5) * 1000);
    }
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
  }

  dispose(): void {
    this.disposeWatchers();
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this._onDidChangeTreeData.dispose();
    this._onDidLoad.dispose();
  }
}
