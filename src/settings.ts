import * as vscode from 'vscode';
import * as path from 'path';
import {
  ReadOptions,
  TerminalProfile,
  WindowState,
  analyzeStores,
  expandHome,
  PLATFORM_KEY,
  normalizeEnvBlock,
  readWindowState,
  resolveClaudePath,
  verifyWindowState,
} from './accountReader';
import { getPin } from './pinStore';

export const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';

export function config(resource?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('claudeAccount', resource);
}

/**
 * The folder every per-project decision is scoped to.
 *
 * An account is pinned per folder, so a multi-root window has to pick one; the
 * commands prompt when it is ambiguous and pass the choice back in here.
 */
export function currentFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

export function currentFolderPath(): string | undefined {
  return currentFolder()?.uri.fsPath;
}

/**
 * The pinned account and where it came from.
 *
 * A committed `claudeAccount.expectedAccount` wins when a team wants to share
 * an expectation; otherwise the machine-local pin applies, which keeps a shared
 * repo clean.
 */
export function expectedAccountWithSource(
  resource?: vscode.Uri
): { value: string | undefined; source: 'settings' | 'machine' | undefined } {
  const uri = resource ?? currentFolder()?.uri;
  const fromSettings = config(uri).get<string>('expectedAccount', '').trim();
  if (fromSettings) {
    return { value: fromSettings, source: 'settings' };
  }
  const fromMachine = getPin(uri?.fsPath);
  return fromMachine ? { value: fromMachine, source: 'machine' } : { value: undefined, source: undefined };
}

export function expectedAccount(resource?: vscode.Uri): string | undefined {
  return expectedAccountWithSource(resource).value;
}

export function projectsRoot(workspace: string | undefined): string | undefined {
  const configured = config().get<string>('projectsRoot', '');
  if (configured.trim()) {
    return expandHome(configured, workspace);
  }
  return workspace ? path.dirname(workspace) : undefined;
}

export function claudePath(): string {
  return resolveClaudePath(config().get<string>('claudePath', ''));
}

/**
 * `claudeCode.environmentVariables` is machine-scoped, so what the configuration
 * API reports is exactly what VS Code hands the Claude Code sidebar — which can
 * differ from what a workspace file declares. Reading it here is the only way to
 * tell the user their workspace-level value is being ignored.
 */
function effectiveSidebarEnv(): Record<string, string> {
  return normalizeEnvBlock(
    vscode.workspace.getConfiguration('claudeCode').get('environmentVariables')
  );
}

/**
 * `terminal.integrated.env.<platform>` as the configuration API reports it,
 * which is user, profile and folder settings merged — the same merge VS Code
 * applies when it spawns a terminal. The folder file alone is not enough: a
 * profile created by this extension's own setup flow puts CLAUDE_CONFIG_DIR
 * there, and reading only the folder made that invisible.
 */
function effectiveTerminalEnv(): Record<string, string> {
  return normalizeEnvBlock(
    vscode.workspace.getConfiguration('terminal.integrated.env').get(PLATFORM_KEY)
  );
}

/**
 * The terminal profiles this window offers, and which one is the default.
 *
 * A profile's `env` is merged after `terminal.integrated.env.<platform>`, so a
 * profile that sets CLAUDE_CONFIG_DIR decides the account for terminals
 * launched with it — which is how two accounts run side by side in one window.
 * Reading only the blanket setting would report an account no terminal uses.
 */
function terminalProfiles(): TerminalProfile[] {
  const terminal = vscode.workspace.getConfiguration('terminal.integrated');
  const defaultName = terminal.get<string>(`defaultProfile.${PLATFORM_KEY}`);
  const profiles = terminal.get<Record<string, unknown>>(`profiles.${PLATFORM_KEY}`) ?? {};

  return Object.entries(profiles)
    .filter(([, value]) => value && typeof value === 'object')
    .map(([name, value]) => ({
      name,
      env: normalizeEnvBlock((value as { env?: unknown }).env),
      isDefault: name === defaultName,
    }));
}

/** Read the window state and verify it against the live CLI. */
export async function loadWindowState(): Promise<WindowState> {
  const folder = currentFolderPath();
  const pinned = expectedAccountWithSource();
  const options: ReadOptions = {
    expectedAccount: pinned.value,
    expectedAccountSource: pinned.source,
    effectiveSidebarEnv: effectiveSidebarEnv(),
    effectiveTerminalEnv: effectiveTerminalEnv(),
    terminalProfiles: terminalProfiles(),
    claudeCodeInstalled: vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID) !== undefined,
  };

  const verify = config().get<boolean>('verifyWithCli', true);
  const state = readWindowState(folder, options);
  if (verify) {
    await verifyWindowState(state, claudePath());
  }
  // Scanning sibling projects is the expensive half of finding stores, and it
  // is exactly what `scanProjects` turns off. Without it the `~/.claude-*`
  // stores are still found, so duplicates are still caught — the listing just
  // stops saying which projects use each one.
  const scanRoot = config().get<boolean>('scanProjects', true) ? projectsRoot(folder) : undefined;
  await analyzeStores(state, scanRoot, verify ? claudePath() : undefined);
  return state;
}
