import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A note left for the window we are about to open.
 *
 * Setting up a profile takes two steps in two different windows: reopen the
 * folder under the profile, then write the store into that profile's user
 * settings. The second step can only run inside the new window, and extension
 * global state is itself per-profile so it cannot carry the intent across.
 * A small file on disk can.
 */

export interface ProfileHandoff {
  folder: string;
  /** Store to apply, or undefined for the implicit default store. */
  configDir?: string;
  account?: string;
  profileName: string;
  createdAt: number;
}

/** Stale notes are ignored rather than applied to some unrelated later window. */
const MAX_AGE_MS = 10 * 60 * 1000;

function handoffPath(): string {
  return path.join(os.tmpdir(), 'claude-account-profile-handoff.json');
}

export function writeHandoff(handoff: ProfileHandoff): void {
  try {
    fs.writeFileSync(handoffPath(), JSON.stringify(handoff), 'utf-8');
  } catch {
    // Losing the note only costs the user the second step manually.
  }
}

export function readHandoff(folder: string | undefined): ProfileHandoff | undefined {
  if (!folder) {
    return undefined;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(handoffPath(), 'utf-8');
  } catch {
    return undefined;
  }

  let parsed: ProfileHandoff;
  try {
    parsed = JSON.parse(raw) as ProfileHandoff;
  } catch {
    clearHandoff();
    return undefined;
  }

  if (Date.now() - parsed.createdAt > MAX_AGE_MS) {
    clearHandoff();
    return undefined;
  }
  if (path.resolve(parsed.folder) !== path.resolve(folder)) {
    return undefined;
  }
  return parsed;
}

export function clearHandoff(): void {
  try {
    fs.unlinkSync(handoffPath());
  } catch {
    // Already gone.
  }
}
