import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AccountSnapshot,
  CONFIG_DIR_VAR,
  DEFAULT_CONFIG_DIR,
  PLATFORM_KEY,
  WindowState,
  auditProjects,
  discoverStores,
  effectiveEmail,
  effectiveOrg,
  isExplicitDir,
  isLoggedIn,
  isVerified,
  primaryConsumer,
  readWorkspaceEnvOverrides,
  storeEnv,
  storeLabel,
  tilde,
  verifyWithCli,
} from './accountReader';
import { claudePath, loadWindowState, projectsRoot } from './settings';
import { writeProjectAccountSettings } from './settingsIo';
import { TrackingState, setSkipWorktree, wouldDirtyRepo } from './gitTracking';
import { setPin } from './pinStore';

const TERMINAL_NAME = 'Claude Login';

/**
 * The per-project setup flow.
 *
 * The design decision that removes the most steps: a credential store is named
 * after the *account*, not the project. Two projects that should use the same
 * work account share `~/.claude-work` and therefore share one login, so setting
 * up the fifth work repo is "pick you@work.com from a list" — no typing, no
 * second login. Naming stores per project would force one `claude auth login`
 * per repo forever.
 *
 * So the question the flow asks is "which account?", never "which directory?".
 * The directory only surfaces when a new one has to be created.
 */

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

/**
 * Open a terminal bound to a specific credential store.
 *
 * `configDir === undefined` means the implicit default store, and the variable
 * must be *unset* rather than set to `~/.claude` — those are different stores.
 * A `null` value in TerminalOptions.env unsets the key, which also overrides any
 * workspace `terminal.integrated.env` entry.
 */
export function openClaudeTerminal(
  configDir: string | undefined,
  cwd: string | undefined,
  command: string
): vscode.Terminal {
  // Reusing a terminal would keep the previous store's environment.
  vscode.window.terminals.find(t => t.name === TERMINAL_NAME)?.dispose();

  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    env: storeEnv(configDir),
    cwd,
  });
  terminal.show();
  terminal.sendText(command);
  return terminal;
}

/**
 * Run `claude auth login` for a store and wait until the CLI reports an account.
 * Resolves with the signed-in email, or undefined if cancelled or timed out.
 */
export async function loginAndAwait(
  configDir: string | undefined,
  cwd: string | undefined,
  expected?: string
): Promise<string | undefined> {
  openClaudeTerminal(configDir, cwd, 'claude auth login');

  const label = configDir ? tilde(configDir) : 'the default store';
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: expected
        ? `Waiting for sign-in as ${expected} in ${label}…`
        : `Waiting for \`claude auth login\` in ${label}…`,
      cancellable: true,
    },
    async (_progress, token) => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline && !token.isCancellationRequested) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (token.isCancellationRequested) {
          return undefined;
        }
        const result = await verifyWithCli(claudePath(), configDir, {}, cwd);
        if (result.status?.loggedIn && result.status.email) {
          return result.status.email;
        }
      }
      return undefined;
    }
  );
}

// ---------------------------------------------------------------------------
// Account picking
// ---------------------------------------------------------------------------

interface StoreChoice extends vscode.QuickPickItem {
  action: 'use' | 'new' | 'manual';
  configDir?: string;
  email?: string;
  snapshot?: AccountSnapshot;
}

