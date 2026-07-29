import * as vscode from 'vscode';
import {
  AccountItem,
  AccountProvider,
  config,
  expectedAccount,
  loadWindowState,
  verdictStyle,
} from './accountProvider';
import {
  CONFIG_DIR_VAR,
  Verdict,
  WindowState,
  effectiveEmail,
  effectiveOrg,
  hasConsumerMismatch,
  isVerified,
  primaryConsumer,
  tilde,
  windowVerdict,
} from './accountReader';

const TERMINAL_NAME = 'Claude Login';

function statusText(state: WindowState): string {
  const verdict = windowVerdict(state);
  const style = verdictStyle(verdict);
  const email = effectiveEmail(primaryConsumer(state).snapshot);

  // The email is the thing the user is checking, so never abbreviate it.
  switch (verdict) {
    case 'wrong':
      return `${style.badge} WRONG: ${email}`;
    case 'not-logged-in':
      return `${style.badge} No Claude login`;
    case 'unverified':
      return `${style.badge} ${email} (unverified)`;
    default:
      return `${style.badge} ${email}`;
  }
}

function detailsMarkdown(state: WindowState): string {
  const verdict = windowVerdict(state);
  const style = verdictStyle(verdict);
  const snapshot = primaryConsumer(state).snapshot;

  const lines: string[] = ['# Claude Account', ''];
  lines.push(`## ${style.label}`, '');

  if (verdict === 'wrong') {
    lines.push(
      `This project expects \`${state.expectedAccount}\`, but Claude Code is signed in as **\`${effectiveEmail(snapshot)}\`**.`,
      ''
    );
  } else if (verdict === 'correct') {
    lines.push(
      `\`${effectiveEmail(snapshot)}\` matches the expected account for this project, confirmed live.`,
      ''
    );
  } else if (verdict === 'no-expectation') {
    lines.push(
      `Signed in as \`${effectiveEmail(snapshot)}\`. No expected account is set for this project — run **Claude Account: Set Expected Account For This Project** to pin it.`,
      ''
    );
  }

  lines.push(
    `Read at ${new Date().toLocaleTimeString()}. ${
      isVerified(snapshot)
        ? 'Verified with a live `claude auth status` per config dir.'
        : 'Read from disk only — the CLI check did not run.'
    }`,
    ''
  );

  if (state.workspaceRoot) {
    lines.push(`**Workspace:** \`${tilde(state.workspaceRoot)}\``, '');
  }

  lines.push('## Who uses what', '');
  lines.push('| Consumer | Account | Plan | CLAUDE_CONFIG_DIR | Source |', '| --- | --- | --- | --- | --- |');
  for (const consumer of state.consumers) {
    const s = consumer.snapshot;
    lines.push(
      `| ${consumer.name} | ${effectiveEmail(s) ?? '_not logged in_'} | ${s.cli?.subscriptionType ?? '—'} | \`${tilde(s.configDir)}\` | ${s.source} |`
    );
  }
  lines.push('');

  if (snapshot.cli) {
    lines.push('## Live CLI answer', '', '```json', JSON.stringify(snapshot.cli, null, 2), '```', '');
  }
  if (snapshot.cliError) {
    lines.push('## CLI error', '', snapshot.cliError, '');
  }

  lines.push('## Sources', '');
  lines.push(`- Account file: ${snapshot.accountFile ? `\`${tilde(snapshot.accountFile)}\`` : '_none found_'}`);
  lines.push(
    `- Credentials file: ${snapshot.credentialsFile ? `\`${tilde(snapshot.credentialsFile)}\`` : '_none on disk — macOS keeps them in the Keychain, keyed by config dir_'}`
  );
  lines.push(`- Workspace settings: ${state.overrides.file ? `\`${tilde(state.overrides.file)}\`` : '_none_'}`);
  lines.push('');

  const keyNotes: string[] = [];
  if (snapshot.cli?.apiKeySource) {
    keyNotes.push(`\`claude auth status\` reports an API key from \`${snapshot.cli.apiKeySource}\` is in use.`);
  }
  for (const name of state.processApiKeyVars) {
    keyNotes.push(`\`${name}\` is set in this window's environment.`);
  }
  for (const entry of state.settingsApiKeys) {
    keyNotes.push(`\`${entry.variable}\` is declared in \`${tilde(entry.file)}\`.`);
  }
  if (keyNotes.length > 0) {
    lines.push('## API key overrides', '');
    lines.push(...keyNotes.map(note => `- ${note}`));
    lines.push('', 'An API key takes precedence over a logged-in account.', '');
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
    'If the Claude Code sidebar disagrees with this, the sidebar is showing cached login info from when the window started. Reload the window to refresh its display.'
  );

  return lines.join('\n');
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new AccountProvider();
  const treeView = vscode.window.createTreeView('claudeAccountView', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  statusBarItem.command = 'claudeAccount.showDetails';

  /** Only alert when the verdict actually changes, so it never nags. */
  let lastAlerted: Verdict | undefined;

  function render(state: WindowState) {
    const verdict = windowVerdict(state);
    const style = verdictStyle(verdict);
    const snapshot = primaryConsumer(state).snapshot;

    if (config().get<boolean>('statusBar', true)) {
      statusBarItem.text = statusText(state);
      statusBarItem.backgroundColor =
        style.background === 'error'
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : style.background === 'warning'
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;

      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${style.label}**\n\n`);
      md.appendMarkdown(`- Account: \`${effectiveEmail(snapshot) ?? 'none'}\`\n`);
      if (effectiveOrg(snapshot)) {
        md.appendMarkdown(`- Organization: ${effectiveOrg(snapshot)}\n`);
      }
      if (state.expectedAccount) {
        md.appendMarkdown(`- Expected: \`${state.expectedAccount}\`\n`);
      }
      md.appendMarkdown(`- \`${CONFIG_DIR_VAR}\`: \`${tilde(snapshot.configDir)}\` _(${snapshot.source})_\n`);
      md.appendMarkdown(
        `- ${isVerified(snapshot) ? 'Verified live with `claude auth status`' : 'From disk — CLI check did not run'}\n`
      );
      md.appendMarkdown('\nClick for the full report.');
      statusBarItem.tooltip = md;
      statusBarItem.show();
    } else {
      statusBarItem.hide();
    }

    // Badge the view container too, so a wrong account is visible even when the
    // status bar is off or the tree is scrolled away.
    treeView.badge =
      verdict === 'wrong' || verdict === 'not-logged-in'
        ? { value: 1, tooltip: `Claude Account: ${style.label}` }
        : undefined;

    if (verdict === 'wrong' && lastAlerted !== 'wrong' && config().get<boolean>('alertOnWrongAccount', true)) {
      lastAlerted = verdict;
      void vscode.window
        .showErrorMessage(
          `Claude Code is signed in as ${effectiveEmail(snapshot)}, but this project expects ${state.expectedAccount}.`,
          'Log In With Correct Account',
          'Show Details'
        )
        .then(choice => {
          if (choice === 'Log In With Correct Account') {
            void vscode.commands.executeCommand('claudeAccount.login');
          } else if (choice === 'Show Details') {
            void vscode.commands.executeCommand('claudeAccount.showDetails');
          }
        });
    }
    if (verdict !== 'wrong') {
      lastAlerted = verdict;
    }
  }

  context.subscriptions.push(
    treeView,
    provider,
    statusBarItem,
    provider.onDidLoad(render),

    // Window focus is when a stale reading matters most: the user just came back
    // from logging in somewhere else.
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
      const state = await loadWindowState();
      const document = await vscode.workspace.openTextDocument({
        content: detailsMarkdown(state),
        language: 'markdown',
      });
      await vscode.window.showTextDocument(document, { preview: true });
    }),

    vscode.commands.registerCommand('claudeAccount.setExpectedAccount', async () => {
      const state = await loadWindowState();
      const current = effectiveEmail(primaryConsumer(state).snapshot);
      const value = await vscode.window.showInputBox({
        title: 'Expected Claude account for this project',
        prompt: 'Exact email, or a wildcard like *@work.com. Leave empty to clear.',
        value: expectedAccount() ?? current ?? '',
        placeHolder: 'you@example.com',
      });
      if (value === undefined) {
        return;
      }

      const target = vscode.workspace.workspaceFolders
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await config().update('expectedAccount', value.trim(), target);
      provider.refresh();
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
      const state = await loadWindowState();
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
          description: effectiveEmail(consumer.snapshot) ?? 'not logged in',
          detail: `Used by: ${consumer.name}`,
          dir: consumer.snapshot.configDir,
        }));

      const picked =
        choices.length === 1
          ? choices[0]
          : await vscode.window.showQuickPick(choices, { placeHolder: 'Config dir to log in for' });
      if (!picked) {
        return;
      }

      const existing = vscode.window.terminals.find(t => t.name === TERMINAL_NAME);
      // A reused terminal would keep the previous config dir, so replace it.
      existing?.dispose();
      const terminal = vscode.window.createTerminal({
        name: TERMINAL_NAME,
        env: { [CONFIG_DIR_VAR]: picked.dir },
        cwd: state.workspaceRoot,
      });
      terminal.show();
      terminal.sendText('claude auth login');
      vscode.window.showInformationMessage(
        `Signing in for ${tilde(picked.dir)}${
          state.expectedAccount ? ` — use ${state.expectedAccount}` : ''
        }. Re-read when done.`
      );
    }),

    vscode.commands.registerCommand('claudeAccount.logout', async () => {
      const state = await loadWindowState();
      const snapshot = primaryConsumer(state).snapshot;
      const confirmed = await vscode.window.showWarningMessage(
        `Log out ${effectiveEmail(snapshot) ?? 'this config dir'} from ${tilde(snapshot.configDir)}?`,
        { modal: true },
        'Log Out'
      );
      if (confirmed !== 'Log Out') {
        return;
      }
      const terminal = vscode.window.createTerminal({
        name: TERMINAL_NAME,
        env: { [CONFIG_DIR_VAR]: snapshot.configDir },
        cwd: state.workspaceRoot,
      });
      terminal.show();
      terminal.sendText('claude auth logout');
    })
  );

  // First paint.
  void loadWindowState().then(render);
}

export function deactivate() {}
