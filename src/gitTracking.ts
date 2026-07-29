import { execFileSync } from 'child_process';
import * as path from 'path';

/**
 * Whether a settings file is under version control.
 *
 * This matters because `CLAUDE_CONFIG_DIR` is a machine-local fact — which
 * account *you* use — while `.vscode/settings.json` is usually a shared,
 * committed file. Writing one into the other pushes your personal credential
 * store path to your teammates.
 */
export type TrackingState =
  /** Not a git repo, or the file is not tracked — safe to write. */
  | 'untracked'
  /** Tracked and live: an edit shows up in `git status` and can be committed. */
  | 'tracked'
  /** Tracked but masked with `git update-index --skip-worktree`. */
  | 'skip-worktree'
  /** Tracked but masked with `git update-index --assume-unchanged`. */
  | 'assume-unchanged';

export function trackingState(file: string): TrackingState {
  let output: string;
  try {
    output = execFileSync('git', ['ls-files', '-v', '--', path.basename(file)], {
      cwd: path.dirname(file),
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Not a git repo, git missing, or the path is outside a work tree.
    return 'untracked';
  }

  const flag = output.trim()[0];
  if (!flag) {
    return 'untracked';
  }
  if (flag === 'S') {
    return 'skip-worktree';
  }
  // git reports assume-unchanged by lowercasing the status letter.
  if (flag === flag.toLowerCase()) {
    return 'assume-unchanged';
  }
  return 'tracked';
}

/** True when writing to this file would show up as a repo change. */
export function wouldDirtyRepo(state: TrackingState): boolean {
  return state === 'tracked';
}

export function setSkipWorktree(file: string): void {
  execFileSync('git', ['update-index', '--skip-worktree', '--', path.basename(file)], {
    cwd: path.dirname(file),
    timeout: 3000,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}
