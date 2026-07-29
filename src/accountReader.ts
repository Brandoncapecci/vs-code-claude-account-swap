import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/**
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

export function expandHome(value: string): string {
  let out = value.trim();
  if (out.startsWith('~')) {
    out = path.join(os.homedir(), out.slice(1));
  }
  out = out.replace(/\$\{?HOME\}?/g, os.homedir());
  return path.resolve(out);
}

/** Collapse the home prefix back to `~` for display. */
export function tilde(value: string): string {
  const home = os.homedir();
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

/**
 * Candidate locations of the account file.
 *
 * Leaving CLAUDE_CONFIG_DIR unset is NOT the same as setting it to `~/.claude`:
 * unset uses the legacy `~/.claude.json` and a Keychain entry keyed for the
 * default, while an explicit value — even the default path — selects a separate
 * store at `<dir>/.claude.json`. Verified against `claude auth status`, which
 * reports a logged-in account with the var unset and none with it set to
 * `~/.claude`. So the legacy path is only a candidate when nothing is set.
 */
function accountFileCandidates(configDir: string, explicit: boolean): string[] {
  const candidates = [path.join(configDir, '.claude.json')];
  if (!explicit) {
    candidates.push(path.join(os.homedir(), '.claude.json'));
  }
  return candidates;
}

/** True when CLAUDE_CONFIG_DIR was actually set, rather than us falling back. */
export function isExplicitDir(source: ConfigDirSource): boolean {
  return source !== 'default';
}

/** Files whose contents feed a snapshot — watch these to know when to re-read. */
export function watchTargets(configDir: string): string[] {
  return [
    ...accountFileCandidates(configDir, false),
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
];

/**
 * An extension host does not get the user's shell PATH, so `claude` by name
 * often fails to resolve. Prefer a known absolute install path, and fall back to
 * PATH resolution.
 */
export function resolveClaudePath(configured?: string): string {
  if (configured && configured.trim()) {
    const explicit = expandHome(configured);
    if (fs.existsSync(explicit)) {
      return explicit;
    }
  }
  return CLI_CANDIDATES.find(candidate => fs.existsSync(candidate)) ?? 'claude';
}

export interface CliResult {
  status?: CliStatus;
  error?: string;
}

/**
 * Ask the CLI who it is for a given config dir. This is the authoritative
 * answer: it is the same code path a real `claude` run uses, so it reflects the
 * live Keychain rather than derived on-disk state.
 */
export function verifyWithCli(
  claudePath: string,
  configDir: string | undefined,
  env: Record<string, string>,
  cwd?: string
): Promise<CliResult> {
  // configDir === undefined means "nothing was set", which is a distinct store
  // from any explicit path. The var must be absent, not set to the default.
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
        timeout: 20000,
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
// On-disk account (fallback when the CLI is unavailable)
// ---------------------------------------------------------------------------

export interface Account {
  email?: string;
  organizationName?: string;
  organizationRole?: string;
  workspaceRole?: string;
  accountUuid?: string;
  organizationUuid?: string;
}

export type ConfigDirSource =
  | 'process env'
  | 'workspace settings (terminal)'
  | 'workspace settings (sidebar)'
  | 'default';

export interface AccountSnapshot {
  configDir: string;
  source: ConfigDirSource;
  /** The file the on-disk account was read from, if any. */
  accountFile: string | null;
  /** Account as recorded on disk at login time. */
  account: Account | null;
  /** Path of an on-disk credentials file (macOS normally uses the Keychain). */
  credentialsFile: string | null;
  error?: string;
  readAt: Date;
  /** Live CLI answer. Absent until verification runs or if it failed. */
  cli?: CliStatus;
  cliError?: string;
}

export function readAccount(configDir: string, source: ConfigDirSource): AccountSnapshot {
  const snapshot: AccountSnapshot = {
    configDir,
    source,
    accountFile: null,
    account: null,
    credentialsFile: null,
    readAt: new Date(),
  };

  // Keep looking until a candidate actually yields an account. A config dir can
  // hold a `.claude.json` containing only first-run bookkeeping and no
  // `oauthAccount`; stopping at the first readable file would then mask a real
  // account in a later candidate.
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
          organizationRole: oauth.organizationRole,
          workspaceRole: oauth.workspaceRole,
          accountUuid: oauth.accountUuid,
          organizationUuid: oauth.organizationUuid,
        };
        snapshot.accountFile = candidate;
        break;
      }
    } catch (err) {
      snapshot.error = `Could not parse ${tilde(candidate)}: ${(err as Error).message}`;
    }
  }

  const credentials = path.join(configDir, '.credentials.json');
  if (fs.existsSync(credentials)) {
    snapshot.credentialsFile = credentials;
  }

  return snapshot;
}

/** True when the live CLI answered — i.e. this is not a guess from disk. */
export function isVerified(snapshot: AccountSnapshot): boolean {
  return snapshot.cli !== undefined;
}

