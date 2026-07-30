import * as vscode from 'vscode';
import { AccountProvider } from './accountProvider';
import { registerCommands } from './commands';
import { StatusBar } from './statusBar';
import { initPinStore } from './pinStore';
import { consumeProfileHandoff } from './setupFlow';

/** How long after a load a window-focus event is treated as redundant. */
const FOCUS_COOLDOWN_MS = 2000;

export function activate(context: vscode.ExtensionContext) {
  // Per-folder pins live here rather than in a possibly-committed settings file.
  initPinStore(context.globalState);

  const provider = new AccountProvider();
  const treeView = vscode.window.createTreeView('claudeAccountView', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  const statusBar = new StatusBar(treeView);

  treeView.message = 'Checking with claude auth status…';

  context.subscriptions.push(
    treeView,
    provider,
    statusBar,

    provider.onDidLoad(state => {
      treeView.message = undefined;
      statusBar.render(state);
    }),

    // Coming back to the window is when a stale reading matters most: the user
    // may have just logged in somewhere else.
    vscode.window.onDidChangeWindowState(windowState => {
      if (windowState.focused && Date.now() - provider.lastLoadedAt > FOCUS_COOLDOWN_MS) {
        void provider.load();
      }
    }),

    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('claudeAccount')) {
        return;
      }
      if (event.affectsConfiguration('claudeAccount.refreshInterval')) {
        provider.restartPolling();
      }
      void provider.load();
    }),

    // A folder added or removed changes which account is pinned.
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh())
  );

  registerCommands(context, provider);

  // If this window was opened by the profile route, finish that setup here —
  // Global scope means this profile only.
  void consumeProfileHandoff(() => provider.refresh());

  void provider.load().catch(err => {
    void vscode.window.showErrorMessage(`Claude Account failed to start: ${(err as Error).message}`);
  });
}

export function deactivate() {}
