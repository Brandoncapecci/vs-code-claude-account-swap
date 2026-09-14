import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CONFIG_DIR_VAR,
  StoreInfo,
  duplicateAccountGroups,
  readAccount,
} from '../src/accountReader';

/**
 * Two stores signed in as one account is the failure that looks healthy from
 * every other angle — separate dirs, separate Keychain entries, separate
 * settings — so these tests pin down exactly when it is and is not reported.
 */

delete process.env[CONFIG_DIR_VAR];

interface Oauth {
  emailAddress?: string;
  organizationName?: string;
  accountUuid?: string;
  organizationUuid?: string;
}

/** A `~/.claude-<name>` store holding the given account, or none. */
function store(oauth?: Oauth): StoreInfo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-store-'));
  fs.writeFileSync(
    path.join(dir, '.claude.json'),
    JSON.stringify(oauth ? { oauthAccount: oauth } : { firstRunDone: true })
  );
  return {
    configDir: dir,
    snapshot: readAccount(dir, 'settings (terminal)'),
    usedBy: [],
  };
}

const WORK: Oauth = {
  emailAddress: 'you@work.com',
  organizationName: 'Work',
  accountUuid: 'acct-1',
  organizationUuid: 'org-work',
};

test('two stores holding the same account are reported together', () => {
  const groups = duplicateAccountGroups([store(WORK), store(WORK)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].stores.length, 2);
  assert.equal(groups[0].email, 'you@work.com');
});

test('different accounts are left alone', () => {
  const groups = duplicateAccountGroups([
    store(WORK),
    store({ emailAddress: 'you@personal.com', accountUuid: 'acct-2' }),
  ]);
  assert.deepEqual(groups, []);
});

test('one person in two organizations is real isolation, not a duplicate', () => {
  // Same human, same email, two orgs: the UUID pair is what tells them apart,
  // and treating this as a duplicate would nag someone whose setup is correct.
  const groups = duplicateAccountGroups([
    store(WORK),
    store({ ...WORK, organizationName: 'Personal', organizationUuid: 'org-personal' }),
  ]);
  assert.deepEqual(groups, []);
});

test('a store with no account cannot duplicate anything', () => {
  assert.deepEqual(duplicateAccountGroups([store(), store()]), []);
  assert.equal(duplicateAccountGroups([store(WORK), store()]).length, 0);
});

test('an older store with no UUID still matches by email and org', () => {
  // `.claude.json` files written before accountUuid existed, and any store the
  // CLI answered for rather than disk, are matched on what they do have.
  const groups = duplicateAccountGroups([
    store(WORK),
    store({ emailAddress: 'you@work.com', organizationName: 'Work' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].stores.length, 2);
});

test('three stores matched through different keys form one group, not two', () => {
  // The middle store matches one sibling by UUID and the other by email. A
  // grouping keyed on a single identifier would split one account in two.
  const groups = duplicateAccountGroups([
    store({ emailAddress: 'you@work.com', organizationName: 'Work' }),
    store(WORK),
    store({ accountUuid: 'acct-1', organizationUuid: 'org-work', emailAddress: 'renamed@work.com' }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].stores.length, 3);
});
