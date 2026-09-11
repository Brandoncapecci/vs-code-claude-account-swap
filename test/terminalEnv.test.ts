import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIG_DIR_VAR, readWindowState, storeLabel } from '../src/accountReader';

/**
 * The Terminal row must answer for the terminal, not for the extension host.
 *
 * VS Code merges `terminal.integrated.env.<platform>` across user, profile and
 * folder settings. We used to read only the folder file, so a CLAUDE_CONFIG_DIR
 * living in the active *profile* — which is where this extension's own setup
 * flow puts it — was invisible, and the row fell through to the extension
 * host's environment, which never inherits terminal settings. The row then
 * named the default store while the terminal was really using another one:
 * the wrong account, reported for the one consumer the user is typing into.
 */

// This process inherits whatever store the terminal running the tests uses.
// Clear it, or every fallback assertion here would be measuring the machine.
delete process.env[CONFIG_DIR_VAR];

function folder(settings?: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-account-'));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(root, '.vscode'));
    fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), JSON.stringify(settings));
  }
  return root;
}

const terminalRow = (root: string, options = {}) =>
  readWindowState(root, options).consumers.find(c => c.kind === 'terminal')!;

test('a profile-level CLAUDE_CONFIG_DIR reaches the Terminal row', () => {
  // No folder file at all, which is the ordinary case: the value is in the
  // profile, and only the configuration API can see it.
  const root = folder();
  const effectiveTerminalEnv = { [CONFIG_DIR_VAR]: '/tmp/claude-work' };

  const blind = terminalRow(root);
  assert.equal(blind.snapshot.source, 'default', 'without the merge, the row falls back');

  const row = terminalRow(root, { effectiveTerminalEnv });
  assert.equal(row.snapshot.configDir, '/tmp/claude-work');
  assert.equal(row.snapshot.source, 'settings (terminal)');
  assert.equal(row.env[CONFIG_DIR_VAR], '/tmp/claude-work');
  // And it says where the value came from, since the folder did not declare it.
  assert.match(row.caveat ?? '', /user or profile settings/);
});

test('the folder still declares, and still counts as isolation', () => {
  const root = folder({ 'terminal.integrated.env.osx': { [CONFIG_DIR_VAR]: '/tmp/folder-store' } });
  const state = readWindowState(root, {
    effectiveTerminalEnv: { [CONFIG_DIR_VAR]: '/tmp/folder-store' },
  });
  const row = state.consumers.find(c => c.kind === 'terminal')!;
  assert.equal(row.snapshot.configDir, '/tmp/folder-store');
  // A folder that declares nothing is not isolated by a profile-wide value:
  // isolation is a property of the folder, so it keeps reading the file.
  assert.equal(state.isolated, true);
  assert.equal(row.caveat, undefined, 'the folder declared it, so there is nothing to explain');
  assert.equal(
    readWindowState(folder(), { effectiveTerminalEnv: { [CONFIG_DIR_VAR]: '/tmp/x' } }).isolated,
    false,
  );
});

test('no override anywhere still means the default store', () => {
  const row = terminalRow(folder(), { effectiveTerminalEnv: {} });
  assert.equal(row.snapshot.source, 'default');
  assert.match(storeLabel(row.snapshot), /unset/);
  assert.match(row.caveat ?? '', /inherits the process environment/);
});
