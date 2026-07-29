import * as vscode from 'vscode';
import * as path from 'path';
import {
  AccountSnapshot,
  ProjectAudit,
  ResolvedConsumer,
  WindowState,
  auditProjects,
  expandHome,
  hasConsumerMismatch,
  readWindowState,
  tilde,
  watchTargets,
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

function accountLabel(snapshot: AccountSnapshot): string {
  if (snapshot.error) {
    return 'Unreadable config';
  }
  return snapshot.account?.email ?? 'Not logged in';
}

function accountTooltip(snapshot: AccountSnapshot, heading: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${heading}**\n\n`);
  md.appendMarkdown(`- Account: \`${snapshot.account?.email ?? 'none'}\`\n`);
  if (snapshot.account?.organizationName) {
    md.appendMarkdown(`- Organization: ${snapshot.account.organizationName}\n`);
  }
  if (snapshot.account?.organizationRole) {
    md.appendMarkdown(`- Role: ${snapshot.account.organizationRole}\n`);
  }
  md.appendMarkdown(`- \`CLAUDE_CONFIG_DIR\`: \`${tilde(snapshot.configDir)}\` _(${snapshot.source})_\n`);
  md.appendMarkdown(`- Read from: ${snapshot.accountFile ? `\`${tilde(snapshot.accountFile)}\`` : '_no account file found_'}\n`);
  md.appendMarkdown(
    `- Credentials file: ${snapshot.credentialsFile ? `\`${tilde(snapshot.credentialsFile)}\`` : '_none on disk (macOS keeps them in the Keychain)_'}\n`
  );
  if (snapshot.error) {
    md.appendMarkdown(`- **Error:** ${snapshot.error}\n`);
  }
  md.appendMarkdown(`\nRead at ${snapshot.readAt.toLocaleTimeString()} — always straight from disk, never cached.`);
  return md;
}

export class AccountProvider implements vscode.TreeDataProvider<AccountItem>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<AccountItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private watchers: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private state: WindowState | undefined;

  constructor() {
    this.rewatch();
  }

  refresh(): void {
    this.state = undefined;
    this.rewatch();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: AccountItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AccountItem): AccountItem[] {
    if (element) {
      return element.children ?? [];
    }
    // A new root render is a new read.
    this.state = readWindowState(workspaceRoot());
    return this.buildRoot(this.state);
  }

  private buildRoot(state: WindowState): AccountItem[] {
    const items: AccountItem[] = [];
    const primary = state.consumers[0];

    items.push(this.currentAccountItem(primary));
    items.push(this.configDirItem(primary.snapshot));

    const mismatch = this.mismatchItem(state);
    if (mismatch) {
      items.push(mismatch);
    }

    for (const apiKeyVar of state.processApiKeyVars) {
      const item = new AccountItem(`${apiKeyVar} is set`);
      item.description = 'overrides the login above';
      item.iconPath = icon('warning', 'charts.yellow');
      item.tooltip = new vscode.MarkdownString(
        `\`${apiKeyVar}\` is present in this window's environment. Claude Code uses it instead of any logged-in account, so the account shown above will not be the one billed.`
      );
      items.push(item);
    }

    for (const entry of state.settingsApiKeys) {
      const item = new AccountItem(`${entry.variable} in settings`);
      item.description = tilde(entry.file);
      item.iconPath = icon('warning', 'charts.yellow');
      item.tooltip = new vscode.MarkdownString(
        `\`${entry.variable}\` is declared in \`${tilde(entry.file)}\`. An API key takes precedence over a logged-in account, so requests will not use the account shown above.`
      );
      item.filePath = entry.file;
      item.command = { command: 'claudeAccount.openFile', title: 'Open', arguments: [item] };
      items.push(item);
    }

    if (state.overrides.error) {
      const item = new AccountItem('Workspace settings unreadable');
      item.description = 'see tooltip';
      item.iconPath = icon('error', 'charts.red');
      item.tooltip = state.overrides.error;
      items.push(item);
    }

    items.push(this.consumersItem(state));

    const projects = this.projectsItem(state);
    if (projects) {
      items.push(projects);
    }

    return items;
  }

  private currentAccountItem(consumer: ResolvedConsumer): AccountItem {
    const { snapshot } = consumer;
    const item = new AccountItem(accountLabel(snapshot));
    item.description = snapshot.account?.organizationName ?? (snapshot.loggedIn ? undefined : 'run /login');
    item.iconPath = snapshot.error
      ? icon('error', 'charts.red')
      : snapshot.loggedIn
        ? icon('verified-filled', 'charts.green')
        : icon('circle-slash', 'charts.yellow');
    item.tooltip = accountTooltip(snapshot, `Account for ${consumer.name.toLowerCase()}`);
    item.contextValue = 'copyable';
    item.copyValue = snapshot.account?.email ?? '';
    if (snapshot.accountFile) {
      item.filePath = snapshot.accountFile;
      item.command = {
        command: 'claudeAccount.showDetails',
        title: 'Show Details',
      };
    }
    return item;
  }

  private configDirItem(snapshot: AccountSnapshot): AccountItem {
    const item = new AccountItem(tilde(snapshot.configDir));
    item.description = snapshot.source;
    item.iconPath = icon('folder-library');
    item.tooltip = new vscode.MarkdownString(
      `\`CLAUDE_CONFIG_DIR\` in effect for the integrated terminal.\n\n` +
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
      'The integrated terminal and the Claude Code sidebar would resolve different config dirs, so they can be signed in as different accounts in this same window. Expand **Who uses what** for the breakdown.'
    );
    return item;
  }

  private consumersItem(state: WindowState): AccountItem {
    const item = new AccountItem('Who uses what', vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = icon('list-tree');
    item.children = state.consumers.map(consumer => {
      const child = new AccountItem(consumer.name);
      const email = consumer.snapshot.account?.email;
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
    const config = vscode.workspace.getConfiguration('claudeAccount');
    if (!config.get<boolean>('scanProjects', true)) {
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
    const item = new AccountItem(
      'Projects with a config dir',
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.description = shared.length > 0 ? `${audits.length} · ${shared.length} not isolated` : `${audits.length} · isolated`;
    item.iconPath = shared.length > 0 ? icon('warning', 'charts.yellow') : icon('checklist');
    item.tooltip = new vscode.MarkdownString(
      `Scanned \`${tilde(root)}\` for projects declaring \`CLAUDE_CONFIG_DIR\` in \`.vscode/settings.json\`.`
    );
    item.children = audits.map(audit => this.projectChild(audit, state.workspaceRoot));
    return item;
  }

  private projectChild(audit: ProjectAudit, workspaceRoot: string | undefined): AccountItem {
    const child = new AccountItem(audit.name);
    const email = audit.snapshot?.account?.email;
    const dir = audit.snapshot ? tilde(audit.snapshot.configDir) : audit.declaredConfigDir ?? '';
    child.description = `${email ?? 'not logged in'} · ${dir}`;

    const isCurrent = workspaceRoot !== undefined && path.resolve(workspaceRoot) === path.resolve(audit.root);
    child.iconPath = audit.sharesWith.length > 0
      ? icon('warning', 'charts.yellow')
      : isCurrent
        ? icon('circle-filled', 'charts.blue')
        : icon('folder');

    const tooltip = audit.snapshot
      ? accountTooltip(audit.snapshot, audit.name)
      : new vscode.MarkdownString(`**${audit.name}**`);
    if (audit.sharesWith.length > 0) {
      tooltip.appendMarkdown(
        `\n\n**Shares this config dir with:** ${audit.sharesWith.join(', ')} — these projects are the same login, not separate ones.`
      );
    }
    if (isCurrent) {
      tooltip.appendMarkdown('\n\n_This is the current workspace._');
    }
    child.tooltip = tooltip;
    child.contextValue = 'copyable';
    child.copyValue = audit.snapshot?.configDir ?? audit.declaredConfigDir ?? '';
    child.filePath = path.join(audit.root, '.vscode', 'settings.json');
    return child;
  }

  /**
   * Watch every file a snapshot depends on. Re-created on each refresh because
   * the set of watched paths changes when the config dir changes.
   */
  private rewatch(): void {
    this.disposeWatchers();

    const state = readWindowState(workspaceRoot());
    this.state = state;

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

    const seconds = vscode.workspace.getConfiguration('claudeAccount').get<number>('refreshInterval', 0);
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
  }
}

export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function projectsRoot(workspace: string | undefined): string | undefined {
  const configured = vscode.workspace.getConfiguration('claudeAccount').get<string>('projectsRoot', '');
  if (configured && configured.trim()) {
    return expandHome(configured);
  }
  return workspace ? path.dirname(workspace) : undefined;
}
