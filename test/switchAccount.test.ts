import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIG_DIR_VAR, existingWriteTarget, readWindowState } from '../src/accountReader';

/**
 * Switching account must write the setting where the setting already is.
 *
 * Writing it to the folder when it lives in user settings leaves two values
 * for one variable, and the folder's would win — so the switch would appear to
 * work, and the next switch from user settings would silently do nothing. The
 * reverse leaves a personal path in a repo file.
 */

delete process.env[CONFIG_DIR_VAR];

function folder(settings?: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-account-'));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(root, '.vscode'));
    fs.writeFileSync(path.join(root, '.vscode', 'settings.json'), JSON.stringify(settings));
  }
  return root;
}

test('a folder that declares the store is updated in the folder', () => {
  const root = folder({ 'terminal.integrated.env.osx': { [CONFIG_DIR_VAR]: '/tmp/a' } });
  const state = readWindowState(root, { effectiveTerminalEnv: { [CONFIG_DIR_VAR]: '/tmp/a' } });
  assert.equal(existingWriteTarget(state), 'folder');
});

test('a value from the profile is updated in user settings', () => {
  // Nothing in the folder; the terminal still gets a store, so it came from
  // the user or profile level — which is exactly the case that used to be
  // invisible, and is now the common one.
  const state = readWindowState(folder(), {
    effectiveTerminalEnv: { [CONFIG_DIR_VAR]: '/tmp/from-profile' },
  });
  assert.equal(existingWriteTarget(state), 'user');
});

test('nothing declared anywhere means ask', () => {
  // No answer to infer, so the switch must fall back to the full question
  // rather than pick a scope on the user's behalf.
  assert.equal(existingWriteTarget(readWindowState(folder(), { effectiveTerminalEnv: {} })), undefined);
  assert.equal(existingWriteTarget(readWindowState(undefined, { effectiveTerminalEnv: {} })), undefined);
});
