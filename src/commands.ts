import * as vscode from 'vscode';
import {
  WindowState,
  effectiveEmail,
  isExplicitDir,
  primaryConsumer,
  realConsumers,
  storeKey,
  storeLabel,
  tilde,
} from './accountReader';
import { AccountItem, AccountProvider } from './accountProvider';
import { detailsMarkdown } from './detailsReport';
import { openClaudeTerminal, runSetExpectedAccount, runUseAccountForThisProject } from './setupFlow';

/**
 * Wrap a command so a thrown error reaches the user as a real message rather
 * than VS Code's generic "command failed" with the detail buried in the log.
 */
function guarded(name: string, run: (...args: unknown[]) => Promise<void> | void) {
  return async (...args: unknown[]) => {
    try {
      await run(...args);
    } catch (err) {
      void vscode.window.showErrorMessage(`Claude Account — ${name}: ${(err as Error).message}`);
    }
  };
}

export function registerCommands(
  context: vscode.ExtensionContext,
  provider: AccountProvider
): void {
  const onDone = () => provider.refresh();

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claudeAccount.useAccountForThisProject',
      guarded('Use a Specific Account', () => runUseAccountForThisProject(onDone))
    ),

    vscode.commands.registerCommand(
      'claudeAccount.setExpectedAccount',
      guarded('Pin Expected Account', () => runSetExpectedAccount(onDone))
    ),

    vscode.commands.registerCommand(
      'claudeAccount.refresh',
      guarded('Re-read', () => {
        provider.refresh();
      })
    ),

    vscode.commands.registerCommand(
      'claudeAccount.showDetails',
      guarded('Show Details', async () => {
        const state = await provider.load();
        const document = await vscode.workspace.openTextDocument({
          content: detailsMarkdown(state),
          language: 'markdown',
        });
        await vscode.window.showTextDocument(document, { preview: true });
      })
    ),

    vscode.commands.registerCommand(
      'claudeAccount.copyValue',
      guarded('Copy Value', async (item?: unknown) => {
        const value = (item as AccountItem | undefined)?.copyValue;
        if (!value) {
          return;
        }
        await vscode.env.clipboard.writeText(value);
        vscode.window.setStatusBarMessage(`Copied ${value}`, 2000);
      })
    ),

    vscode.commands.registerCommand(
      'claudeAccount.openFile',
      guarded('Open File', async (item?: unknown) => {
        const file = (item as AccountItem | undefined)?.filePath;
        if (file) {
          await vscode.window.showTextDocument(vscode.Uri.file(file));
        }
      })
    ),

    vscode.commands.registerCommand(
      'claudeAccount.login',
      guarded('Log In', async () => {
        const state = await provider.load();
        const target = await pickStore(state, 'Which store do you want to sign in to?');
        if (target === null) {
          return;
        }
        openClaudeTerminal(target, state.workspaceRoot, 'claude auth login');
        void vscode.window.showInformationMessage(
          `Signing in for ${target ? tilde(target) : 'the default store'}${
            state.expectedAccount ? ` — use ${state.expectedAccount}` : ''
          }.`
        );
      })
    ),

    vscode.commands.registerCommand(
      'claudeAccount.logout',
      guarded('Log Out', async () => {
        const state = await provider.load();
        const snapshot = primaryConsumer(state).snapshot;
        const confirmed = await vscode.window.showWarningMessage(
          `Log out ${effectiveEmail(snapshot) ?? 'this account'} from ${storeLabel(snapshot)}?`,
          { modal: true },
          'Log Out'
        );
        if (confirmed !== 'Log Out') {
          return;
        }
        openClaudeTerminal(
          isExplicitDir(snapshot.source) ? snapshot.configDir : undefined,
          state.workspaceRoot,
          'claude auth logout'
        );
      })
    )
  );
}

/**
 * Pick which credential store to act on.
 *
 * Returns `undefined` for the implicit default store — which is a real choice,
 * distinct from an explicit `~/.claude` — and `null` when the user cancelled.
 */
async function pickStore(
  state: WindowState,
  placeHolder: string
): Promise<string | undefined | null> {
  const seen = new Set<string>();
  const choices = realConsumers(state)
    .filter(consumer => {
      const key = storeKey(consumer.snapshot);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map(consumer => ({
      label: storeLabel(consumer.snapshot),
      description: effectiveEmail(consumer.snapshot) ?? 'not logged in',
      detail: `Used by: ${consumer.name}`,
      dir: isExplicitDir(consumer.snapshot.source) ? consumer.snapshot.configDir : undefined,
    }));

  if (choices.length === 1) {
    return choices[0].dir;
  }
  const picked = await vscode.window.showQuickPick(choices, { placeHolder });
  return picked ? picked.dir : null;
}