/** The account in effect, preferring the live CLI answer over on-disk state. */
export function effectiveEmail(snapshot: AccountSnapshot): string | undefined {
  return snapshot.cli ? snapshot.cli.email : snapshot.account?.email;
}

export function effectiveOrg(snapshot: AccountSnapshot): string | undefined {
  return snapshot.cli ? snapshot.cli.orgName : snapshot.account?.organizationName;
}

export function isLoggedIn(snapshot: AccountSnapshot): boolean {
  if (snapshot.cli) {
    return snapshot.cli.loggedIn && !!snapshot.cli.email;
  }
  return !!snapshot.account?.email;
}

// ---------------------------------------------------------------------------
// Expected-account assertion
// ---------------------------------------------------------------------------

export type Verdict = 'correct' | 'wrong' | 'not-logged-in' | 'no-expectation' | 'unverified';

/**
 * Compare the account in effect against what the user declared for this
 * project. `expected` accepts an exact email or a `*@domain` wildcard.
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
      `^${want.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`
    );
    return pattern.test(actual);
  }
  return actual === want;
}

export function judge(snapshot: AccountSnapshot, expected: string | undefined): Verdict {
  if (!isLoggedIn(snapshot)) {
    return 'not-logged-in';
  }
  if (!expected || !expected.trim()) {
    return 'no-expectation';
  }
  if (!isVerified(snapshot)) {
    return 'unverified';
  }
  return matchesExpected(effectiveEmail(snapshot), expected) ? 'correct' : 'wrong';
}

// ---------------------------------------------------------------------------
// .vscode/settings.json parsing
// ---------------------------------------------------------------------------

/**
 * We read `.vscode/settings.json` off disk rather than through
 * `workspace.getConfiguration`, because `claudeCode.environmentVariables` is
 * declared machine-scoped: VS Code hides workspace-level values for such
 * settings from the configuration API, so the API cannot tell us whether the
 * file declares one.
 */
export interface WorkspaceEnvOverrides {
  file: string | null;
  /** Normalized `terminal.integrated.env.<platform>` block. */
  terminalEnv: Record<string, string>;
  /** Normalized `claudeCode.environmentVariables` block. */
  sidebarEnv: Record<string, string>;
  error?: string;
}

const PLATFORM_KEY =
  process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';

export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }

  return out;
}

export function removeTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inString) {
      out += c;
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ',') {
      const nextChar = text.slice(i + 1).replace(/^\s*/, '')[0];
      if (nextChar === '}' || nextChar === ']') {
        continue;
      }
    }
    out += c;
  }

  return out;
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(removeTrailingCommas(stripJsonComments(text)));
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
  const empty: WorkspaceEnvOverrides = { file: null, terminalEnv: {}, sidebarEnv: {} };
  if (!workspaceRoot) {
    return empty;
  }

  const file = path.join(workspaceRoot, '.vscode', 'settings.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return empty;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    return {
      ...empty,
      file,
      error: `Could not parse ${tilde(file)}: ${(err as Error).message}`,
    };
  }

  return {
    file,
    terminalEnv: normalizeEnvBlock(deepGet(parsed, ['terminal', 'integrated', 'env', PLATFORM_KEY])),
    sidebarEnv: normalizeEnvBlock(deepGet(parsed, ['claudeCode', 'environmentVariables'])),
  };
}

/**
 * Claude Code's own settings files can set an `env` block too, which is another
 * way an API key silently supersedes a logged-in account.
 */
