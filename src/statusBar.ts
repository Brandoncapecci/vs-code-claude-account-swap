import * as vscode from 'vscode';
import { WindowState, effectiveEmail, effectiveOrg, isVerified, storeLabel, windowVerdict, worstConsumer } from './accountReader';
import { accountTooltip, windowCopy } from './accountProvider';
import { config } from './settings';

/**
 * The always-on surface. Owns the status bar item, the view badge, and the
 * wrong-account notification, all driven from `AccountProvider.onDidLoad` so
 * they stay live whether or not the tree view is visible.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  /** Keyed so the same alert never repeats, but a genuinely new one still fires. */
  private lastAlertKey: string | undefined;

  constructor(private readonly treeView: vscode.TreeView<unknown>) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.item.name = 'Claude Account';
    this.item.command = 'claudeAccount.showDetails';
    this.showChecking();
  }

  /** Interim state, so the entry is never simply absent while the CLI runs. */
  showChecking(): void {
    if (!config().get<boolean>('statusBar', true)) {
      return;
    }
    this.item.text = '$(loading~spin) Claude account';
    this.item.tooltip = 'Checking with `claude auth status`…';
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  render(state: WindowState): void {
    const copy = windowCopy(state);
    const consumer = worstConsumer(state);
    const snapshot = consumer.snapshot;

    if (!config().get<boolean>('statusBar', true)) {
      this.item.hide();
    } else {
      this.item.text = `$(${copy.icon}) ${copy.statusText}`;
      this.item.backgroundColor =
        copy.background === 'error'
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : copy.background === 'warning'
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;

      const md = new vscode.MarkdownString(`**${copy.label}**\n\n${copy.detail}\n\n`);
      if (state.expectedAccount) {
        md.appendMarkdown(`- Expected: \`${state.expectedAccount}\`\n`);
      }
      md.appendMarkdown(accountTooltip(snapshot, consumer.name).value);
      md.appendMarkdown('\n\nClick for the full report.');
      this.item.tooltip = md;
      this.item.show();
    }

    const verdict = windowVerdict(state);
    this.treeView.badge =
      verdict === 'wrong' || verdict === 'api-key' || verdict === 'not-logged-in'
        ? { value: 1, tooltip: `Claude Account: ${copy.label}` }
        : undefined;

    void this.maybeAlert(state);
  }

  private async maybeAlert(state: WindowState): Promise<void> {
    const verdict = windowVerdict(state);
    if (verdict !== 'wrong' && verdict !== 'api-key') {
      return;
    }
    if (!config().get<boolean>('alertOnWrongAccount', true)) {
      return;
    }

    const consumer = worstConsumer(state);
    const email = effectiveEmail(consumer.snapshot);
    // Include the offender so terminal-wrong followed by sidebar-wrong is not
    // swallowed, and so a transient blip cannot re-arm the same alert.
    const key = `${verdict}|${consumer.kind}|${email}|${state.expectedAccount}`;
    if (key === this.lastAlertKey) {
      return;
    }
    this.lastAlertKey = key;

    const isSecondary = consumer.kind !== 'terminal';
    const message =
      verdict === 'api-key'
        ? `Claude Code is using an API key, so this project's pinned account (${state.expectedAccount}) is not in effect.`
        : isSecondary
          ? `The Claude Code ${consumer.name.toLowerCase()} resolves ${email}, but ${describeFolder(state)} expects ${state.expectedAccount}.`
          : `Claude Code is signed in as ${email}, but ${describeFolder(state)} expects ${state.expectedAccount}.`;

    // Re-logging in cannot fix a routing problem, and on a shared store it would
    // change the account for every other unconfigured project too.
    const actions = isSecondary
      ? ['Fix Sidebar Account', 'Show Details', "Don't Show Again"]
      : verdict === 'api-key'
      ? ['Show Details', "Don't Show Again"]
      : state.isolated
        ? ['Log In…', 'Show Details', "Don't Show Again"]
        : ['Use a Different Account Here', 'Show Details', "Don't Show Again"];

    const choice = isSecondary || verdict === 'api-key'
      ? await vscode.window.showWarningMessage(message, ...actions)
      : await vscode.window.showErrorMessage(message, ...actions);

    switch (choice) {
      case 'Log In…':
        await vscode.commands.executeCommand('claudeAccount.login');
        break;
      case 'Use a Different Account Here':
        await vscode.commands.executeCommand('claudeAccount.useAccountForThisProject');
        break;
      case 'Fix Sidebar Account':
        await vscode.commands.executeCommand('claudeAccount.fixSidebar');
        break;
      case 'Show Details':
        await vscode.commands.executeCommand('claudeAccount.showDetails');
        break;
      case "Don't Show Again":
        await config().update('alertOnWrongAccount', false, vscode.ConfigurationTarget.Global);
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}

function describeFolder(state: WindowState): string {
  return state.workspaceRoot ? `"${state.workspaceRoot.split('/').pop()}"` : 'this project';
}

/** Exported for the details report so both surfaces word freshness identically. */
export function freshnessLine(state: WindowState): string {
  const snapshot = worstConsumer(state).snapshot;
  const org = effectiveOrg(snapshot);
  return [
    isVerified(snapshot)
      ? 'Verified with a live `claude auth status` per store.'
      : 'Read from disk only — the CLI check did not succeed.',
    org ? `Organization: ${org}.` : undefined,
    `Store: ${storeLabel(snapshot)}.`,
  ]
    .filter(Boolean)
    .join(' ');
}
