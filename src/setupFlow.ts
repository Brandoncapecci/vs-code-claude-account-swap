import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AccountSnapshot,
  CONFIG_DIR_VAR,
  DEFAULT_CONFIG_DIR,
  DuplicateGroup,
  PLATFORM_KEY,
  StoreInfo,
  WindowState,
  WriteTarget,
  auditProjects,
  existingWriteTarget,
  discoverStores,
  effectiveEmail,
  effectiveOrg,
  isExplicitDir,
  isLoggedIn,
  isVerified,
  logoutWithCli,
  normalizeEnvBlock,
  primaryConsumer,
  readWorkspaceEnvOverrides,
  storeEnv,
  storeLabel,
  tilde,
  verifyWithCli,
} from './accountReader';
import { claudePath, currentFolderPath, loadWindowState, projectsRoot } from './settings';
import { clearHandoff, readHandoff, writeHandoff } from './profileHandoff';
import { writeProjectAccountSettings } from './settingsIo';
import { TrackingState, setSkipWorktree, wouldDirtyRepo } from './gitTracking';
import { setPin } from './pinStore';

const TERMINAL_NAME = 'Claude Login';

/** What may be passed to `claude auth login --email` as a bare argument. */
const EMAIL_ARGUMENT = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

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

export interface LoginOptions {
  /** Pinned account, shown while waiting so the user knows which to pick. */
  expected?: string;
  /**
   * The account already in this store. Set it to sign out first and to keep
   * waiting until the email actually changes — without it, replacing a login
   * would "succeed" the instant the CLI reported the old one.
   */
  replacing?: string;
  /** Pre-fills the email on the login page, via `claude auth login --email`. */
  emailHint?: string;
}

/**
 * Run `claude auth login` for a store and wait until the CLI reports an account.
 * Resolves with the signed-in email, or undefined if cancelled or timed out.
 */
export async function loginAndAwait(
  configDir: string | undefined,
  cwd: string | undefined,
  options: LoginOptions = {}
): Promise<string | undefined> {
  const { expected, replacing, emailHint } = options;
  // Sign the old account out first, so the CLI cannot answer the poll below
  // with the login that is being replaced. Done off the terminal, which keeps
  // the visible command to a single portable one.
  if (replacing) {
    await logoutWithCli(claudePath(), configDir, cwd);
  }
  // Checked here as well as at the prompt: this string is appended to a command
  // line, and a caller is not the right place to rely on for that.
  const hint = emailHint && EMAIL_ARGUMENT.test(emailHint) ? emailHint : undefined;
  openClaudeTerminal(configDir, cwd, `claude auth login${hint ? ` --email ${hint}` : ''}`);

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
        const email = result.status?.loggedIn ? result.status.email : undefined;
        if (email && email.toLowerCase() !== replacing?.toLowerCase()) {
          return email;
        }
      }
      return undefined;
    }
  );
}

// ---------------------------------------------------------------------------
// Account picking
// ---------------------------------------------------------------------------

/**
 * Every store on the machine, scanning only if the state predates the scan.
 *
 * `loadWindowState` fills this in, so the common path reuses one home-directory
 * read rather than repeating it per quick pick.
 */
function storesOf(state: WindowState): StoreInfo[] {
  return state.stores.length > 0
    ? state.stores
    : discoverStores(state, projectsRoot(state.workspaceRoot));
}

interface StoreChoice extends vscode.QuickPickItem {
  action: 'use' | 'new' | 'manual';
  configDir?: string;
  email?: string;
  snapshot?: AccountSnapshot;
}

