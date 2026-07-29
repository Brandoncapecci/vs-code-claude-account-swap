import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { AccountItem, AccountProvider, workspaceRoot } from './accountProvider';
import {
  WindowState,
  hasConsumerMismatch,
  primaryConsumer,
  readWindowState,
  tilde,
} from './accountReader';

const TERMINAL_NAME = 'Claude Login';

function shortEmail(email: string): string {
  const [local, domain] = email.split('@');
  return domain ? `${local}@${domain.split('.')[0]}` : email;
}

function statusText(state: WindowState): string {
  const snapshot = primaryConsumer(state).snapshot;
  const email = snapshot.account?.email;
  const mismatched =
    hasConsumerMismatch(state) ||
    state.processApiKeyVars.length > 0 ||
    state.settingsApiKeys.length > 0;

  const icon = !email ? '$(circle-slash)' : mismatched ? '$(warning)' : '$(verified-filled)';
  return `${icon} ${email ? shortEmail(email) : 'no Claude login'}`;
}

function detailsMarkdown(state: WindowState): string {
  const lines: string[] = ['# Claude Account', ''];
  lines.push(`Read at ${new Date().toLocaleTimeString()} — every value below came off disk just now.`, '');

  if (state.workspaceRoot) {
    lines.push(`**Workspace:** \`${tilde(state.workspaceRoot)}\``, '');
  }

  lines.push('| Consumer | Account | CLAUDE_CONFIG_DIR | Source |', '| --- | --- | --- | --- |');
  for (const consumer of state.consumers) {
    const { snapshot } = consumer;
    lines.push(
      `| ${consumer.name} | ${snapshot.account?.email ?? '_not logged in_'} | \`${tilde(snapshot.configDir)}\` | ${snapshot.source} |`
    );
  }
  lines.push('');

  const snapshot = primaryConsumer(state).snapshot;
  if (snapshot.account) {
    lines.push('## Account details', '');
    for (const [key, value] of Object.entries(snapshot.account)) {
      if (value) {
        lines.push(`- **${key}:** ${value}`);
      }
    }
    lines.push('');
  }

  lines.push('## Sources', '');
  lines.push(`- Account file: ${snapshot.accountFile ? `\`${tilde(snapshot.accountFile)}\`` : '_none found_'}`);
  lines.push(
    `- Credentials file: ${snapshot.credentialsFile ? `\`${tilde(snapshot.credentialsFile)}\`` : '_none on disk — macOS keeps them in the Keychain, keyed by config dir_'}`
  );
  lines.push(
    `- Workspace settings: ${state.overrides.file ? `\`${tilde(state.overrides.file)}\`` : '_none_'}`
  );
  lines.push('');

  if (state.processApiKeyVars.length > 0 || state.settingsApiKeys.length > 0) {
    lines.push('## API key overrides', '');
    for (const name of state.processApiKeyVars) {
      lines.push(`- \`${name}\` is set in this window's environment and overrides the login above.`);
    }
    for (const entry of state.settingsApiKeys) {
      lines.push(`- \`${entry.variable}\` is declared in \`${tilde(entry.file)}\` and overrides the login above.`);
    }
    lines.push('');
  }

  if (hasConsumerMismatch(state)) {
    lines.push(
      '## Config dir mismatch',
      '',
      'The terminal and the sidebar resolve different config dirs in this window, so they may be signed in as different accounts.',
      ''
    );
  }

  lines.push(
    '---',
    '',
    'If the Claude Code sidebar shows something different from this, the sidebar is showing cached login info from when the window started. Reload the window to refresh its display; `/status` reflects the live credentials.'
  );

  return lines.join('\n');
}

/**
 * Best-effort Keychain probe. Only checks for item existence — never reads a
 * secret, so it does not prompt for Keychain access.
 */
