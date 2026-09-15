import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIG_DIR_VAR, readWindowState } from '../src/accountReader';

/**
 * Who else a sign-in here would reach.
 *
 * The boolean this replaced asked only "does the folder declare a store", then
 * warned whenever the answer was no — which flagged a profile-based setup, the
 * one `Fix Sidebar Account` itself creates, as a broken one. These tests pin
 * the four scopes apart so that warning stays on the single case that earns it.
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

test('a folder that declares the store reaches this project only', () => {
  const state = readWindowState(
    folder({ 'terminal.integrated.env.osx': { [CONFIG_DIR_VAR]: '/tmp/work' } }),
    { effectiveTerminalEnv: { [CONFIG_DIR_VAR]: '/tmp/work' } }
  );
  assert.equal(state.storeScope, 'folder');
  assert.equal(state.isolated, true);
});

test('a default terminal profile is profile scope, not a missing store', () => {
  // The real-world setup this was written for: two terminal profiles, one per
  // account, and no folder settings at all. Reported as "not isolated" before,
  // which told someone their deliberate configuration was broken.
  const state = readWindowState(folder(), {
    effectiveTerminalEnv: {},
    terminalProfiles: [
      { name: 'Claude · work', env: { [CONFIG_DIR_VAR]: '/tmp/work' }, isDefault: true },
      { name: 'Claude · personal', env: { [CONFIG_DIR_VAR]: '/tmp/personal' }, isDefault: false },
    ],
  });
  assert.equal(state.storeScope, 'profile');
  assert.equal(state.isolated, false);
});

test('a store from user or profile settings is profile scope', () => {
  assert.equal(
    readWindowState(folder(), { effectiveTerminalEnv: { [CONFIG_DIR_VAR]: '/tmp/work' } })
      .storeScope,
    'profile'
  );
  // The sidebar's setting is machine-scoped, so an effective value for it can
  // only have come from user or profile settings too.
  assert.equal(
    readWindowState(folder(), {
      effectiveTerminalEnv: {},
      effectiveSidebarEnv: { [CONFIG_DIR_VAR]: '/tmp/work' },
    }).storeScope,
    'profile'
  );
});

test('the folder wins over the profile, because VS Code applies it', () => {
  const state = readWindowState(
    folder({ 'terminal.integrated.env.osx': { [CONFIG_DIR_VAR]: '/tmp/folder' } }),
    {
      effectiveTerminalEnv: { [CONFIG_DIR_VAR]: '/tmp/folder' },
      terminalProfiles: [
        { name: 'Claude · work', env: { [CONFIG_DIR_VAR]: '/tmp/work' }, isDefault: true },
      ],
    }
  );
  assert.equal(state.storeScope, 'folder');
});

test('an inherited environment is named as such, not as isolation', () => {
  process.env[CONFIG_DIR_VAR] = '/tmp/from-env';
  try {
    const state = readWindowState(folder(), { effectiveTerminalEnv: {} });
    assert.equal(state.storeScope, 'environment');
    assert.equal(state.isolated, false);
  } finally {
    delete process.env[CONFIG_DIR_VAR];
  }
});

test('nothing anywhere is the only scope that shares the default store', () => {
  const state = readWindowState(folder(), { effectiveTerminalEnv: {} });
  assert.equal(state.storeScope, 'none');
  assert.equal(state.isolated, false);
});
