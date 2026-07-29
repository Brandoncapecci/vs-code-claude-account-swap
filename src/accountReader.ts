import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import * as jsonc from 'jsonc-parser';
import { TrackingState, trackingState } from './gitTracking';

/**
 * Core data layer. Deliberately free of any `vscode` import so it can be
 * exercised directly under plain node.
 *
 * Nothing here is memoized. Every call reads from disk, or asks the Claude Code
 * CLI, right now. That is the point of the extension: the Claude Code sidebar
 * caches the account it saw when the window started, while API calls read
 * credentials live, so a stale display can disagree with what requests use.
 */

export const CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR';
export const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
export const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.claude');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Expand the variable forms VS Code itself expands in `terminal.integrated.env`,
 * plus `~`. A project that writes `${workspaceFolder}/.claude-dir` gets a real
 * directory from the terminal, so we must resolve it the same way or we would
 * report "not logged in" for a correctly configured project.
 */
export function expandHome(value: string, baseDir?: string): string {
  let out = value.trim();

  out = out.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? '');
  out = out.replace(/\$\{userHome\}/g, os.homedir());
  if (baseDir) {
    out = out.replace(/\$\{workspaceFolder\}/g, baseDir);
    out = out.replace(/\$\{workspaceFolderBasename\}/g, path.basename(baseDir));
  }
  if (out.startsWith('~')) {
    out = path.join(os.homedir(), out.slice(1));
  }
  out = out.replace(/\$\{?HOME\}?/g, os.homedir());

  // Resolve any still-relative path against the project, never process.cwd(),
  // which for an extension host is the editor's install directory.
  return path.isAbsolute(out) ? path.normalize(out) : path.resolve(baseDir ?? os.homedir(), out);
}

/** Collapse the home prefix back to `~` for display. */
export function tilde(value: string): string {
  const home = os.homedir();
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

/** True when CLAUDE_CONFIG_DIR was actually set, rather than us falling back. */
export function isExplicitDir(source: ConfigDirSource): boolean {
  return source !== 'default';
}

/**
 * How to name a credential store in the UI.
 *
 * Never render the implicit default as a bare `~/.claude`: an explicit
 * `CLAUDE_CONFIG_DIR=~/.claude` is a *different* store from leaving the variable
 * unset, and conflating them is the trap this extension exists to expose.
 */
export function storeLabel(snapshot: AccountSnapshot): string {
  return isExplicitDir(snapshot.source)
    ? tilde(snapshot.configDir)
    : `Default store (${CONFIG_DIR_VAR} unset)`;
}

/**
 * Candidate locations of the account file.
 *
 * Unset uses the legacy `~/.claude.json`; an explicit value — even the default
 * path — selects `<dir>/.claude.json`. Verified against `claude auth status`,
 * which reports a logged-in account with the variable unset and none with it set
 * to `~/.claude`.
 */
function accountFileCandidates(configDir: string, explicit: boolean): string[] {
  const candidates = [path.join(configDir, '.claude.json')];
  if (!explicit) {
    candidates.push(path.join(os.homedir(), '.claude.json'));
  }
  return candidates;
}

/** Files whose contents feed a snapshot — watch these to know when to re-read. */
export function watchTargets(configDir: string, explicit: boolean): string[] {
  return [
    ...accountFileCandidates(configDir, explicit),
    path.join(configDir, '.credentials.json'),
  ];
}

// ---------------------------------------------------------------------------
// Live verification via the Claude Code CLI
// ---------------------------------------------------------------------------

/** Shape of `claude auth status --json`. */
export interface CliStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  /** Present when an API key env var supersedes the OAuth login. */
  apiKeySource?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
}

const CLI_CANDIDATES = [
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  path.join(os.homedir(), '.claude', 'local', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  path.join(os.homedir(), '.bun', 'bin', 'claude'),
  path.join(os.homedir(), '.volta', 'bin', 'claude'),
];

/**
 * An extension host does not get the user's shell PATH, so `claude` by name
 * often fails to resolve. Prefer a known absolute install path, then any nvm
 * install, and fall back to PATH resolution.
 */
export function resolveClaudePath(configured?: string): string {
  if (configured && configured.trim()) {
    const explicit = expandHome(configured);
    if (fs.existsSync(explicit)) {
      return explicit;
    }
  }

  const direct = CLI_CANDIDATES.find(candidate => fs.existsSync(candidate));
  if (direct) {
    return direct;
  }

  // nvm keeps one bin dir per installed node version; take the newest that has it.
  const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    const fromNvm = fs
      .readdirSync(nvmRoot)
      .sort()
      .reverse()
      .map(version => path.join(nvmRoot, version, 'bin', 'claude'))
      .find(candidate => fs.existsSync(candidate));
    if (fromNvm) {
      return fromNvm;
    }
  } catch {
    // No nvm installation; fall through to PATH.
  }

  return 'claude';
}

