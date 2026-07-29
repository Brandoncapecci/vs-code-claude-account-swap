import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Everything in this file reads from disk on every call. Nothing is memoised.
 * That is the entire point of the extension: the Claude Code sidebar caches the
 * account it saw when the window started, while API calls read credentials live,
 * so a stale display can disagree with what requests actually use.
 */

export const CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR';
export const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

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
  /** Resolved absolute config dir. */
  configDir: string;
  /** Whether CLAUDE_CONFIG_DIR was explicitly set, and by whom. */
  source: ConfigDirSource;
  /** The file the account was actually read from, if any. */
  accountFile: string | null;
  account: Account | null;
  /** True when an oauth account with an email was found on disk. */
  loggedIn: boolean;
  /** Path of an on-disk credentials file, if one exists (macOS normally uses the Keychain). */
  credentialsFile: string | null;
  error?: string;
  readAt: Date;
}

export const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.claude');

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
 * Candidate locations of the account file for a config dir.
 *
 * With CLAUDE_CONFIG_DIR set, Claude Code keeps `.claude.json` inside that dir.
 * With it unset, the account lives at `~/.claude.json` alongside the `~/.claude` dir.
 */
function accountFileCandidates(configDir: string): string[] {
  const candidates = [path.join(configDir, '.claude.json')];
  if (path.resolve(configDir) === DEFAULT_CONFIG_DIR) {
    candidates.push(path.join(os.homedir(), '.claude.json'));
  }
  return candidates;
}

export function readAccount(configDir: string, source: ConfigDirSource): AccountSnapshot {
  const snapshot: AccountSnapshot = {
    configDir,
    source,
    accountFile: null,
    account: null,
    loggedIn: false,
    credentialsFile: null,
    readAt: new Date(),
  };

  for (const candidate of accountFileCandidates(configDir)) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, 'utf-8');
    } catch {
      continue;
    }

    snapshot.accountFile = candidate;
    try {
      const parsed = JSON.parse(raw);
      const oauth = parsed?.oauthAccount;
      if (oauth && typeof oauth === 'object') {
        snapshot.account = {
          email: oauth.emailAddress,
          organizationName: oauth.organizationName,
          organizationRole: oauth.organizationRole,
          workspaceRole: oauth.workspaceRole,
          accountUuid: oauth.accountUuid,
          organizationUuid: oauth.organizationUuid,
        };
        snapshot.loggedIn = typeof oauth.emailAddress === 'string' && oauth.emailAddress.length > 0;
      }
    } catch (err) {
      snapshot.error = `Could not parse ${tilde(candidate)}: ${(err as Error).message}`;
    }
    break;
  }

  const credentials = path.join(configDir, '.credentials.json');
  if (fs.existsSync(credentials)) {
    snapshot.credentialsFile = credentials;
  }

  return snapshot;
}