function storeChoices(state: WindowState): StoreChoice[] {
  const stores = discoverStores(state, projectsRoot(state.workspaceRoot));

  const items: StoreChoice[] = stores
    .filter(store => isLoggedIn(store.snapshot) || effectiveEmail(store.snapshot))
    .map(store => {
      const email = effectiveEmail(store.snapshot);
      const org = effectiveOrg(store.snapshot);
      const plan = isVerified(store.snapshot)
        ? (store.snapshot.verification.kind === 'ok' && store.snapshot.verification.status.subscriptionType) || undefined
        : undefined;

      const detail = [
        storeLabel(store.snapshot),
        store.usedBy.length > 0
          ? `used by ${store.usedBy.length} project${store.usedBy.length === 1 ? '' : 's'}: ${store.usedBy.join(', ')}`
          : undefined,
      ]
        .filter(Boolean)
        .join(' — ');

      return {
        action: 'use' as const,
        label: `$(verified-filled) ${email}`,
        description: [org, plan].filter(Boolean).join(' · '),
        detail,
        configDir: store.configDir,
        email,
        snapshot: store.snapshot,
      };
    })
    .sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''));

  // Signed-out stores are still worth offering: picking one means "use this
  // store and sign into it".
  for (const store of stores) {
    if (!isLoggedIn(store.snapshot) && !effectiveEmail(store.snapshot) && store.configDir) {
      items.push({
        action: 'use',
        label: `$(circle-outline) ${tilde(store.configDir)}`,
        description: 'signed out',
        detail: 'Selecting this will sign in',
        configDir: store.configDir,
        snapshot: store.snapshot,
      });
    }
  }

  items.push(
    {
      action: 'new',
      label: '$(add) Sign in with another account…',
      detail: 'Creates a new credential store and runs claude auth login',
      alwaysShow: true,
    },
    {
      action: 'manual',
      label: '$(edit) Enter an email or *@domain manually…',
      detail: 'Pins what to expect without changing which store this project uses',
      alwaysShow: true,
    }
  );

  return items;
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

type WriteTarget = 'folder' | 'user';

/**
 * Decide where `CLAUDE_CONFIG_DIR` should be written.
 *
 * Which account you use is a machine-local fact, but the natural home for it —
 * the folder's `.vscode/settings.json` — is usually committed and shared. When
 * that file is tracked and unmasked, writing there would hand your personal
 * credential-store path to your teammates, so ask instead of assuming.
 */
async function chooseWriteTarget(
  folderName: string,
  tracking: TrackingState
): Promise<WriteTarget | undefined> {
  if (!wouldDirtyRepo(tracking)) {
    return 'folder';
  }

  const folderChoice = {
    label: `$(folder) This folder only`,
    description: '.vscode/settings.json',
    detail: `Tracked by git — the change would show in git status and could be committed. This extension will mask it with git update-index --skip-worktree.`,
    target: 'folder' as const,
  };
  const userChoice = {
    label: '$(person) All my projects',
    description: 'user settings',
    detail: 'Nothing is written to the repo. Applies to every folder that has no override of its own.',
    target: 'user' as const,
  };

  const picked = await vscode.window.showQuickPick([folderChoice, userChoice], {
    title: `"${folderName}" has a committed .vscode/settings.json — where should CLAUDE_CONFIG_DIR go?`,
    placeHolder: 'Pick where this applies',
    matchOnDetail: true,
  });
  return picked?.target;
}

/**
 * Write the store to user settings.
 *
 * `claudeCode.environmentVariables` is machine-scoped, so user settings is the
 * only scope VS Code reliably honours for it anyway. Both blocks are merged
 * rather than replaced so unrelated variables survive.
 */
async function writeUserStore(configDir: string): Promise<void> {
  const terminalEnv = vscode.workspace.getConfiguration('terminal.integrated.env');
  const current = terminalEnv.get<Record<string, string>>(PLATFORM_KEY) ?? {};
  await terminalEnv.update(
    PLATFORM_KEY,
    { ...current, [CONFIG_DIR_VAR]: configDir },
    vscode.ConfigurationTarget.Global
  );

  const claudeCode = vscode.workspace.getConfiguration('claudeCode');
  const entries = [...(claudeCode.get<{ name: string; value: string }[]>('environmentVariables') ?? [])];
  const index = entries.findIndex(entry => entry?.name === CONFIG_DIR_VAR);
  if (index >= 0) {
    entries[index] = { name: CONFIG_DIR_VAR, value: configDir };
  } else {
    entries.push({ name: CONFIG_DIR_VAR, value: configDir });
  }
  await claudeCode.update('environmentVariables', entries, vscode.ConfigurationTarget.Global);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showWarningMessage(
      'Open a folder first — a Claude account is pinned per folder.'
    );
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  return vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Which folder should use a specific account?',
  });
}

