import * as vscode from 'vscode';

/**
 * Per-folder expected accounts kept in the extension's own global state.
 *
 * Which account *you* use in a repo is a machine-local fact, but the obvious
 * place to record it — the folder's `.vscode/settings.json` — is usually
 * committed and shared. Storing the pin here keeps it per-folder without
 * putting anything in the repo, so a shared project needs no `.gitignore`
 * entry and no `git update-index --skip-worktree`.
 *
 * A `claudeAccount.expectedAccount` setting still wins when present, so teams
 * that genuinely want to commit an expectation can.
 */

let store: vscode.Memento | undefined;

const KEY_PREFIX = 'expectedAccount:';

export function initPinStore(memento: vscode.Memento): void {
  store = memento;
}

function key(folder: string): string {
  return `${KEY_PREFIX}${folder}`;
}

export function getPin(folder: string | undefined): string | undefined {
  if (!store || !folder) {
    return undefined;
  }
  const value = store.get<string>(key(folder));
  return value && value.trim() ? value.trim() : undefined;
}

export async function setPin(folder: string, value: string | undefined): Promise<void> {
  if (!store) {
    return;
  }
  await store.update(key(folder), value && value.trim() ? value.trim() : undefined);
}

/** Folders with a machine-local pin, for the details report. */
export function pinnedFolders(): string[] {
  if (!store || !('keys' in store)) {
    return [];
  }
  return (store.keys() as readonly string[])
    .filter(k => k.startsWith(KEY_PREFIX))
    .map(k => k.slice(KEY_PREFIX.length));
}