export interface CliResult {
  status?: CliStatus;
  error?: string;
}

/**
 * Build the environment a Claude process should run under for a given store.
 *
 * `null` unsets the variable: VS Code's TerminalOptions.env drops any key whose
 * merged value is not a string, and for execFile we delete it outright. This is
 * what makes "the implicit default store" reachable rather than silently
 * becoming an explicit `~/.claude`.
 */
export function storeEnv(
  configDir: string | undefined,
  extra: Record<string, string> = {}
): Record<string, string | null> {
  return { ...extra, [CONFIG_DIR_VAR]: configDir ?? null };
}

/**
 * Ask the CLI who it is for a given store. This is the authoritative answer: it
 * is the same code path a real `claude` run uses, so it reflects the live
 * Keychain rather than derived on-disk state.
 *
 * `configDir === undefined` means "the variable is unset", which is a distinct
 * store from any explicit path.
 */
export function verifyWithCli(
  claudePath: string,
  configDir: string | undefined,
  env: Record<string, string>,
  cwd?: string
): Promise<CliResult> {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
  if (configDir === undefined) {
    delete childEnv[CONFIG_DIR_VAR];
  } else {
    childEnv[CONFIG_DIR_VAR] = configDir;
  }

  return new Promise(resolve => {
    execFile(
      claudePath,
      ['auth', 'status', '--json'],
      {
        env: childEnv,
        cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
        timeout: 8000,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const text = (stdout ?? '').trim();
        if (text) {
          try {
            resolve({ status: JSON.parse(text) as CliStatus });
            return;
          } catch {
            // Fall through to the error path below.
          }
        }
        const detail = (stderr ?? '').trim() || err?.message || 'no output';
        resolve({ error: `\`claude auth status\` failed: ${detail}` });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Account snapshot
// ---------------------------------------------------------------------------

export interface OnDiskAccount {
  email?: string;
  organizationName?: string;
}

export type ConfigDirSource =
  | 'process env'
  | 'workspace settings (terminal)'
  | 'workspace settings (sidebar)'
  | 'default';

/**
 * Three genuinely different states, rather than two optionals that callers have
 * to disambiguate with nested ternaries.
 */
export type Verification =
  | { kind: 'skipped' }
  | { kind: 'failed'; error: string }
  | { kind: 'ok'; status: CliStatus };

export interface AccountSnapshot {
  configDir: string;
  source: ConfigDirSource;
  /** The file the on-disk account was read from, if any. */
  accountFile: string | null;
  /** Account as recorded on disk at login time. */
  account: OnDiskAccount | null;
  /** Path of an on-disk credentials file (macOS normally uses the Keychain). */
  credentialsFile: string | null;
  /** Set only when no candidate file yielded a usable account. */
  error?: string;
  readAt: Date;
  verification: Verification;
}

export function readAccount(configDir: string, source: ConfigDirSource): AccountSnapshot {
  const snapshot: AccountSnapshot = {
    configDir,
    source,
    accountFile: null,
    account: null,
    credentialsFile: null,
    readAt: new Date(),
    verification: { kind: 'skipped' },
  };

  // Keep looking until a candidate actually yields an account. A config dir can
  // hold a `.claude.json` containing only first-run bookkeeping and no
  // `oauthAccount`; stopping at the first readable file would mask a real
  // account in a later candidate.
  const parseFailures: string[] = [];
  for (const candidate of accountFileCandidates(configDir, isExplicitDir(source))) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, 'utf-8');
    } catch {
      continue;
    }

    snapshot.accountFile ??= candidate;
    try {
      const oauth = JSON.parse(raw)?.oauthAccount;
      if (oauth && typeof oauth === 'object' && oauth.emailAddress) {
        snapshot.account = {
          email: oauth.emailAddress,
          organizationName: oauth.organizationName,
        };
        snapshot.accountFile = candidate;
        break;
      }
    } catch (err) {
      parseFailures.push(`${tilde(candidate)}: ${(err as Error).message}`);
    }
  }
  // A parse failure only matters if nothing else produced an account; otherwise
  // it would paint a red error icon on a perfectly good reading.
  if (!snapshot.account && parseFailures.length > 0) {
    snapshot.error = `Could not parse ${parseFailures.join('; ')}`;
  }

  const credentials = path.join(configDir, '.credentials.json');
  if (fs.existsSync(credentials)) {
    snapshot.credentialsFile = credentials;
  }

  return snapshot;
}

/** True when the live CLI answered — i.e. this is not a guess from disk. */
export function isVerified(snapshot: AccountSnapshot): boolean {
  return snapshot.verification.kind === 'ok';
}

export function cliStatus(snapshot: AccountSnapshot): CliStatus | undefined {
  return snapshot.verification.kind === 'ok' ? snapshot.verification.status : undefined;
}

export function cliError(snapshot: AccountSnapshot): string | undefined {
  return snapshot.verification.kind === 'failed' ? snapshot.verification.error : undefined;
}

/** The account in effect, preferring the live CLI answer over on-disk state. */
export function effectiveEmail(snapshot: AccountSnapshot): string | undefined {
  const status = cliStatus(snapshot);
  return status ? status.email : snapshot.account?.email;
}

export function effectiveOrg(snapshot: AccountSnapshot): string | undefined {
  const status = cliStatus(snapshot);
  return status ? status.orgName : snapshot.account?.organizationName;
}

/**
 * Authenticated in any form. Deliberately independent of whether an email is
 * attached, because API-key auth reports `loggedIn: true` with no email and must
 * not be mistaken for signed out.
 */
export function isLoggedIn(snapshot: AccountSnapshot): boolean {
  const status = cliStatus(snapshot);
  return status ? status.loggedIn : !!snapshot.account?.email;
}

/** True when an API key is superseding any OAuth login. */
export function usesApiKey(snapshot: AccountSnapshot): boolean {
  return !!cliStatus(snapshot)?.apiKeySource;
}

// ---------------------------------------------------------------------------
// Expected-account assertion
// ---------------------------------------------------------------------------

export type Verdict =
  | 'correct'
  | 'wrong'
  | 'not-logged-in'
  | 'api-key'
  | 'no-expectation'
  | 'unverified';

/**
 * Compare the account in effect against what the user pinned for this project.
 * `expected` accepts an exact email or a `*@domain` wildcard.
 */
export function matchesExpected(email: string | undefined, expected: string): boolean {
  if (!email) {
    return false;
  }
  const actual = email.trim().toLowerCase();
  const want = expected.trim().toLowerCase();
  if (!want) {
    return false;
  }
  if (want.includes('*')) {
    const pattern = new RegExp(
      `^${want
        .split('*')
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`
    );
    return pattern.test(actual);
  }
  return actual === want;
}

export function verdictFor(snapshot: AccountSnapshot, expected: string | undefined): Verdict {
  // A failed CLI check must never masquerade as a confident answer. On macOS
  // credentials live in the Keychain and <dir>/.claude.json often has no
  // oauthAccount, so a claude binary we could not spawn would otherwise render
  // as a confident "not logged in" for a fully signed-in user.
  if (snapshot.verification.kind === 'failed') {
    return 'unverified';
  }
  if (!isLoggedIn(snapshot)) {
    return 'not-logged-in';
  }
  if (!expected || !expected.trim()) {
    return 'no-expectation';
  }
  // An API key supersedes the login, so the pinned expectation cannot be
  // satisfied — the one case where the wrong account silently costs money.
  if (usesApiKey(snapshot) || !effectiveEmail(snapshot)) {
    return 'api-key';
  }
  if (!isVerified(snapshot)) {
    return 'unverified';
  }
  return matchesExpected(effectiveEmail(snapshot), expected) ? 'correct' : 'wrong';
}

/** Worst-first ordering, used to pick which consumer drives the headline. */
const VERDICT_RANK: Record<Verdict, number> = {
  'api-key': 5,
  wrong: 4,
  'not-logged-in': 3,
  unverified: 2,
  'no-expectation': 1,
  correct: 0,
};

// ---------------------------------------------------------------------------
// settings.json reading
// ---------------------------------------------------------------------------

/**
 * We read `.vscode/settings.json` off disk rather than through
 * `workspace.getConfiguration`, because `claudeCode.environmentVariables` is
 * declared machine-scoped: VS Code hides workspace-level values for such
 * settings from the configuration API, so the API cannot tell us whether the
 * file declares one.
 */
export type WorkspaceEnvOverrides =
  | { kind: 'absent'; file: null; terminalEnv: Record<string, string>; sidebarEnv: Record<string, string> }
  | { kind: 'parsed'; file: string; terminalEnv: Record<string, string>; sidebarEnv: Record<string, string> }
  | { kind: 'unreadable'; file: string; error: string; terminalEnv: Record<string, string>; sidebarEnv: Record<string, string> };

export const PLATFORM_KEY =
  process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';

export const TERMINAL_ENV_PATH = ['terminal', 'integrated', 'env', PLATFORM_KEY];
export const SIDEBAR_ENV_PATH = ['claudeCode', 'environmentVariables'];

export function parseJsonc(text: string): { value: unknown; error?: string } {
  const errors: jsonc.ParseError[] = [];
  const value = jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    const line = text.slice(0, first.offset).split('\n').length;
    return { value, error: `${jsonc.printParseErrorCode(first.error)} at line ${line}` };
  }
  return { value };
}

/**
 * Look up a dotted setting path, tolerating any mix of flattened and nested
 * keys — `"terminal.integrated.env.osx"` and a nested `terminal` object are
 * both valid in settings.json.
 */
export function deepGet(obj: unknown, segments: string[]): unknown {
  if (segments.length === 0) {
    return obj;
  }
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  const record = obj as Record<string, unknown>;
  for (let i = segments.length; i > 0; i--) {
    const key = segments.slice(0, i).join('.');
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      const found = deepGet(record[key], segments.slice(i));
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

/**
 * Normalize an environment block to a plain map.
 *
 * The two blocks we care about are shaped differently:
 * `terminal.integrated.env.<platform>` is a `{ NAME: value }` map, while
 * `claudeCode.environmentVariables` is an array of `{ name, value }` (confirmed
 * against the Claude Code extension manifest, where it is also machine-scoped).
 * Both shapes are accepted so a hand-edited settings.json is still understood.
 */
export function normalizeEnvBlock(block: unknown): Record<string, string> {
  const out: Record<string, string> = {};

  if (Array.isArray(block)) {
    for (const item of block) {
      if (item && typeof item === 'object') {
        const { name, value } = item as Record<string, unknown>;
        if (typeof name === 'string' && typeof value === 'string') {
          out[name] = value;
        }
      }
    }
  } else if (block && typeof block === 'object') {
    for (const [name, value] of Object.entries(block as Record<string, unknown>)) {
      if (typeof value === 'string') {
        out[name] = value;
      }
    }
  }

  return out;
}

export function readWorkspaceEnvOverrides(workspaceRoot: string | undefined): WorkspaceEnvOverrides {
  const empty = { terminalEnv: {}, sidebarEnv: {} };
  if (!workspaceRoot) {
    return { kind: 'absent', file: null, ...empty };
  }

  const file = path.join(workspaceRoot, '.vscode', 'settings.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { kind: 'absent', file: null, ...empty };
  }

  const { value, error } = parseJsonc(raw);
  if (error) {
    return { kind: 'unreadable', file, error: `Could not parse ${tilde(file)}: ${error}`, ...empty };
  }

  return {
    kind: 'parsed',
    file,
    terminalEnv: normalizeEnvBlock(deepGet(value, TERMINAL_ENV_PATH)),
    sidebarEnv: normalizeEnvBlock(deepGet(value, SIDEBAR_ENV_PATH)),
  };
}

export interface SettingsProblem {
  file: string;
  error: string;
}

/**
 * Claude Code's own settings files can set an `env` block too, which is another
 * way an API key silently supersedes a logged-in account.
 */
export function apiKeyVarsInSettingsFiles(
  workspaceRoot: string | undefined,
  configDir: string
): { found: { file: string; variable: string }[]; problems: SettingsProblem[] } {
  const files = [
    workspaceRoot ? path.join(workspaceRoot, '.claude', 'settings.json') : undefined,
    workspaceRoot ? path.join(workspaceRoot, '.claude', 'settings.local.json') : undefined,
    path.join(configDir, 'settings.json'),
  ].filter((value): value is string => value !== undefined);

  const found: { file: string; variable: string }[] = [];
  const problems: SettingsProblem[] = [];

  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const { value, error } = parseJsonc(raw);
    if (error) {
      // Nothing else surfaces these three files, so report rather than swallow.
      problems.push({ file, error });
      continue;
    }
    const env = normalizeEnvBlock(deepGet(value, ['env']));
    const variable = API_KEY_VARS.find(name => env[name]);
    if (variable) {
      found.push({ file, variable });
    }
  }

  return { found, problems };
}

// ---------------------------------------------------------------------------
// Resolution: who reads which store
// ---------------------------------------------------------------------------

export type ConsumerKind = 'terminal' | 'sidebar' | 'extensionHost';

export interface ResolvedConsumer {
  kind: ConsumerKind;
  /** Display name of the thing that would use this account. */
  name: string;
  snapshot: AccountSnapshot;
  /** Env applied on top of the process env when this consumer runs Claude. */
  env: Record<string, string>;
  caveat?: string;
  /**
   * True for rows that are context, not a real Claude Code consumer. The
   * extension host never inherits workspace settings, so its store legitimately
   * differs and must not count as a mismatch.
   */
  diagnosticOnly?: boolean;
  /**
   * True when this row's value comes from a machine-scoped setting declared at
   * workspace level, which VS Code may ignore.
   */
  machineScoped?: boolean;
}

export interface WindowState {
  workspaceRoot: string | undefined;
  overrides: WorkspaceEnvOverrides;
  /** The config dir this extension host process actually sees. */
  processConfigDir: string | undefined;
  consumers: ResolvedConsumer[];
  /** API key env vars visible to this process, which override any login. */
  processApiKeyVars: string[];
  /** API keys declared in settings files, which also override any login. */
  settingsApiKeys: { file: string; variable: string }[];
  settingsProblems: SettingsProblem[];
  /** The account this project is supposed to use, if pinned. */
  expectedAccount?: string;
  /** Where that pin lives, so the UI can explain how to change it. */
  expectedAccountSource?: 'settings' | 'machine';
  /** True when the folder itself declares no CLAUDE_CONFIG_DIR. */
  isolated: boolean;
  /**
   * Version-control state of the folder's `.vscode/settings.json`. A tracked,
   * unmasked file means any CLAUDE_CONFIG_DIR written there is a repo change
   * your teammates would receive.
   */
  settingsTracking: TrackingState;
}

/** Store identity: a dir plus whether the variable is set at all. */
export function storeKey(snapshot: AccountSnapshot): string {
  return `${isExplicitDir(snapshot.source)}|${snapshot.configDir}`;
}

function snapshotFor(explicit: string | undefined, source: ConfigDirSource, baseDir?: string): AccountSnapshot {
  return explicit
    ? readAccount(expandHome(explicit, baseDir), source)
    : readAccount(DEFAULT_CONFIG_DIR, 'default');
}

export interface ReadOptions {
  expectedAccount?: string;
  expectedAccountSource?: 'settings' | 'machine';
  /**
   * The `claudeCode.environmentVariables` value as the configuration API reports
   * it — which, because the setting is machine-scoped, is what VS Code actually
   * hands the Claude Code sidebar.
   */
  effectiveSidebarEnv?: Record<string, string>;
  /** Whether the Claude Code extension is installed at all. */
  claudeCodeInstalled?: boolean;
}

export function readWindowState(
  workspaceRoot: string | undefined,
  options: ReadOptions = {}
): WindowState {
  const overrides = readWorkspaceEnvOverrides(workspaceRoot);
  const processConfigDir = process.env[CONFIG_DIR_VAR]?.trim() || undefined;

  const terminalDir = overrides.terminalEnv[CONFIG_DIR_VAR];
  const declaredSidebarDir = overrides.sidebarEnv[CONFIG_DIR_VAR];
  // Prefer what VS Code actually resolves for the sidebar over what the file
  // declares; a machine-scoped setting declared at workspace level may be ignored.
  const sidebarEnv = options.effectiveSidebarEnv ?? overrides.sidebarEnv;
  const sidebarDir = sidebarEnv[CONFIG_DIR_VAR];

  const processSnapshot = snapshotFor(processConfigDir, 'process env', workspaceRoot);
  const terminalSnapshot = terminalDir
    ? snapshotFor(terminalDir, 'workspace settings (terminal)', workspaceRoot)
    : snapshotFor(processConfigDir, 'process env', workspaceRoot);
  const sidebarSnapshot = sidebarDir
    ? snapshotFor(sidebarDir, 'workspace settings (sidebar)', workspaceRoot)
    : snapshotFor(processConfigDir, 'process env', workspaceRoot);

  const declaredButIgnored =
    declaredSidebarDir !== undefined && declaredSidebarDir !== sidebarDir;

  const consumers: ResolvedConsumer[] = [
    {
      kind: 'terminal',
      name: 'Terminal',
      snapshot: terminalSnapshot,
      env: overrides.terminalEnv,
      caveat: terminalDir
        ? undefined
        : 'No terminal.integrated.env override — inherits the process environment.',
    },
    {
      kind: 'sidebar',
      name: 'Sidebar',
      snapshot: sidebarSnapshot,
      env: sidebarEnv,
      machineScoped: declaredSidebarDir !== undefined,
      diagnosticOnly: options.claudeCodeInstalled === false,
      caveat: declaredButIgnored
        ? `This folder declares ${declaredSidebarDir} but VS Code is ignoring it — claudeCode.environmentVariables is machine-scoped, so only a user-level value applies. The sidebar will use ${sidebarDir ?? 'the default store'}.`
        : declaredSidebarDir
          ? 'Declared at workspace level. claudeCode.environmentVariables is machine-scoped, so VS Code may ignore it after a reload.'
          : 'No claudeCode.environmentVariables override — inherits the process environment.',
    },
    {
      kind: 'extensionHost',
      name: 'Extension host',
      snapshot: processSnapshot,
      env: {},
      diagnosticOnly: true,
      caveat:
        'Shown for context only. An extension host does not inherit terminal.integrated.env, so this row differing from the others is normal.',
    },
  ];

  const apiKeys = apiKeyVarsInSettingsFiles(workspaceRoot, terminalSnapshot.configDir);
  const settingsApiKeys = [
    ...apiKeys.found,
    ...(overrides.file
      ? API_KEY_VARS.filter(
          name => overrides.terminalEnv[name] || overrides.sidebarEnv[name]
        ).map(variable => ({ file: overrides.file as string, variable }))
      : []),
  ];

  return {
    workspaceRoot,
    overrides,
    processConfigDir,
    consumers,
    processApiKeyVars: API_KEY_VARS.filter(name => (process.env[name] ?? '') !== ''),
    settingsApiKeys,
    settingsProblems: apiKeys.problems,
    expectedAccount: options.expectedAccount,
    expectedAccountSource: options.expectedAccountSource,
    isolated: terminalDir !== undefined || declaredSidebarDir !== undefined,
    settingsTracking: workspaceRoot
      ? trackingState(path.join(workspaceRoot, '.vscode', 'settings.json'))
      : 'untracked',
  };
}

/** Attach live CLI answers to every consumer, one call per distinct store+env. */
export async function verifyWindowState(state: WindowState, claudePath: string): Promise<void> {
  const byKey = new Map<string, ResolvedConsumer[]>();
  for (const consumer of state.consumers) {
    const explicit = isExplicitDir(consumer.snapshot.source);
    const key = JSON.stringify([explicit ? consumer.snapshot.configDir : null, consumer.env]);
    const group = byKey.get(key);
    if (group) {
      group.push(consumer);
    } else {
      byKey.set(key, [consumer]);
    }
  }

  await Promise.all(
    [...byKey.values()].map(async group => {
      const { snapshot, env } = group[0];
      const result = await verifyWithCli(
        claudePath,
        isExplicitDir(snapshot.source) ? snapshot.configDir : undefined,
        env,
        state.workspaceRoot
      );
      const verification: Verification = result.status
        ? { kind: 'ok', status: result.status }
        : { kind: 'failed', error: result.error ?? 'unknown error' };
      for (const consumer of group) {
        consumer.snapshot.verification = verification;
      }
    })
  );
}

/** The account a `claude` run in the integrated terminal would use. */
export function primaryConsumer(state: WindowState): ResolvedConsumer {
  return state.consumers.find(c => c.kind === 'terminal') ?? state.consumers[0];
}

export function realConsumers(state: WindowState): ResolvedConsumer[] {
  return state.consumers.filter(c => !c.diagnosticOnly);
}

/**
 * True when two real Claude Code consumers would resolve different stores — i.e.
 * the terminal and the sidebar can be signed in as different accounts.
 */
export function hasConsumerMismatch(state: WindowState): boolean {
  const keys = new Set(
    realConsumers(state).map(c => `${storeKey(c.snapshot)}|${effectiveEmail(c.snapshot) ?? ''}`)
  );
  return keys.size > 1;
}

/**
 * The consumer whose verdict should drive the headline.
 *
 * Only escalates past the terminal when an expectation is pinned: with nothing
 * to be wrong about, ranking another consumer's `not-logged-in` above the
 * terminal's `no-expectation` would just be noise.
 */
export function worstConsumer(state: WindowState): ResolvedConsumer {
  const primary = primaryConsumer(state);
  if (!state.expectedAccount) {
    return primary;
  }
  let worst = primary;
  let worstRank = VERDICT_RANK[verdictFor(primary.snapshot, state.expectedAccount)];
  for (const consumer of realConsumers(state)) {
    const rank = VERDICT_RANK[verdictFor(consumer.snapshot, state.expectedAccount)];
    if (rank > worstRank) {
      worst = consumer;
      worstRank = rank;
    }
  }
  return worst;
}

export function windowVerdict(state: WindowState): Verdict {
  return verdictFor(worstConsumer(state).snapshot, state.expectedAccount);
}

// ---------------------------------------------------------------------------
// Cross-project isolation audit
// ---------------------------------------------------------------------------

export interface ProjectAudit {
  name: string;
  root: string;
  snapshot: AccountSnapshot;
  /** Other project names sharing the same store. */
  sharesWith: string[];
}

const SCAN_LIMIT = 60;
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'build', 'Library']);

