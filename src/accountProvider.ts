import * as vscode from 'vscode';
import * as path from 'path';
import {
  AccountSnapshot,
  CONFIG_DIR_VAR,
  DEFAULT_CONFIG_DIR,
  ProjectAudit,
  ResolvedConsumer,
  Verdict,
  WindowState,
  auditProjects,
  effectiveEmail,
  effectiveOrg,
  expandHome,
  hasConsumerMismatch,
  isExplicitDir,
  isLoggedIn,
  isVerified,
  judge,
  primaryConsumer,
  readWindowState,
  resolveClaudePath,
  tilde,
  verifyWindowState,
  watchTargets,
  windowVerdict,
} from './accountReader';

export class AccountItem extends vscode.TreeItem {
  children?: AccountItem[];
  /** Value put on the clipboard by claudeAccount.copyValue. */
  copyValue?: string;
  /** File opened by claudeAccount.openFile. */
  filePath?: string;

  constructor(label: string, collapsed?: vscode.TreeItemCollapsibleState) {
    super(label, collapsed ?? vscode.TreeItemCollapsibleState.None);
  }
}

function icon(id: string, color?: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

export function config() {
  return vscode.workspace.getConfiguration('claudeAccount');
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function expectedAccount(): string | undefined {
  const value = config().get<string>('expectedAccount', '');
  return value && value.trim() ? value.trim() : undefined;
}

export function projectsRoot(workspace: string | undefined): string | undefined {
  const configured = config().get<string>('projectsRoot', '');
  if (configured && configured.trim()) {
    return expandHome(configured);
  }
  return workspace ? path.dirname(workspace) : undefined;
}

/** Read the window state and verify it against the live CLI. */
export async function loadWindowState(): Promise<WindowState> {
  const state = readWindowState(workspaceRoot(), expectedAccount());
  if (config().get<boolean>('verifyWithCli', true)) {
    await verifyWindowState(state, resolveClaudePath(config().get<string>('claudePath', '')));
  }
  return state;
}

// ---------------------------------------------------------------------------
// Verdict presentation — the part that must be unmissable
// ---------------------------------------------------------------------------

export interface VerdictStyle {
  label: string;
  themeIcon: string;
  color?: string;
  /** Status bar codicon. */
  badge: string;
  /** Status bar background, for the two states that need shouting about. */
  background?: 'error' | 'warning';
}

export function verdictStyle(verdict: Verdict): VerdictStyle {
  switch (verdict) {
    case 'correct':
      return { label: 'CORRECT ACCOUNT', themeIcon: 'pass-filled', color: 'charts.green', badge: '$(pass-filled)' };
    case 'wrong':
      return {
        label: 'WRONG ACCOUNT',
        themeIcon: 'error',
        color: 'charts.red',
        badge: '$(error)',
        background: 'error',
      };
    case 'not-logged-in':
      return {
        label: 'NOT LOGGED IN',
        themeIcon: 'circle-slash',
        color: 'charts.yellow',
        badge: '$(circle-slash)',
        background: 'warning',
      };
    case 'unverified':
      return { label: 'UNVERIFIED', themeIcon: 'question', color: 'charts.yellow', badge: '$(question)' };
    case 'no-expectation':
      return { label: 'No expected account set', themeIcon: 'info', badge: '$(account)' };
  }
}

function accountTooltip(snapshot: AccountSnapshot, heading: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${heading}**\n\n`);

  const email = effectiveEmail(snapshot);
  md.appendMarkdown(`- Account: \`${email ?? 'none'}\`\n`);
  const org = effectiveOrg(snapshot);
  if (org) {
    md.appendMarkdown(`- Organization: ${org}\n`);
  }
  if (snapshot.cli?.subscriptionType) {
    md.appendMarkdown(`- Plan: ${snapshot.cli.subscriptionType}\n`);
  }
  if (snapshot.cli?.authMethod) {
    md.appendMarkdown(`- Auth method: ${snapshot.cli.authMethod}\n`);
  }
  if (snapshot.cli?.apiKeySource) {
    md.appendMarkdown(
      `- **API key in use:** \`${snapshot.cli.apiKeySource}\` — this supersedes the OAuth login\n`
    );
  }
  md.appendMarkdown(
    `- \`${CONFIG_DIR_VAR}\`: \`${tilde(snapshot.configDir)}\` _(${snapshot.source})_\n`
  );

  if (isVerified(snapshot)) {
    md.appendMarkdown(`- Source: **live \`claude auth status\`** for this config dir\n`);
  } else {
    md.appendMarkdown(
      `- Source: on-disk ${snapshot.accountFile ? `\`${tilde(snapshot.accountFile)}\`` : '_no account file found_'} (CLI not consulted)\n`
    );
    if (snapshot.cliError) {
      md.appendMarkdown(`- CLI error: ${snapshot.cliError}\n`);
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

  /** Fires after each load so the status bar and alerts can react. */
  private _onDidLoad = new vscode.EventEmitter<WindowState>();
  readonly onDidLoad = this._onDidLoad.event;

  private watchers: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    this.rewatch();
  }

  refresh(): void {
    this.rewatch();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AccountItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AccountItem): Promise<AccountItem[]> {
    if (element) {
      return element.children ?? [];
    }
    // A new root render is a new read.
    const state = await loadWindowState();
    this._onDidLoad.fire(state);
    return this.buildRoot(state);
  }

  private buildRoot(state: WindowState): AccountItem[] {
    const items: AccountItem[] = [this.verdictItem(state)];
    const primary = primaryConsumer(state);

    items.push(this.accountItem(primary));
    items.push(this.configDirItem(primary.snapshot));

    const mismatch = this.mismatchItem(state);
    if (mismatch) {
      items.push(mismatch);
    }

    items.push(...this.apiKeyItems(state));

    const trap = this.defaultDirTrapItem(state);
    if (trap) {
      items.push(trap);
    }

    if (state.overrides.error) {
      const item = new AccountItem('Workspace settings unreadable');
      item.description = 'see tooltip';
      item.iconPath = icon('error', 'charts.red');
      item.tooltip = state.overrides.error;
      item.filePath = state.overrides.file ?? undefined;
      items.push(item);
    }

    items.push(this.consumersItem(state));

    const projects = this.projectsItem(state);
    if (projects) {
      items.push(projects);
    }

    return items;
  }

  /** The headline row: is this the account this project is supposed to use? */
  private verdictItem(state: WindowState): AccountItem {
    const verdict = windowVerdict(state);
    const style = verdictStyle(verdict);
    const snapshot = primaryConsumer(state).snapshot;
    const email = effectiveEmail(snapshot);

    const item = new AccountItem(style.label);
    item.iconPath = icon(style.themeIcon, style.color);

    const md = new vscode.MarkdownString();
    switch (verdict) {
      case 'correct':
        item.description = email;
        md.appendMarkdown(
          `\`${email}\` matches the expected account for this project (\`${state.expectedAccount}\`), confirmed by a live \`claude auth status\`.`
        );
        break;
      case 'wrong':
        item.description = `${email} — expected ${state.expectedAccount}`;
        md.appendMarkdown(
          `**This project expects \`${state.expectedAccount}\` but Claude Code is signed in as \`${email}\`.**\n\n` +
            `Run **Claude Account: Log In For This Config Dir** and sign in with the right account, or update \`claudeAccount.expectedAccount\` if the expectation is wrong.`
        );
        break;
      case 'not-logged-in':
        item.description = tilde(snapshot.configDir);
        md.appendMarkdown(
          `No account is logged in for \`${tilde(snapshot.configDir)}\`.\n\n` +
            `Run **Claude Account: Log In For This Config Dir** to sign in.`
        );
        break;
      case 'unverified':
        item.description = email;
        md.appendMarkdown(
          `\`${email}\` was read from disk, but the live CLI check did not run, so this is not confirmed.\n\n` +
            (snapshot.cliError ? `CLI error: ${snapshot.cliError}` : 'Enable `claudeAccount.verifyWithCli`.')
        );
        break;
      case 'no-expectation':
        item.description = email ?? 'not logged in';
        md.appendMarkdown(
          `Signed in as \`${email}\`. No expected account is set for this project, so there is nothing to check it against.\n\n` +
            `Run **Claude Account: Set Expected Account For This Project** to pin the account this project should use.`
        );
        item.command = { command: 'claudeAccount.setExpectedAccount', title: 'Set Expected Account' };
        break;
    }
    item.tooltip = md;
    return item;
  }

  private accountItem(consumer: ResolvedConsumer): AccountItem {
    const { snapshot } = consumer;
    const email = effectiveEmail(snapshot);
    const item = new AccountItem(email ?? 'Not logged in');

    const bits = [effectiveOrg(snapshot), snapshot.cli?.subscriptionType].filter(Boolean);
    item.description =
      bits.length > 0 ? bits.join(' · ') : isLoggedIn(snapshot) ? undefined : 'use the Log In command';

    item.iconPath = snapshot.error
      ? icon('error', 'charts.red')
      : isVerified(snapshot)
        ? isLoggedIn(snapshot)
          ? icon('verified-filled', 'charts.green')
          : icon('circle-slash', 'charts.yellow')
        : icon('question', 'charts.yellow');

    item.tooltip = accountTooltip(snapshot, `Account for ${consumer.name.toLowerCase()}`);
    item.contextValue = 'copyable';
    item.copyValue = email ?? '';
    item.command = { command: 'claudeAccount.showDetails', title: 'Show Details' };
    return item;
  }

  private configDirItem(snapshot: AccountSnapshot): AccountItem {
    const item = new AccountItem(tilde(snapshot.configDir));
    item.description = snapshot.source;
    item.iconPath = icon('folder-library');
    item.tooltip = new vscode.MarkdownString(
      `\`${CONFIG_DIR_VAR}\` in effect for the integrated terminal.\n\n` +
        `On macOS, credentials are stored in the Keychain keyed by this path, so a distinct dir is a fully distinct login.`
    );
    item.contextValue = 'copyable';
    item.copyValue = snapshot.configDir;
    return item;
  }

  private mismatchItem(state: WindowState): AccountItem | undefined {
    if (!hasConsumerMismatch(state)) {
      return undefined;
    }
    const item = new AccountItem('Terminal and sidebar disagree');
    item.description = 'expand "Who uses what"';
    item.iconPath = icon('warning', 'charts.yellow');
    item.tooltip = new vscode.MarkdownString(
      'The integrated terminal and the Claude Code sidebar resolve different config dirs, so they can be signed in as different accounts in this same window. Expand **Who uses what** for the breakdown.'
    );
    return item;
  }

  /**
   * Pointing CLAUDE_CONFIG_DIR at `~/.claude` looks like "use the default
   * account" but is a separate, usually empty, credential store. Worth calling
   * out, because the symptom is a mysteriously logged-out project.
   */
  private defaultDirTrapItem(state: WindowState): AccountItem | undefined {
    const offender = state.consumers.find(
      consumer =>
        !consumer.diagnosticOnly &&
        isExplicitDir(consumer.snapshot.source) &&
        path.resolve(consumer.snapshot.configDir) === DEFAULT_CONFIG_DIR
    );
    if (!offender) {
      return undefined;
    }

    const item = new AccountItem(`${CONFIG_DIR_VAR} is set to the default dir`);
    item.description = 'not the same as leaving it unset';
    item.iconPath = icon('warning', 'charts.yellow');
    item.tooltip = new vscode.MarkdownString(
      `\`${CONFIG_DIR_VAR}\` is explicitly set to \`${tilde(DEFAULT_CONFIG_DIR)}\`.\n\n` +
        `That is **not** equivalent to leaving it unset: an explicit value selects a separate credential store at ` +
        `\`${tilde(path.join(DEFAULT_CONFIG_DIR, '.claude.json'))}\`, while unset uses the legacy ` +
        `\`~/.claude.json\`. A project set up this way will appear logged out even though your default account works.\n\n` +
        `Either remove the override, or point it at a dedicated dir such as \`~/.claude-work\` and log in there.`
    );
    return item;
  }

  private apiKeyItems(state: WindowState): AccountItem[] {
    const items: AccountItem[] = [];

    // The CLI telling us a key is in use is stronger evidence than us finding
    // the variable somewhere, so lead with it.
    const source = primaryConsumer(state).snapshot.cli?.apiKeySource;
    if (source) {
      const item = new AccountItem(`API key in use: ${source}`);
      item.description = 'supersedes the login';
      item.iconPath = icon('warning', 'charts.yellow');
      item.tooltip = new vscode.MarkdownString(
        `\`claude auth status\` reports it is using an API key from \`${source}\`. Requests are billed to that key, not to the account shown above.`
      );
      items.push(item);
    }

    for (const name of state.processApiKeyVars) {
      const item = new AccountItem(`${name} is set`);
      item.description = "this window's environment";
      item.iconPath = icon('warning', 'charts.yellow');
      item.tooltip = new vscode.MarkdownString(
        `\`${name}\` is present in this window's environment. Claude Code prefers it over any logged-in account.`
      );
      items.push(item);
    }

    for (const entry of state.settingsApiKeys) {
      const item = new AccountItem(`${entry.variable} in settings`);
      item.description = tilde(entry.file);
      item.iconPath = icon('warning', 'charts.yellow');
      item.tooltip = new vscode.MarkdownString(
        `\`${entry.variable}\` is declared in \`${tilde(entry.file)}\`. An API key takes precedence over a logged-in account.`
      );
      item.filePath = entry.file;
      item.command = { command: 'claudeAccount.openFile', title: 'Open', arguments: [item] };
      items.push(item);
    }

    return items;
  }

  private consumersItem(state: WindowState): AccountItem {
    const item = new AccountItem('Who uses what', vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = icon('list-tree');
    item.children = state.consumers.map(consumer => {
      const child = new AccountItem(consumer.name);
      const email = effectiveEmail(consumer.snapshot);
      child.description = `${email ?? 'not logged in'} · ${tilde(consumer.snapshot.configDir)}`;
      child.iconPath = consumer.diagnosticOnly
        ? icon('info')
        : consumer.machineScoped
          ? icon('warning', 'charts.yellow')
          : email
            ? icon('pass', 'charts.green')
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
    const item = new AccountItem('Projects with a config dir', vscode.TreeItemCollapsibleState.Collapsed);
    item.description =
      shared.length > 0 ? `${audits.length} · ${shared.length} not isolated` : `${audits.length} · isolated`;
    item.iconPath = shared.length > 0 ? icon('warning', 'charts.yellow') : icon('checklist');
    item.tooltip = new vscode.MarkdownString(
      `Scanned \`${tilde(root)}\` for projects declaring \`${CONFIG_DIR_VAR}\` in \`.vscode/settings.json\`.\n\n` +
        `Accounts here are read from disk, not verified with the CLI — that would mean one subprocess per project.`
    );
    item.children = audits.map(audit => this.projectChild(audit, state.workspaceRoot));
    return item;
  }

  private projectChild(audit: ProjectAudit, currentRoot: string | undefined): AccountItem {
    const child = new AccountItem(audit.name);
    const email = audit.snapshot.account?.email;
    child.description = `${email ?? 'not logged in'} · ${tilde(audit.snapshot.configDir)}`;

    const isCurrent = currentRoot !== undefined && path.resolve(currentRoot) === path.resolve(audit.root);
    child.iconPath =
      audit.sharesWith.length > 0
        ? icon('warning', 'charts.yellow')
        : isCurrent
          ? icon('circle-filled', 'charts.blue')
          : icon('folder');

    const tooltip = accountTooltip(audit.snapshot, audit.name);
    if (audit.sharesWith.length > 0) {
      tooltip.appendMarkdown(
        `\n\n**Shares this config dir with:** ${audit.sharesWith.join(', ')} — these projects are one login, not separate ones.`
      );
    }
    if (isCurrent) {
      tooltip.appendMarkdown('\n\n_This is the current workspace._');
    }
    child.tooltip = tooltip;
    child.contextValue = 'copyable';
    child.copyValue = audit.snapshot.configDir;
    child.filePath = path.join(audit.root, '.vscode', 'settings.json');
    return child;
  }

  /**
   * Watch every file a snapshot depends on. Re-created on each refresh because
   * the set of watched paths changes when the config dir changes.
   */
  private rewatch(): void {
    this.disposeWatchers();

    const state = readWindowState(workspaceRoot(), expectedAccount());
    const paths = new Set<string>();
    for (const consumer of state.consumers) {
      for (const target of watchTargets(consumer.snapshot.configDir)) {
        paths.add(target);
      }
    }
    if (state.workspaceRoot) {
      paths.add(path.join(state.workspaceRoot, '.vscode', 'settings.json'));
    }

    for (const target of paths) {
      try {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(vscode.Uri.file(path.dirname(target)), path.basename(target))
        );
        watcher.onDidChange(() => this._onDidChangeTreeData.fire());
        watcher.onDidCreate(() => this.refresh());
        watcher.onDidDelete(() => this.refresh());
        this.watchers.push(watcher);
      } catch {
        // A non-existent parent directory cannot be watched; refresh() picks it
        // up once the dir appears.
      }
    }

    const seconds = config().get<number>('refreshInterval', 0);
    if (seconds && seconds > 0) {
      this.timer = setInterval(() => this._onDidChangeTreeData.fire(), seconds * 1000);
    }
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.disposeWatchers();
    this._onDidChangeTreeData.dispose();
    this._onDidLoad.dispose();
  }
}

/** Exported for the details report. */
export { judge };
