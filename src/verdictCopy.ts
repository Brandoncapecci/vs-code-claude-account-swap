import { Verdict } from './accountReader';

/**
 * The single source of truth for how every verdict is worded and coloured.
 *
 * This used to be four parallel switches — tree, status bar, details report and
 * icon styling — which drifted: the report handled three of five verdicts and
 * printed nothing for the rest. One exhaustive, `default`-less switch means
 * adding a verdict is a compile error until every surface handles it.
 */

export interface VerdictContext {
  email?: string;
  expected?: string;
  /** Human label for the credential store, e.g. `~/.claude-work`. */
  store: string;
  /** Set when the verdict comes from a consumer other than the terminal. */
  offender?: string;
  apiKeySource?: string;
  verified: boolean;
  /** True when the folder declares no CLAUDE_CONFIG_DIR of its own. */
  shared: boolean;
}

export interface VerdictCopy {
  /** Sentence case: the coloured icon already carries the alarm. */
  label: string;
  icon: string;
  color?: string;
  background?: 'error' | 'warning';
  /** Dimmed text after the tree label. */
  treeDescription: string;
  /** Status bar text, excluding the icon. */
  statusText: string;
  /** A full sentence for tooltips and the details report. */
  detail: string;
  /** What clicking the headline row should do. */
  command: string;
}

// The chart palette renders as unambiguous green/red/yellow across themes;
// the problems-icon tokens can come through near-white in some dark themes,
// which loses the whole point of colour-coding a warning.
export const PASS = 'charts.green';
export const ERROR = 'charts.red';
export const WARN = 'charts.yellow';
export const INFO = 'charts.blue';

export function verdictCopy(verdict: Verdict, ctx: VerdictContext): VerdictCopy {
  const copy = base(verdict, ctx);

  // An unverified reading can never be presented as confident, whatever the
  // verdict says. verdictFor() only returns 'unverified' for an outright CLI
  // failure, so this catches the verifier-disabled case too.
  if (!ctx.verified && verdict !== 'unverified' && verdict !== 'not-logged-in') {
    return {
      ...copy,
      icon: 'question',
      color: WARN,
      treeDescription: `${copy.treeDescription} (unverified)`,
      statusText: `${copy.statusText} (unverified)`,
      detail: `${copy.detail} This was read from disk, not confirmed with \`claude auth status\`.`,
    };
  }
  return copy;
}

function base(verdict: Verdict, ctx: VerdictContext): VerdictCopy {
  const email = ctx.email ?? 'unknown';

  switch (verdict) {
    case 'correct':
      return {
        label: 'Correct account',
        icon: 'verified-filled',
        color: PASS,
        treeDescription: email,
        statusText: email,
        detail: `\`${email}\` matches the account pinned for this project (\`${ctx.expected}\`), confirmed by a live \`claude auth status\`.`,
        command: 'claudeAccount.showDetails',
      };

    case 'wrong':
      return ctx.offender
        ? {
            label: `Wrong account (${ctx.offender.toLowerCase()})`,
            icon: 'warning',
            color: WARN,
            background: 'warning',
            treeDescription: email,
            statusText: `${ctx.offender}: ${email}`,
            detail: `The ${ctx.offender.toLowerCase()} resolves \`${email}\`, but this project expects \`${ctx.expected}\`. Logging in again cannot fix this — it is a config-dir routing problem, not a credential one.`,
            command: 'claudeAccount.showDetails',
          }
        : {
            label: 'Wrong account',
            icon: 'error',
            color: ERROR,
            background: 'error',
            treeDescription: email,
            statusText: `Wrong: ${email}`,
            detail: `This project expects \`${ctx.expected}\` but Claude Code is signed in as \`${email}\`.`,
            command: 'claudeAccount.showDetails',
          };

    case 'not-logged-in':
      return {
        label: 'Not logged in',
        icon: 'circle-slash',
        color: WARN,
        background: 'warning',
        treeDescription: ctx.store,
        statusText: 'No Claude login',
        detail: `No account is signed in for ${ctx.store}.`,
        command: 'claudeAccount.login',
      };

    case 'api-key':
      return {
        label: 'API key in use',
        icon: 'key',
        color: ERROR,
        background: 'error',
        treeDescription: `${ctx.apiKeySource ?? 'An API key'} — pinned account not in effect`,
        statusText: `API key: ${ctx.apiKeySource ?? 'set'}`,
        detail: `\`claude auth status\` reports an API key from \`${ctx.apiKeySource ?? 'the environment'}\` is in use. It supersedes the OAuth login, so the pinned account \`${ctx.expected}\` is not what requests are billed to.`,
        command: 'claudeAccount.showDetails',
      };

    case 'unverified':
      return {
        label: 'Unverified',
        icon: 'question',
        color: WARN,
        treeDescription: ctx.email ? `${email} (from disk)` : ctx.store,
        statusText: `${email} (unverified)`,
        detail:
          'The live `claude auth status` check did not succeed, so this reading comes from disk and is not confirmed.',
        command: 'claudeAccount.showDetails',
      };

    case 'no-expectation':
      // The description has to say whose email this is. "No account pinned"
      // next to a bare address reads as a contradiction.
      return ctx.shared
        ? {
            label: 'No account pinned',
            icon: 'person-add',
            color: INFO,
            treeDescription: `signed in as ${email} — shared login, click to set up`,
            statusText: email,
            detail: `Signed in as \`${email}\`, but nothing is pinned for this project and it has no store of its own — it shares one credential store with every other unconfigured project. Pick an account to give it its own.`,
            command: 'claudeAccount.useAccountForThisProject',
          }
        : {
            label: 'No account pinned',
            icon: 'person-add',
            color: INFO,
            treeDescription: `signed in as ${email} — click to pin`,
            statusText: email,
            detail: `This project has its own store (${ctx.store}) signed in as \`${email}\`. Nothing is pinned yet, so no check is being made — pin it and the view will tell you whenever the account changes.`,
            command: 'claudeAccount.setExpectedAccount',
          };
  }
}