export function apiKeyVarsInSettingsFiles(
  workspaceRoot: string | undefined,
  configDir: string
): { file: string; variable: string }[] {
  const files = [
    workspaceRoot ? path.join(workspaceRoot, '.claude', 'settings.json') : undefined,
    workspaceRoot ? path.join(workspaceRoot, '.claude', 'settings.local.json') : undefined,
    path.join(configDir, 'settings.json'),
  ].filter((value): value is string => value !== undefined);

  const found: { file: string; variable: string }[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    try {
      const env = normalizeEnvBlock(deepGet(parseJsonc(raw), ['env']));
      const variable = API_KEY_VARS.find(name => env[name]);
      if (variable) {
        found.push({ file, variable });
      }
    } catch {
      // A malformed settings file is surfaced elsewhere; skip it here.
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Resolution: who reads which config dir
// ---------------------------------------------------------------------------

export interface ResolvedConsumer {
  /** Display name of the thing that would use this account. */
  name: string;
  snapshot: AccountSnapshot;
  /** Env applied on top of the process env when this consumer runs Claude. */
  env: Record<string, string>;
  /** Set when the value is declared but VS Code may not honour it. */
  caveat?: string;
  /**
   * True for rows that are context, not a real Claude Code consumer. The
   * extension host never inherits workspace settings, so its config dir
   * legitimately differs and must not count as a mismatch.
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
  /** The account this project is supposed to use, if declared. */
  expectedAccount?: string;
}

function resolve(explicit: string | undefined, source: ConfigDirSource): AccountSnapshot {
  return explicit
    ? readAccount(expandHome(explicit), source)
    : readAccount(DEFAULT_CONFIG_DIR, 'default');
}

export function readWindowState(
  workspaceRoot: string | undefined,
  expectedAccount?: string
): WindowState {
  const overrides = readWorkspaceEnvOverrides(workspaceRoot);
  const processConfigDir = process.env[CONFIG_DIR_VAR]?.trim() || undefined;

  const terminalDir = overrides.terminalEnv[CONFIG_DIR_VAR];
  const sidebarDir = overrides.sidebarEnv[CONFIG_DIR_VAR];

  const processSnapshot = resolve(processConfigDir, 'process env');
  const terminalSnapshot = terminalDir
    ? resolve(terminalDir, 'workspace settings (terminal)')
    : resolve(processConfigDir, 'process env');
  const sidebarSnapshot = sidebarDir
    ? resolve(sidebarDir, 'workspace settings (sidebar)')
    : resolve(processConfigDir, 'process env');

  const consumers: ResolvedConsumer[] = [
    {
      name: 'Integrated terminal',
      snapshot: terminalSnapshot,
      env: overrides.terminalEnv,
      caveat: terminalDir
        ? undefined
        : 'No terminal.integrated.env override — inherits the process environment.',
    },
    {
      name: 'Claude Code sidebar',
      snapshot: sidebarSnapshot,
      env: overrides.sidebarEnv,
      machineScoped: sidebarDir !== undefined,
      caveat: sidebarDir
        ? 'claudeCode.environmentVariables is machine-scoped, so a workspace-level value may be ignored. If the sidebar disagrees after a window reload, that is what happened.'
        : 'No claudeCode.environmentVariables override — inherits the process environment.',
    },
    {
      name: 'This extension host',
      snapshot: processSnapshot,
      env: {},
      diagnosticOnly: true,
      caveat:
        'Shown for context only. An extension host does not inherit terminal.integrated.env, so this row differing from the others is normal.',
    },
  ];

  const settingsApiKeys = [
    ...apiKeyVarsInSettingsFiles(workspaceRoot, terminalSnapshot.configDir),
    ...API_KEY_VARS.filter(name => overrides.terminalEnv[name]).map(variable => ({
      file: overrides.file!,
      variable,
    })),
    ...API_KEY_VARS.filter(name => overrides.sidebarEnv[name]).map(variable => ({
      file: overrides.file!,
      variable,
    })),
  ];

  return {
    workspaceRoot,
    overrides,
    processConfigDir,
    consumers,
    processApiKeyVars: API_KEY_VARS.filter(name => (process.env[name] ?? '') !== ''),
    settingsApiKeys,
    expectedAccount,
  };
}

/** Attach live CLI answers to every consumer, one call per distinct config dir. */
export async function verifyWindowState(state: WindowState, claudePath: string): Promise<void> {
  const byKey = new Map<string, ResolvedConsumer[]>();
  for (const consumer of state.consumers) {
    const explicit = isExplicitDir(consumer.snapshot.source);
    const key = JSON.stringify([explicit ? consumer.snapshot.configDir : null, consumer.env]);
    const group = byKey.get(key);
    group ? group.push(consumer) : byKey.set(key, [consumer]);
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
      for (const consumer of group) {
        consumer.snapshot.cli = result.status;
        consumer.snapshot.cliError = result.error;
      }
    })
  );
}

/** The account a `claude` run in the integrated terminal would use. */
export function primaryConsumer(state: WindowState): ResolvedConsumer {
  return state.consumers[0];
}

/**
 * True when two real Claude Code consumers in this window would resolve
 * different config dirs — i.e. the terminal and the sidebar can be signed in as
 * different accounts. Diagnostic rows are excluded.
 */
export function hasConsumerMismatch(state: WindowState): boolean {
  const dirs = new Set(
    state.consumers.filter(c => !c.diagnosticOnly).map(c => c.snapshot.configDir)
  );
  return dirs.size > 1;
}

export function windowVerdict(state: WindowState): Verdict {
  return judge(primaryConsumer(state).snapshot, state.expectedAccount);
}

// ---------------------------------------------------------------------------
// Cross-project isolation audit
// ---------------------------------------------------------------------------

export interface ProjectAudit {
  name: string;
  root: string;
  /** Config dir declared in the project's .vscode/settings.json. */
  declaredConfigDir: string;
  snapshot: AccountSnapshot;
  /** Other project names sharing the same config dir. */
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
      declaredConfigDir: declared,
      snapshot: readAccount(expandHome(declared), 'workspace settings (terminal)'),
      sharesWith: [],
    });
  }

  // Two projects pointing at one config dir share a login — that is the thing
  // the audit exists to catch.
  for (const audit of audits) {
    audit.sharesWith = audits
      .filter(other => other !== audit && other.snapshot.configDir === audit.snapshot.configDir)
      .map(other => other.name);
  }

  return audits.sort((a, b) => a.name.localeCompare(b.name));
}