function probeKeychain(configDir: string): Promise<string[]> {
  const base = 'Claude Code-credentials';
  const name = path.basename(configDir);
  const candidates = [base, `${base}-${name}`, `${base}-${configDir}`, `${base} (${configDir})`];

  return Promise.all(
    candidates.map(
      service =>
        new Promise<string>(resolve => {
          execFile('security', ['find-generic-password', '-s', service], err => {
            resolve(`${err ? 'absent ' : 'present'}  ${service}`);
          });
        })
    )
  );
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new AccountProvider();
  const output = vscode.window.createOutputChannel('Claude Account');

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  statusBarItem.command = 'claudeAccount.showDetails';

  function updateStatusBar() {
    if (!vscode.workspace.getConfiguration('claudeAccount').get<boolean>('statusBar', true)) {
      statusBarItem.hide();
      return;
    }
    const state = readWindowState(workspaceRoot());
    const snapshot = primaryConsumer(state).snapshot;
    statusBarItem.text = statusText(state);
    statusBarItem.tooltip = new vscode.MarkdownString(
      `**Claude Code account** (live, uncached)\n\n` +
        `- ${snapshot.account?.email ?? '_not logged in_'}\n` +
        `- \`CLAUDE_CONFIG_DIR\`: \`${tilde(snapshot.configDir)}\` _(${snapshot.source})_\n\n` +
        `Click for details.`
    );
    statusBarItem.show();
  }

  provider.onDidChangeTreeData(() => updateStatusBar());
  updateStatusBar();

  context.subscriptions.push(
    vscode.window.createTreeView('claudeAccountView', {
      treeDataProvider: provider,
      showCollapseAll: false,
    }),
    provider,
    statusBarItem,
    output,

    // Window focus is the moment a stale reading matters most: the user just
    // came back from logging in somewhere else.
    vscode.window.onDidChangeWindowState(windowState => {
      if (windowState.focused) {
        provider.refresh();
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('claudeAccount')) {
        provider.refresh();
      }
    }),

    vscode.commands.registerCommand('claudeAccount.refresh', () => {
      provider.refresh();
    }),

    vscode.commands.registerCommand('claudeAccount.showDetails', async () => {
      const state = readWindowState(workspaceRoot());
      const document = await vscode.workspace.openTextDocument({
        content: detailsMarkdown(state),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),

    vscode.commands.registerCommand('claudeAccount.copyValue', async (item: AccountItem) => {
      const value = item?.copyValue;
      if (!value) {
        return;
      }
      await vscode.env.clipboard.writeText(value);
      vscode.window.setStatusBarMessage(`Copied ${value}`, 2000);
    }),

    vscode.commands.registerCommand('claudeAccount.openFile', async (item: AccountItem) => {
      if (item?.filePath) {
        await vscode.window.showTextDocument(vscode.Uri.file(item.filePath));
      }
    }),

    vscode.commands.registerCommand('claudeAccount.login', async () => {
      const state = readWindowState(workspaceRoot());
      const seen = new Set<string>();
      const choices = state.consumers
        .filter(consumer => {
          if (seen.has(consumer.snapshot.configDir)) {
            return false;
          }
          seen.add(consumer.snapshot.configDir);
          return true;
        })
        .map(consumer => ({
          label: tilde(consumer.snapshot.configDir),
          description: consumer.snapshot.account?.email ?? 'not logged in',
          detail: `Used by: ${consumer.name}`,
          dir: consumer.snapshot.configDir,
        }));

      const picked = await vscode.window.showQuickPick(choices, {
        placeHolder: 'Config dir to log in for',
      });
      if (!picked) {
        return;
      }

      const terminal =
        vscode.window.terminals.find(t => t.name === TERMINAL_NAME) ??
        vscode.window.createTerminal({
          name: TERMINAL_NAME,
          env: { CLAUDE_CONFIG_DIR: picked.dir },
        });
      terminal.show();
      terminal.sendText('claude');
      vscode.window.showInformationMessage(
        `Started Claude Code with CLAUDE_CONFIG_DIR=${tilde(picked.dir)}. Run /login and pick the matching account.`
      );
    }),

    vscode.commands.registerCommand('claudeAccount.probeKeychain', async () => {
      if (process.platform !== 'darwin') {
        vscode.window.showInformationMessage('Keychain probing is macOS-only.');
        return;
      }
      const state = readWindowState(workspaceRoot());
      const snapshot = primaryConsumer(state).snapshot;

      output.clear();
      output.show(true);
      output.appendLine(`Keychain probe for CLAUDE_CONFIG_DIR=${tilde(snapshot.configDir)}`);
      output.appendLine(`Login user: ${os.userInfo().username}`);
      output.appendLine('');
      output.appendLine('Checking candidate service names (existence only, no secrets read):');
      for (const line of await probeKeychain(snapshot.configDir)) {
        output.appendLine(`  ${line}`);
      }
      output.appendLine('');
      output.appendLine(
        'Claude Code does not document its Keychain service naming for custom config dirs, so an "absent" row is not proof of a missing login. ' +
          'The account shown in the sidebar is read from .claude.json, which is the reliable on-disk signal.'
      );
    })
  );
}

export function deactivate() {}