/** Files whose contents feed a snapshot — watch these to know when to re-read. */
export function watchTargets(configDir: string): string[] {
  return [...accountFileCandidates(configDir), path.join(configDir, '.credentials.json')];
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
  terminalConfigDir?: string;
  sidebarConfigDir?: string;
  terminalApiKeyVar?: string;
  sidebarApiKeyVar?: string;
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
      const rest = text.slice(i + 1);
      const nextChar = rest.replace(/^\s*/, '')[0];
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
 * Read one variable out of an environment block.
 *
 * The two blocks we care about are shaped differently:
 * `terminal.integrated.env.osx` is a `{ NAME: value }` map, while
 * `claudeCode.environmentVariables` is an array of `{ name, value }` (confirmed
 * against the Claude Code extension manifest). Both shapes are accepted here so
 * a hand-edited settings.json in either form is still understood.
 */
function envVar(block: unknown, name: string): string | undefined {
  let value: unknown;

  if (Array.isArray(block)) {
    const entry = block.find(
      item => item && typeof item === 'object' && (item as Record<string, unknown>).name === name
    );
    value = entry ? (entry as Record<string, unknown>).value : undefined;
  } else if (block && typeof block === 'object') {
    value = (block as Record<string, unknown>)[name];
  }

  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function firstApiKeyVar(block: unknown): string | undefined {
  return API_KEY_VARS.find(name => envVar(block, name) !== undefined);
}

export function readWorkspaceEnvOverrides(workspaceRoot: string | undefined): WorkspaceEnvOverrides {
  if (!workspaceRoot) {
    return { file: null };
  }

  const file = path.join(workspaceRoot, '.vscode', 'settings.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { file: null };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    return { file, error: `Could not parse ${tilde(file)}: ${(err as Error).message}` };
  }

  const terminalBlock = deepGet(parsed, ['terminal', 'integrated', 'env', PLATFORM_KEY]);
  const sidebarBlock = deepGet(parsed, ['claudeCode', 'environmentVariables']);

  return {
    file,
    terminalConfigDir: envVar(terminalBlock, CONFIG_DIR_VAR),
    sidebarConfigDir: envVar(sidebarBlock, CONFIG_DIR_VAR),
    terminalApiKeyVar: firstApiKeyVar(terminalBlock),
    sidebarApiKeyVar: firstApiKeyVar(sidebarBlock),
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
      const variable = firstApiKeyVar(deepGet(parseJsonc(raw), ['env']));
      if (variable) {
        found.push({ file, variable });
      }
    } catch {
      // A malformed settings file is reported elsewhere; skip it here.
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
}

function resolve(explicit: string | undefined, source: ConfigDirSource): AccountSnapshot {
  if (explicit) {
    return readAccount(expandHome(explicit), source);
  }
  return readAccount(DEFAULT_CONFIG_DIR, 'default');
}

export function readWindowState(workspaceRoot: string | undefined): WindowState {
  const overrides = readWorkspaceEnvOverrides(workspaceRoot);
  const processConfigDir = process.env[CONFIG_DIR_VAR]?.trim() || undefined;

  const processSnapshot = resolve(processConfigDir, 'process env');

  const terminalSnapshot = overrides.terminalConfigDir
    ? resolve(overrides.terminalConfigDir, 'workspace settings (terminal)')
    : processSnapshot;

  const sidebarSnapshot = overrides.sidebarConfigDir
    ? resolve(overrides.sidebarConfigDir, 'workspace settings (sidebar)')
    : processSnapshot;

  const consumers: ResolvedConsumer[] = [
    {
      name: 'Integrated terminal',
      snapshot: terminalSnapshot,
      caveat: overrides.terminalConfigDir
        ? undefined
        : 'No terminal.integrated.env override — inherits the process environment.',
    },
    {
      name: 'Claude Code sidebar',
      snapshot: sidebarSnapshot,
      machineScoped: overrides.sidebarConfigDir !== undefined,
      caveat: overrides.sidebarConfigDir
        ? 'claudeCode.environmentVariables is machine-scoped, so a workspace-level value may be ignored. Trust /status in the sidebar over this row.'
        : 'No claudeCode.environmentVariables override — inherits the process environment.',
    },
    {
      name: 'This extension host',
      snapshot: processSnapshot,
      diagnosticOnly: true,
      caveat:
        'Shown for context only. An extension host does not inherit terminal.integrated.env, so this row differing from the others is normal.',
    },
  ];

  const apiKeysFromSettings = [
    ...apiKeyVarsInSettingsFiles(workspaceRoot, terminalSnapshot.configDir),
    ...(overrides.terminalApiKeyVar && overrides.file
      ? [{ file: overrides.file, variable: overrides.terminalApiKeyVar }]
      : []),
    ...(overrides.sidebarApiKeyVar && overrides.file
      ? [{ file: overrides.file, variable: overrides.sidebarApiKeyVar }]
      : []),
  ];

  return {
    workspaceRoot,
    overrides,
    processConfigDir,
    consumers,
    processApiKeyVars: API_KEY_VARS.filter(name => (process.env[name] ?? '') !== ''),
    settingsApiKeys: apiKeysFromSettings,
  };
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

// ---------------------------------------------------------------------------
// Cross-project isolation audit
// ---------------------------------------------------------------------------

export interface ProjectAudit {
  name: string;
  root: string;
  /** Config dir declared in the project's .vscode/settings.json, if any. */
  declaredConfigDir?: string;
  snapshot?: AccountSnapshot;
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
    const declared = overrides.terminalConfigDir ?? overrides.sidebarConfigDir;
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
      .filter(other => other !== audit && other.snapshot?.configDir === audit.snapshot?.configDir)
      .map(other => other.name);
  }

  return audits.sort((a, b) => a.name.localeCompare(b.name));
}
