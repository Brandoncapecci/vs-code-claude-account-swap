import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIG_DIR_VAR, readWindowState, realConsumers } from '../src/accountReader';

/**
 * Terminal profiles are how two Claude accounts run side by side in one window.
 *
 * A profile's `env` is merged AFTER `terminal.integrated.env.<platform>`, so it
 * wins — checked against the terminal's own environment assembly, where the
 * settings block is merged first and the launch config's env second. Reading
 * only the blanket setting would name an account no terminal actually uses.
 */

delete process.env[CONFIG_DIR_VAR];

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-account-'));
const profile = (name: string, dir: string, isDefault = false) => ({
  name,
  env: { [CONFIG_DIR_VAR]: dir },
  isDefault,
});

test('the default profile decides the terminal account, over the blanket setting', () => {
  const state = readWindowState(root(), {
    effectiveTerminalEnv: { [CONFIG_DIR_VAR]: '/tmp/blanket' },
    terminalProfiles: [profile('work', '/tmp/work', true), profile('personal', '/tmp/personal')],
  });
  const terminal = state.consumers.find(c => c.kind === 'terminal')!;
  assert.equal(terminal.snapshot.configDir, '/tmp/work');
  assert.equal(terminal.snapshot.source, 'terminal profile');
  assert.match(terminal.name, /work/);
});

test('the other profiles are shown, and never count as a mismatch', () => {
  const state = readWindowState(root(), {
    effectiveTerminalEnv: {},
    terminalProfiles: [profile('work', '/tmp/work', true), profile('personal', '/tmp/personal')],
  });
  const other = state.consumers.find(c => c.kind === 'terminalProfile')!;
  assert.equal(other.snapshot.configDir, '/tmp/personal');
  // Two accounts side by side is the point of profiles. If the second profile
  // counted as a real consumer, the window would report itself as wrong for
  // being set up exactly as intended.
  assert.equal(other.diagnosticOnly, true);
  assert.ok(!realConsumers(state).includes(other));
});

test('a profile with no store of its own changes nothing', () => {
  // Most profiles are just shells. Only one that names a store has an opinion
  // about the account, and the blanket setting still answers for the rest.
  const state = readWindowState(root(), {
    effectiveTerminalEnv: { [CONFIG_DIR_VAR]: '/tmp/blanket' },
    terminalProfiles: [{ name: 'zsh', env: {}, isDefault: true }],
  });
  const terminal = state.consumers.find(c => c.kind === 'terminal')!;
  assert.equal(terminal.snapshot.configDir, '/tmp/blanket');
  assert.equal(terminal.snapshot.source, 'settings (terminal)');
  assert.equal(state.consumers.filter(c => c.kind === 'terminalProfile').length, 0);
});

test('no profiles at all is the old behaviour, unchanged', () => {
  const state = readWindowState(root(), {
    effectiveTerminalEnv: { [CONFIG_DIR_VAR]: '/tmp/blanket' },
  });
  const terminal = state.consumers.find(c => c.kind === 'terminal')!;
  assert.equal(terminal.snapshot.configDir, '/tmp/blanket');
  assert.equal(terminal.name, 'Terminal');
});