export function auditProjects(projectsRoot: string): ProjectAudit[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const audits: ProjectAudit[] = [];
  for (const entry of entries) {
    if (audits.length >= SCAN_LIMIT) {
      break;
    }
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) {
      continue;
    }

    const root = path.join(projectsRoot, entry.name);
    const overrides = readWorkspaceEnvOverrides(root);
    const declared = overrides.terminalEnv[CONFIG_DIR_VAR] ?? overrides.sidebarEnv[CONFIG_DIR_VAR];
    if (!declared) {
      continue;
    }

    audits.push({
      name: entry.name,
      root,
      // Resolve relative to the audited project, not the current one.
      snapshot: readAccount(expandHome(declared, root), 'workspace settings (terminal)'),
      sharesWith: [],
    });
  }

  // Two projects pointing at one store share a login — that is the thing the
  // audit exists to catch.
  for (const audit of audits) {
    audit.sharesWith = audits
      .filter(other => other !== audit && other.snapshot.configDir === audit.snapshot.configDir)
      .map(other => other.name);
  }

  return audits.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every credential store we can find: those in use by this window, those any
 * sibling project declares, and any `~/.claude-*` directory sitting on disk.
 */
export function discoverStores(
  state: WindowState,
  projectsRoot: string | undefined
): { configDir: string | undefined; snapshot: AccountSnapshot; usedBy: string[] }[] {
  const byKey = new Map<string, { configDir: string | undefined; snapshot: AccountSnapshot; usedBy: string[] }>();

  const add = (snapshot: AccountSnapshot, usedBy?: string) => {
    const key = storeKey(snapshot);
    const existing = byKey.get(key);
    if (existing) {
      // Prefer a verified snapshot over a disk-only one.
      if (!isVerified(existing.snapshot) && isVerified(snapshot)) {
        existing.snapshot = snapshot;
      }
      if (usedBy && !existing.usedBy.includes(usedBy)) {
        existing.usedBy.push(usedBy);
      }
      return;
    }
    byKey.set(key, {
      configDir: isExplicitDir(snapshot.source) ? snapshot.configDir : undefined,
      snapshot,
      usedBy: usedBy ? [usedBy] : [],
    });
  };

  for (const consumer of realConsumers(state)) {
    add(consumer.snapshot);
  }

  if (projectsRoot) {
    for (const audit of auditProjects(projectsRoot)) {
      add(audit.snapshot, audit.name);
    }
  }

  try {
    for (const entry of fs.readdirSync(os.homedir(), { withFileTypes: true })) {
      if (entry.isDirectory() && /^\.claude[-_]/.test(entry.name)) {
        add(readAccount(path.join(os.homedir(), entry.name), 'workspace settings (terminal)'));
      }
    }
  } catch {
    // Home unreadable; the consumers above are still enough to choose from.
  }

  return [...byKey.values()];
}
