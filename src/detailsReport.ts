import {
  WindowState,
  cliError,
  cliStatus,
  effectiveEmail,
  hasConsumerMismatch,
  storeLabel,
  tilde,
  verdictFor,
  worstConsumer,
} from './accountReader';
import { copyContextFor, windowCopy } from './accountProvider';
import { verdictCopy } from './verdictCopy';
import { freshnessLine } from './statusBar';

/** The full report, opened as a markdown document. */
export function detailsMarkdown(state: WindowState): string {
  const copy = windowCopy(state);
  const consumer = worstConsumer(state);
  const snapshot = consumer.snapshot;

  const lines: string[] = ['# Claude Account', '', `## ${copy.label}`, '', copy.detail, ''];

  // Stamp the snapshot's own read time, so the report can never claim to be
  // fresher than the data it is rendering.
  lines.push(`Read at ${snapshot.readAt.toLocaleTimeString()}. ${freshnessLine(state)}`, '');

  if (state.workspaceRoot) {
    lines.push(
      `**Folder:** \`${tilde(state.workspaceRoot)}\`${state.isolated ? '' : ' — not isolated, shares a store with every unconfigured project'}`,
      ''
    );
  }
  if (state.expectedAccount) {
    lines.push(`**Pinned account:** \`${state.expectedAccount}\``, '');
  }

  lines.push('## Who uses what', '');
  lines.push(
    '| Consumer | Account | Verdict | Plan | Store | Source |',
    '| --- | --- | --- | --- | --- | --- |'
  );
  for (const each of state.consumers) {
    const s = each.snapshot;
    const status = cliStatus(s);
    const rowVerdict = each.diagnosticOnly
      ? '—'
      : verdictCopy(verdictFor(s, state.expectedAccount), copyContextFor(state, each)).label;
    lines.push(
      `| ${each.name} | ${effectiveEmail(s) ?? '_not logged in_'} | ${rowVerdict} | ${status?.subscriptionType ?? '—'} | ${storeLabel(s)} | ${s.source} |`
    );
  }
  lines.push('');

  const status = cliStatus(snapshot);
  if (status) {
    lines.push('## Live CLI answer', '', '```json', JSON.stringify(status, null, 2), '```', '');
  }
  const error = cliError(snapshot);
  if (error) {
    lines.push(
      '## CLI error',
      '',
      error,
      '',
      'Set `claudeAccount.claudePath` if the `claude` executable lives somewhere unusual.',
      ''
    );
  }

  lines.push('## Sources', '');
  lines.push(
    `- Account file: ${snapshot.accountFile ? `\`${tilde(snapshot.accountFile)}\`` : '_none found_'}`
  );
  lines.push(
    `- Credentials file: ${snapshot.credentialsFile ? `\`${tilde(snapshot.credentialsFile)}\`` : '_none on disk — macOS keeps them in the Keychain, keyed by store_'}`
  );
  lines.push(
    `- Workspace settings: ${state.overrides.file ? `\`${tilde(state.overrides.file)}\`` : '_none_'}`
  );
  lines.push('');

  const overrides: string[] = [];
  if (status?.apiKeySource) {
    overrides.push(`\`claude auth status\` reports an API key from \`${status.apiKeySource}\` is in use.`);
  }
  for (const name of state.processApiKeyVars) {
    overrides.push(`\`${name}\` is set in this window's environment.`);
  }
  for (const entry of state.settingsApiKeys) {
    overrides.push(`\`${entry.variable}\` is declared in \`${tilde(entry.file)}\`.`);
  }
  for (const problem of state.settingsProblems) {
    overrides.push(`\`${tilde(problem.file)}\` could not be parsed (${problem.error}).`);
  }
  if (overrides.length > 0) {
    lines.push('## Account overrides', '');
    lines.push(...overrides.map(note => `- ${note}`));
    lines.push('', 'An API key takes precedence over a logged-in account.', '');
  }

  if (hasConsumerMismatch(state)) {
    lines.push(
      '## Store mismatch',
      '',
      'The terminal and the sidebar resolve different credential stores in this window, so they may be signed in as different accounts.',
      ''
    );
  }

  lines.push(
    '---',
    '',
    'If the Claude Code sidebar disagrees with this, it is showing cached login info from when the window started. Reload the window to refresh its display.'
  );

  return lines.join('\n');
}
