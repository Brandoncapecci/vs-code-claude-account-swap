import * as vscode from 'vscode';
import { AccountItem, AccountProvider } from './accountProvider';
import { detailsMarkdown } from './detailsReport';
import {
  runAddAccount,
  runFixDuplicateAccount,
  runFixSidebar,
  runLogout,
  runSetExpectedAccount,
  runSignInToStore,
  runSwitchAccount,
  runUseAccountForThisProject,
  runUseAccountHere,
} from './setupFlow';

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
      'claudeAccount.switchAccount',
      guarded('Switch Account', () => runSwitchAccount(onDone))
    ),

    vscode.commands.registerCommand(
      'claudeAccount.useAccountForThisProject',
      guarded('Use a Specific Account', () => runUseAccountForThisProject(onDone))
    ),

    vscode.commands.registerCommand(
      'claudeAccount.fixSidebar',
      guarded('Fix Sidebar Account', () => runFixSidebar(onDone))
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
      'claudeAccount.addAccount',
      guarded('Add Account', () => runAddAccount(onDone))
    ),

    vscode.commands.registerCommand(
      'claudeAccount.signInToStore',
      guarded('Sign In', (item?: unknown) =>
        runSignInToStore((item as AccountItem | undefined)?.store, onDone)
      )
    ),

    vscode.commands.registerCommand(
      'claudeAccount.fixDuplicateAccount',
      guarded('Fix Duplicate Account', (item?: unknown) =>
        runFixDuplicateAccount((item as AccountItem | undefined)?.duplicate, onDone)
      )
    ),

    vscode.commands.registerCommand(
      'claudeAccount.useAccountHere',
      guarded('Use Account Here', (item?: unknown) =>
        runUseAccountHere((item as AccountItem | undefined)?.store, onDone)
      )
    ),

    vscode.commands.registerCommand(
      'claudeAccount.logout',
      guarded('Log Out', (item?: unknown) =>
        runLogout((item as AccountItem | undefined)?.store, onDone)
      )
    )
  );
}