/** Ask for a label and turn it into a new `~/.claude-<label>` store. */
async function promptForNewStore(folderName: string, state: WindowState): Promise<string | undefined> {
  const taken = new Set(
    discoverStores(state, projectsRoot(state.workspaceRoot))
      .map(store => store.configDir)
      .filter((dir): dir is string => dir !== undefined)
  );

  const label = await vscode.window.showInputBox({
    title: 'Name this account',
    prompt: `A short label for the account, not an email. The credential store will be ~/.claude-<label>.`,
    value: slugify(folderName),
    placeHolder: 'work',
    validateInput: value => {
      const slug = slugify(value ?? '');
      if (!slug) {
        return 'Enter a short label such as "work" or "personal".';
      }
      if (value.includes('@')) {
        return 'This is a label, not an email — the email is read from the login itself.';
      }
      const dir = path.join(os.homedir(), `.claude-${slug}`);
      if (path.resolve(dir) === DEFAULT_CONFIG_DIR) {
        return `That resolves to ${tilde(DEFAULT_CONFIG_DIR)}, which is a different store from the default and would appear signed out.`;
      }
      if (taken.has(dir)) {
        return `~/.claude-${slug} already exists — pick it from the previous list instead of creating it again.`;
      }
      return undefined;
    },
  });

  if (!label) {
    return undefined;
  }
  const dir = path.join(os.homedir(), `.claude-${slugify(label)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Record the expected account for a folder.
 *
 * Defaults to the machine-local pin so a shared repo stays clean; only writes
 * to `.vscode/settings.json` when an expectation already lives there, i.e. the
 * team deliberately committed one.
 */
async function pinExpected(
  folderPath: string,
  state: WindowState,
  email: string | undefined
): Promise<void> {
  if (state.expectedAccountSource === 'settings') {
    writeProjectAccountSettings(folderPath, { expectedAccount: email ?? '' }, formattingOptions());
    return;
  }
  await setPin(folderPath, email);
}

async function offerReload(folderName: string, email: string | undefined, store: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    `${folderName} now uses ${email ?? store}. The integrated terminal is isolated immediately; the Claude Code sidebar reads a machine-scoped setting, so it may keep the old account until you reload.`,
    'Reload Window',
    'Not Now'
  );
  if (choice === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/**
 * `Use a Specific Account For This Project` — the whole setup flow.
 *
 * Ordering is load-bearing: resolve folder, guard, pick account, create store,
 * write settings, log in, verify, pin the verified email, then offer a reload
 * last (a reload restarts the extension host and would abort anything after it).
 */
export async function runUseAccountForThisProject(onDone: () => void): Promise<void> {
  const folder = await pickFolder();
  if (!folder) {
    return;
  }
  const folderPath = folder.uri.fsPath;
  const folderName = path.basename(folderPath);

  // Refuse to touch a settings file we cannot parse, rather than clobber it.
  const overrides = readWorkspaceEnvOverrides(folderPath);
  if (overrides.kind === 'unreadable') {
    const choice = await vscode.window.showErrorMessage(overrides.error, 'Open Settings File');
    if (choice === 'Open Settings File') {
      await vscode.window.showTextDocument(vscode.Uri.file(overrides.file));
    }
    return;
  }

  const state = await loadWindowState();
  const picked = await vscode.window.showQuickPick(storeChoices(state), {
    title: `Which Claude account should "${folderName}" use?`,
    placeHolder: 'Pick an account, or create a new one',
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }

  let configDir: string | undefined;
  let email: string | undefined;

  if (picked.action === 'manual') {
    const value = await vscode.window.showInputBox({
      title: `Expected account for "${folderName}"`,
      prompt: 'An exact email, or a wildcard such as *@work.com.',
      value: state.expectedAccount ?? '',
      placeHolder: 'you@work.com',
      validateInput: v => (v && v.trim() ? undefined : 'Enter an email or a *@domain wildcard.'),
    });
    if (!value) {
      return;
    }
    await pinExpected(folderPath, state, value.trim());
    onDone();
    void vscode.window.showInformationMessage(`${folderName} now expects ${value.trim()}.`);
    return;
  }

  if (picked.action === 'new') {
    configDir = await promptForNewStore(folderName, state);
    if (!configDir) {
      return;
    }
  } else {
    configDir = picked.configDir;
    email = picked.email;

    // Picking the shared default store means no isolation. Offer the fix once,
    // rather than silently leaving the project sharing one login with all others.
    if (configDir === undefined) {
      const choice = await vscode.window.showWarningMessage(
        `${email ?? 'That account'} lives in the default store, which every unconfigured project shares. Give "${folderName}" its own copy?`,
        { modal: true },
        'Give It Its Own Store',
        'Share The Default Store'
      );
      if (!choice) {
        return;
      }
      if (choice === 'Give It Its Own Store') {
        configDir = await promptForNewStore(folderName, state);
        if (!configDir) {
          return;
        }
        email = undefined; // A fresh store needs its own login.
      }
    }
  }

  const target = await chooseWriteTarget(folderName, state.settingsTracking);
  if (!target) {
    return;
  }

  try {
    if (target === 'user') {
      await writeUserStore(configDir!);
    } else {
      const { file } = writeProjectAccountSettings(folderPath, { configDir }, formattingOptions());
      // Keep a committed settings file from carrying a personal path upstream.
      if (wouldDirtyRepo(state.settingsTracking)) {
        try {
          setSkipWorktree(file);
        } catch (err) {
          void vscode.window.showWarningMessage(
            `Wrote ${tilde(file)}, but could not mask it with git update-index --skip-worktree: ${(err as Error).message}`
          );
        }
      }
    }
  } catch (err) {
    void vscode.window.showErrorMessage((err as Error).message);
    return;
  }

  // Sign in when the chosen store has no account yet.
  if (!email) {
    email = await loginAndAwait(configDir, folderPath, state.expectedAccount);
    if (!email) {
      onDone();
      void vscode.window.showWarningMessage(
        `${folderName} now uses ${configDir ? tilde(configDir) : 'the default store'}, but no sign-in was detected. Run "Claude Account: Re-read Now" once login finishes.`
      );
      return;
    }
  }

  // Pin the expectation from the verified email — never from typing.
  try {
    await pinExpected(folderPath, state, email);
  } catch (err) {
    void vscode.window.showErrorMessage((err as Error).message);
    return;
  }

  onDone();
  await offerReload(folderName, email, configDir ? tilde(configDir) : 'the default store');
}

/**
 * Fix a sidebar that resolves a different account from the terminal.
 *
 * There is no per-folder fix for `claudeCode.environmentVariables` itself: it is
 * machine-scoped, so VS Code applies only the user-level value and shows
 * "This setting can only be applied in user settings" on a workspace one.
 * That leaves exactly two real routes, both offered here.
 *
 * Ruled out by testing, so nobody re-suggests them: an `env` block in
 * `.claude/settings.local.json` cannot set CLAUDE_CONFIG_DIR (the store has to
 * be resolved before settings are read — verified, the account does not
 * change), and `claudeCode.claudeProcessWrapper` is machine-scoped too.
 */
export async function runFixSidebar(onDone: () => void): Promise<void> {
  const folder = await pickFolder();
  if (!folder) {
    return;
  }
  const state = await loadWindowState();
  const snapshot = primaryConsumer(state).snapshot;
  const dir = isExplicitDir(snapshot.source) ? snapshot.configDir : undefined;
  const account = effectiveEmail(snapshot) ?? 'the terminal account';

  const useTerminal = {
    label: '$(terminal) Run Claude in a terminal in this project',
    description: 'per-project',
    detail:
      'Sets claudeCode.useTerminal for this folder. A terminal honours per-folder settings, so the account follows the project. You get the terminal UI here instead of the native sidebar.',
    action: 'terminal' as const,
  };
  const allProjects = {
    label: `$(person) Use ${account} in every project`,
    description: 'affects other projects',
    detail: dir
      ? `Writes claudeCode.environmentVariables to user settings (${tilde(dir)}). Machine-scoped settings only apply at user level, so this is all-or-nothing across projects.`
      : 'Clears the user-level override so the sidebar uses the default store everywhere.',
    action: 'user' as const,
  };

  const useProfile = {
    label: '$(versions) Open this project in its own editor profile',
    description: 'per-project, keeps the native UI',
    detail:
      'A profile has its own user settings, and machine-scoped settings live there — so each profile can point at a different store. The only route that gives per-project accounts AND the native sidebar.',
    action: 'profile' as const,
  };

  const picked = await vscode.window.showQuickPick([useProfile, useTerminal, allProjects], {
    title: 'The Claude Code sidebar is on a different account',
    placeHolder: 'claudeCode.environmentVariables cannot be set per folder — pick a route',
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }

  if (picked.action === 'profile') {
    await runProfileRoute(folder, dir, account);
    return;
  }

  if (picked.action === 'terminal') {
    // useTerminal is window-scoped, so unlike environmentVariables it can be
    // set for one folder.
    await vscode.workspace
      .getConfiguration('claudeCode', folder.uri)
      .update('useTerminal', true, vscode.ConfigurationTarget.Workspace);

    if (state.settingsTracking === 'tracked' && state.overrides.kind === 'parsed') {
      try {
        setSkipWorktree(state.overrides.file);
      } catch {
        // Best effort; the repo-leak row still flags it.
      }
    }
    onDone();
    const choice = await vscode.window.showInformationMessage(
      'Claude Code will open in a terminal in this project, which picks up the folder\'s CLAUDE_CONFIG_DIR. Reload to apply.',
      'Reload Window',
      'Not Now'
    );
    if (choice === 'Reload Window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    return;
  }

  // A user-level write applies to every project in the current editor profile.
  // In the default profile that means literally all of them, so name the ones
  // it would break rather than letting the user discover it project by project.
  const conflicts = auditProjects(projectsRoot(state.workspaceRoot) ?? '')
    .filter(audit => audit.snapshot.configDir !== dir)
    .map(audit => audit.name);

  if (conflicts.length > 0) {
    const proceed = await vscode.window.showWarningMessage(
      `This sets the sidebar to ${account} for every project in this editor profile. ` +
        `${conflicts.length === 1 ? 'This project uses' : 'These projects use'} a different store and ` +
        `${conflicts.length === 1 ? 'its' : 'their'} sidebar would become wrong: ${conflicts.join(', ')}.\n\n` +
        'To keep them separate, cancel and use the profile route instead.',
      { modal: true },
      'Apply To All Anyway'
    );
    if (proceed !== 'Apply To All Anyway') {
      return;
    }
  }

  if (dir) {
    await writeUserStore(dir);
  } else {
    await vscode.workspace
      .getConfiguration('claudeCode')
      .update('environmentVariables', undefined, vscode.ConfigurationTarget.Global);
  }
  onDone();
  const choice = await vscode.window.showInformationMessage(
    `The Claude Code sidebar will use ${account} in every project. Reload to apply.`,
    'Reload Window',
    'Not Now'
  );
  if (choice === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/**
 * Reopen the folder under its own editor profile.
 *
 * This is the only route that gets a per-project account *and* keeps the native
 * Claude Code panel. A profile carries its own user settings, and machine-scoped
 * settings such as `claudeCode.environmentVariables` are stored there rather
 * than shared — settings that must be shared across profiles use the separate
 * "application" scope instead.
 *
 * Two steps, because the second one has to run inside the new profile's window:
 * open the folder with `--profile`, then use *Use in every project* there, which
 * writes to that profile's user settings and so applies only inside it.
 */
async function runProfileRoute(
  folder: vscode.WorkspaceFolder,
  dir: string | undefined,
  account: string
): Promise<void> {
  const suggested = `Claude ${path.basename(folder.uri.fsPath)}`;
  const name = await vscode.window.showInputBox({
    title: 'Name the editor profile',
    prompt: 'The folder reopens under this profile and stays associated with it.',
    value: suggested,
    validateInput: v => (v && v.trim() ? undefined : 'Enter a profile name.'),
  });
  if (!name) {
    return;
  }

  // --new-window matters: without it an already-open folder is merely focused
  // in the window it is in, keeping its current profile, and the association
  // silently never happens.
  const editor = vscode.env.appName.toLowerCase().includes('cursor') ? 'cursor' : 'code';
  const command = `${editor} --profile ${JSON.stringify(name.trim())} --new-window ${JSON.stringify(folder.uri.fsPath)}`;

  const choice = await vscode.window.showInformationMessage(
    `Reopen "${path.basename(folder.uri.fsPath)}" under the "${name.trim()}" profile, then run Fix Sidebar Account again in that window and choose "Use ${account} in every project" — inside a profile that writes only to that profile. Close this window afterwards so the folder is not open twice.`,
    'Run It',
    'Copy Command'
  );

  if (choice === 'Run It') {
    const terminal = vscode.window.createTerminal({ name: 'Claude Profile', cwd: folder.uri.fsPath });
    terminal.show();
    terminal.sendText(command);
  } else if (choice === 'Copy Command') {
    await vscode.env.clipboard.writeText(command);
    void vscode.window.showInformationMessage('Command copied.');
  }

  if (dir) {
    // Leave a breadcrumb so the second step is obvious in the new window.
    void vscode.window.setStatusBarMessage(`Profile target store: ${tilde(dir)}`, 8000);
  }
}

/** Pin an expected account without touching which store the project uses. */
export async function runSetExpectedAccount(onDone: () => void): Promise<void> {
  const folder = await pickFolder();
  if (!folder) {
    return;
  }
  const state = await loadWindowState();
  const live = effectiveEmail(state.consumers[0].snapshot);

  const value = await vscode.window.showInputBox({
    title: `Expected Claude account for "${path.basename(folder.uri.fsPath)}"`,
    prompt: 'Exact email, or a wildcard such as *@work.com. Leave empty to clear.',
    value: state.expectedAccount ?? live ?? '',
    placeHolder: 'you@work.com',
  });
  if (value === undefined) {
    return;
  }

  try {
    await pinExpected(folder.uri.fsPath, state, value.trim() || undefined);
  } catch (err) {
    void vscode.window.showErrorMessage((err as Error).message);
    return;
  }
  onDone();
}

function formattingOptions() {
  const editor = vscode.workspace.getConfiguration('editor');
  return {
    tabSize: editor.get<number>('tabSize', 2),
    insertSpaces: editor.get<boolean>('insertSpaces', true),
    eol: '\n',
  };
}

/** Whether this window's folder declares a store of its own. */
export function isIsolated(state: WindowState): boolean {
  return state.isolated;
}

/** Config dir of the store a login should target, honouring the unset case. */
export function loginTarget(snapshot: AccountSnapshot): string | undefined {
  return isExplicitDir(snapshot.source) ? snapshot.configDir : undefined;
}

export { CONFIG_DIR_VAR };