function storeChoices(state: WindowState): StoreChoice[] {
  const stores = storesOf(state);

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
async function promptForNewStore(
  folderName: string | undefined,
  state: WindowState
): Promise<string | undefined> {
  const taken = new Set(
    storesOf(state)
      .map(store => store.configDir)
      .filter((dir): dir is string => dir !== undefined)
  );

  const label = await vscode.window.showInputBox({
    title: 'Name this account',
    prompt: `A short label for the account, not an email. The credential store will be ~/.claude-<label>.`,
    value: folderName ? slugify(folderName) : '',
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

  await applyStore({ folderPath, folderName, state, configDir, email, onDone });
}

/**
 * Point a folder at a store, sign in if it has none, and pin what we saw.
 *
 * The tail of choosing an account, shared by the guided setup and the one-step
 * switch, because the two differ only in how the store is chosen. A switch that
 * wrote the setting its own way would be a second answer to "where does
 * CLAUDE_CONFIG_DIR live for this folder", and the two would drift.
 */
async function applyStore(input: {
  folderPath: string;
  folderName: string;
  state: WindowState;
  configDir: string | undefined;
  email: string | undefined;
  onDone: () => void;
  /** Skip the where-should-this-go question when the answer is already on disk. */
  target?: WriteTarget;
}): Promise<void> {
  const { folderPath, folderName, state, configDir, onDone } = input;
  let email = input.email;

  const target = input.target ?? (await chooseWriteTarget(folderName, state.settingsTracking));
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
    email = await loginAndAwait(configDir, folderPath, { expected: state.expectedAccount });
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
 * Switch this folder to another account in one step.
 *
 * The guided flow exists to *set up* isolation and asks the questions that go
 * with it. Once a folder has a store, changing which one is a single choice,
 * and making someone walk the setup again to make it is the reason people go
 * back to editing settings.json by hand.
 *
 * Only stores that already hold a login are offered. Creating a store, signing
 * into an empty one, and pinning an expectation are all the setup flow's job,
 * reachable from the last entry rather than duplicated here.
 */
export async function runSwitchAccount(onDone: () => void): Promise<void> {
  const folder = await pickFolder();
  if (!folder) {
    return;
  }
  const folderPath = folder.uri.fsPath;
  const folderName = path.basename(folderPath);

  const state = await loadWindowState();
  const current = primaryConsumer(state).snapshot;
  const currentDir = isExplicitDir(current.source) ? current.configDir : undefined;

  const stores = storesOf(state)
    .filter(store => effectiveEmail(store.snapshot))
    .sort((a, b) => (effectiveEmail(a.snapshot) ?? '').localeCompare(effectiveEmail(b.snapshot) ?? ''));

  const items: (vscode.QuickPickItem & { configDir?: string; email?: string; setup?: true })[] =
    stores.map(store => {
      const inUse = store.configDir === currentDir;
      // Two stores on one account otherwise appear here as two identical rows,
      // which is the exact confusion the duplicate row exists to end.
      const shared = state.duplicateStores.find(group =>
        group.stores.some(other => sameStore(other.configDir, store.configDir))
      );
      return {
        label: `${inUse ? '$(check)' : '$(account)'} ${effectiveEmail(store.snapshot)}`,
        description: [effectiveOrg(store.snapshot), inUse ? 'current' : undefined]
          .filter(Boolean)
          .join(' · '),
        detail: shared
          ? `${storeLabel(store.snapshot)} — same account as ${shared.stores
              .filter(other => !sameStore(other.configDir, store.configDir))
              .map(other => storeLabel(other.snapshot))
              .join(', ')}`
          : storeLabel(store.snapshot),
        configDir: store.configDir,
        email: effectiveEmail(store.snapshot) ?? undefined,
      };
    });

  items.push({
    label: '$(gear) Set up another account…',
    detail: 'Create a store, sign in, or pin what this project should expect',
    setup: true,
    alwaysShow: true,
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: `Which Claude account should "${folderName}" use?`,
    placeHolder: 'Pick an account',
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }
  if (picked.setup) {
    await runUseAccountForThisProject(onDone);
    return;
  }
  if (picked.configDir === currentDir) {
    void vscode.window.showInformationMessage(`${folderName} already uses ${picked.email}.`);
    return;
  }

  await applyStore({
    folderPath,
    folderName,
    state,
    configDir: picked.configDir,
    email: picked.email,
    onDone,
    target: existingWriteTarget(state),
  });
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

  // Labelled by outcome, not mechanism. Someone fixing one project should never
  // have to reason about editor profiles, or be steered into an "every project"
  // button to achieve a single-project goal.
  const useTerminal = {
    label: `$(check) Use ${account} in this project only`,
    description: 'recommended · one setting',
    detail:
      'Runs Claude in an integrated terminal here, which picks up this folder\'s CLAUDE_CONFIG_DIR. Trade-off: you get the terminal UI in this project instead of the native panel. Nothing else changes, and other projects are untouched.',
    action: 'terminal' as const,
  };
  const allProjects = {
    label: `$(warning) Use ${account} in ALL projects`,
    description: 'changes other projects',
    detail: dir
      ? `Writes it to user settings, which is the only scope this setting honours. Every project without its own profile switches to ${tilde(dir)}.`
      : 'Clears the override so every project without its own profile uses the default store.',
    action: 'user' as const,
  };

  const useProfile = {
    label: `$(versions) Use ${account} in this project only — keep the native panel`,
    description: 'more setup',
    detail:
      'Copies your profile into one used only by this folder. Trade-off: a profile keeps its own extension list unless you share it, so an extension updated later can be left behind in one profile.',
    action: 'profile' as const,
  };

  const picked = await vscode.window.showQuickPick([useTerminal, useProfile, allProjects], {
    title: `Claude Code's panel is signed in as someone else`,
    placeHolder: 'How widely should this apply?',
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

  // Always confirm: this is the one option that reaches outside the current
  // project, and the detected-conflict list is only as complete as the folders
  // we happened to scan.
  const proceed = await vscode.window.showWarningMessage(
    `Set the Claude Code panel to ${account} for every project in this editor profile?`,
    {
      modal: true,
      detail:
        conflicts.length > 0
          ? `${conflicts.length === 1 ? 'This project uses' : 'These projects use'} a different account and ` +
            `${conflicts.length === 1 ? 'its' : 'their'} panel would become wrong: ${conflicts.join(', ')}.\n\n` +
            'To change only this project, cancel and pick the first option instead.'
          : 'Any other project without its own profile will switch too.\n\nTo change only this project, cancel and pick the first option instead.',
    },
    'Change All Projects'
  );
  if (proceed !== 'Change All Projects') {
    return;
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
  const confirmed = await vscode.window.showInformationMessage(
    `Give "${path.basename(folder.uri.fsPath)}" its own profile?`,
    {
      modal: true,
      detail:
        'Your current profile — extensions, theme and settings — is copied into a new one used only by this folder, and this window switches to it. ' +
        `${account} is applied automatically once it does.\n\n` +
        'Name the profile in the editor that opens, then choose Create.\n\n' +
        'One thing to know: the copy includes the extension list, and from then on the two lists are separate. An extension you update later lands in one profile and stays at the old version in the other, silently. ' +
        'To keep one extension shared everywhere, right-click it in the Extensions view and choose "Apply Extension to all Profiles" — or, in the profile editor, have the new profile use the default profile\'s extensions instead of a copy.',
    },
    'Continue'
  );
  if (confirmed !== 'Continue') {
    return;
  }

  writeHandoff({
    folder: folder.uri.fsPath,
    configDir: dir,
    account,
    createdAt: Date.now(),
  });

  // "Save Current Profile As…" — copies the current profile rather than
  // creating an empty one. The CLI's --profile makes a blank profile with no
  // extensions and a default theme, which is not a usable workspace.
  await vscode.commands.executeCommand('workbench.profiles.actions.createFromCurrentProfile');
  return;
}

/**
 * Second half of the profile route, run in the newly opened window.
 *
 * Writing at Global scope here lands in *this profile's* user settings, which
 * is the whole point: the same write that would hit every project from the
 * default profile is confined to this one.
 */
export async function consumeProfileHandoff(onDone: () => void): Promise<void> {
  const folder = currentFolderPath();
  const handoff = readHandoff(folder);
  if (!handoff) {
    return;
  }
  clearHandoff();

  const already = normalizeEnvBlock(
    vscode.workspace.getConfiguration('claudeCode').get('environmentVariables')
  )[CONFIG_DIR_VAR];
  if (already === handoff.configDir) {
    return;
  }

  try {
    if (handoff.configDir) {
      await writeUserStore(handoff.configDir);
    } else {
      await vscode.workspace
        .getConfiguration('claudeCode')
        .update('environmentVariables', undefined, vscode.ConfigurationTarget.Global);
    }
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Could not finish profile setup: ${(err as Error).message}`
    );
    return;
  }

  onDone();
  const choice = await vscode.window.showInformationMessage(
    // Unnamed on purpose: the editor's own UI collects the profile name and no
    // API reports it back, so naming it here could only ever be a guess.
    `This window's new profile now uses ${handoff.account ?? 'the selected account'}${
      handoff.configDir ? ` (${tilde(handoff.configDir)})` : ''
    }. Other projects are unaffected. Reload to apply it to the Claude Code panel.`,
    'Reload Window',
    'Not Now'
  );
  if (choice === 'Reload Window') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
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

// ---------------------------------------------------------------------------
// Adding an account, and undoing two stores that hold one
// ---------------------------------------------------------------------------

/** Whether two store references mean the same store, unset included. */
function sameStore(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return path.resolve(a) === path.resolve(b);
}

/** The duplicate group a store now belongs to, if signing in created one. */
function duplicateGroupFor(
  state: WindowState,
  configDir: string | undefined
): DuplicateGroup | undefined {
  return state.duplicateStores.find(group =>
    group.stores.some(store => sameStore(store.configDir, configDir))
  );
}

/**
 * Ask which account a sign-in should target.
 *
 * Undefined means cancel; an empty string means "let me choose in the browser",
 * which an input box distinguishes — Escape returns undefined, Enter on an
 * empty field returns "".
 */
async function askEmailHint(store: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: `Which account should ${store} use?`,
    prompt:
      'Optional. Pre-fills the email on the login page, so the browser is less likely to sign you straight back in as the account you already have. Leave empty to choose in the browser.',
    placeHolder: 'you@work.com',
    // The value is appended to a command line, so restrict it to what an email
    // is made of rather than quote it: quoting is shell-specific, and single
    // quotes reach `cmd.exe` as part of the address.
    validateInput: value =>
      !value || EMAIL_ARGUMENT.test(value.trim())
        ? undefined
        : 'Enter a plain email address, or leave it empty to choose in the browser.',
  });
  return value === undefined ? undefined : value.trim();
}


/**
 * Sign a store in, and refuse to call it done when the account that arrives is
 * one another store already holds.
 *
 * This is the check the extension was missing. A second sign-in lands on the
 * claude.ai session already open in the browser and completes without a word,
 * leaving two stores that look isolated and are not — so the sign-in is not
 * finished until we have looked at what actually came back.
 */
async function signInAndConfirm(
  configDir: string | undefined,
  cwd: string | undefined,
  options: LoginOptions = {}
): Promise<string | undefined> {
  let attempt: LoginOptions = options;

  for (;;) {
    const email = await loginAndAwait(configDir, cwd, attempt);
    if (!email) {
      return undefined;
    }

    // Re-read rather than reason about it: this is the same detection the tree
    // row uses, so the two can never disagree about what counts as a duplicate.
    const group = duplicateGroupFor(await loadWindowState(), configDir);
    if (!group) {
      return email;
    }

    const others = group.stores
      .filter(store => !sameStore(store.configDir, configDir))
      .map(store => storeLabel(store.snapshot));
    const choice = await vscode.window.showWarningMessage(
      `That signed in as ${email} — the account ${others.join(' and ')} already ${
        others.length === 1 ? 'uses' : 'use'
      }.`,
      {
        modal: true,
        detail:
          'Two stores holding one login are not isolated: whichever project you open, it is the same account.\n\n' +
          'The browser almost certainly reused the claude.ai session you already had. Sign out of claude.ai, or use a private window, and try again.',
      },
      'Sign In Again',
      'Keep It'
    );
    if (choice !== 'Sign In Again') {
      return email; // Including Escape: the login happened, so report it honestly.
    }

    const hint = await askEmailHint(configDir ? tilde(configDir) : 'the default store');
    if (hint === undefined) {
      return email;
    }
    attempt = { ...options, replacing: email, emailHint: hint || undefined };
  }
}

/**
 * `Add Account` — create a store, sign into it, confirm it is a new account.
 *
 * Deliberately not per-project: an account is a machine-level thing that any
 * number of projects then point at, and requiring an open folder to add one
 * was the reason signing in ever needed a "which store?" question of its own.
 */
export async function runAddAccount(onDone: () => void): Promise<void> {
  const state = await loadWindowState();
  const folder = vscode.workspace.workspaceFolders?.[0];
  const folderPath = folder?.uri.fsPath;

  const configDir = await promptForNewStore(undefined, state);
  if (!configDir) {
    return;
  }

  const email = await signInAndConfirm(configDir, folderPath, {});
  onDone();
  if (!email) {
    void vscode.window.showWarningMessage(
      `Created ${tilde(configDir)}, but no sign-in was detected. Run "Claude Account: Re-read Now" once login finishes.`
    );
    return;
  }

  if (!folderPath) {
    void vscode.window.showInformationMessage(
      `${tilde(configDir)} is signed in as ${email}. Open a folder to use it there.`
    );
    return;
  }

  const folderName = path.basename(folderPath);
  const choice = await vscode.window.showInformationMessage(
    `${tilde(configDir)} is signed in as ${email}.`,
    `Use It For "${folderName}"`,
    'Not Now'
  );
  if (choice !== `Use It For "${folderName}"`) {
    return;
  }

  await applyStore({
    folderPath,
    folderName,
    state: await loadWindowState(),
    configDir,
    email,
    onDone,
  });
}

/**
 * Sign in to one named store — the row's action, never a free-floating command.
 *
 * Without a store to act on this would have to ask which one, which is the
 * question that made the old top-level "Log In…" useless: two rows, the same
 * email on both, and no way to tell which you meant.
 */
export async function runSignInToStore(
  target: { configDir: string | undefined; label: string; email?: string } | undefined,
  onDone: () => void
): Promise<void> {
  const state = await loadWindowState();
  const snapshot = primaryConsumer(state).snapshot;
  const store = target ?? {
    configDir: loginTarget(snapshot),
    label: storeLabel(snapshot),
    email: effectiveEmail(snapshot),
  };

  // A store that already holds an account gives "sign in" two meanings, and
  // they need opposite handling: renewing an expired session ends on the same
  // email, so there is nothing to watch for, while changing accounts has to
  // sign out first and is only finished once a different email comes back.
  if (store.email) {
    await signInOverExisting(store, state, onDone);
    return;
  }

  const email = await signInAndConfirm(store.configDir, state.workspaceRoot, {
    expected: state.expectedAccount,
  });
  onDone();
  void (email
    ? vscode.window.showInformationMessage(`${store.label} is signed in as ${email}.`)
    : vscode.window.showWarningMessage(
        `No sign-in was detected for ${store.label}. Run "Claude Account: Re-read Now" once login finishes.`
      ));
}

async function signInOverExisting(
  store: { configDir: string | undefined; label: string; email?: string },
  state: WindowState,
  onDone: () => void
): Promise<void> {
  const same = 'Sign In As The Same Account';
  const other = 'Sign In As A Different Account';
  const choice = await vscode.window.showInformationMessage(
    `${store.label} is already signed in as ${store.email}.`,
    {
      modal: true,
      detail:
        `Signing in as the same account renews this session and changes nothing else.\n\n` +
        `Signing in as a different one signs ${store.email} out of this store first — every project pointed at it moves to the new account.`,
    },
    same,
    other
  );
  if (!choice) {
    return;
  }

  if (choice === same) {
    // Nothing observable changes — same store, same email — so there is no
    // state to poll on, and claiming to have waited for one would be a lie.
    openClaudeTerminal(store.configDir, state.workspaceRoot, 'claude auth login');
    void vscode.window.showInformationMessage(
      `Signing in to ${store.label} as ${store.email}. Use "Claude Account: Re-read Now" if the view does not update when it finishes.`
    );
    return;
  }

  const hint = await askEmailHint(store.label);
  if (hint === undefined) {
    return;
  }
  const email = await signInAndConfirm(store.configDir, state.workspaceRoot, {
    replacing: store.email,
    emailHint: hint || undefined,
  });
  onDone();
  void (email
    ? vscode.window.showInformationMessage(`${store.label} is now signed in as ${email}.`)
    : // The sign-out already happened, so silence here would leave a store
      // logged out with nothing on screen saying so.
      vscode.window.showWarningMessage(
        `${store.label} was signed out of ${store.email}, and no new sign-in was detected. Finish the login in the terminal, or sign in again.`
      ));
}

/**
 * Sign one of the stores that share an account in as a different one.
 *
 * The row this hangs off already says which stores collide, so the only open
 * question is which of them should change — and that is a real choice: the one
 * to re-sign is whichever is used by the projects that should move.
 */
export async function runFixDuplicateAccount(
  group: DuplicateGroup | undefined,
  onDone: () => void
): Promise<void> {
  const state = await loadWindowState();
  const target = group ?? state.duplicateStores[0];
  if (!target) {
    void vscode.window.showInformationMessage('No two stores are sharing an account.');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    target.stores.map(store => ({
      label: storeLabel(store.snapshot),
      description:
        store.usedBy.length > 0 ? `used by ${store.usedBy.join(', ')}` : 'not used by any project',
      detail:
        store.configDir === undefined
          ? 'The store every project without an override shares — usually the one to leave alone'
          : undefined,
      store,
    })),
    {
      title: `All of these are signed in as ${target.email ?? 'one account'}`,
      placeHolder: 'Which store should be signed in as a different account?',
      matchOnDetail: true,
    }
  );
  if (!picked) {
    return;
  }

  const hint = await askEmailHint(picked.label);
  if (hint === undefined) {
    return;
  }

  // The group's email is the *first* store's, and members can hold different
  // emails — a UUID match survives a rename. Replacing what this store actually
  // holds is what makes "wait for a different account" mean anything.
  const email = await signInAndConfirm(picked.store.configDir, state.workspaceRoot, {
    replacing: effectiveEmail(picked.store.snapshot),
    emailHint: hint || undefined,
  });
  onDone();
  void (email
    ? vscode.window.showInformationMessage(`${picked.label} is now signed in as ${email}.`)
    : vscode.window.showWarningMessage(
        `${picked.label} was signed out, and no new sign-in was detected. Finish the login in the terminal, or sign in again.`
      ));
}

/** Log out of one named store. Falls back to the account this window uses. */
export async function runLogout(
  target: { configDir: string | undefined; label: string; email?: string } | undefined,
  onDone: () => void
): Promise<void> {
  const state = await loadWindowState();
  const snapshot = primaryConsumer(state).snapshot;
  const store = target ?? {
    configDir: loginTarget(snapshot),
    label: storeLabel(snapshot),
    email: effectiveEmail(snapshot),
  };

  const confirmed = await vscode.window.showWarningMessage(
    `Log out ${store.email ?? 'this account'} from ${store.label}?`,
    {
      modal: true,
      detail: 'Every project pointed at this store is signed out until you sign in again.',
    },
    'Log Out'
  );
  if (confirmed !== 'Log Out') {
    return;
  }

  openClaudeTerminal(store.configDir, state.workspaceRoot, 'claude auth logout');
  onDone();
}
