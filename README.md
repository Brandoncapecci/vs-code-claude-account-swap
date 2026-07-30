# Claude Account

Give each project its own Claude Code account, and see at a glance whether you are on the right one. Verified live against the CLI, never cached.

## Why

Claude Code keys credentials by the `CLAUDE_CONFIG_DIR` environment variable — separate dirs are separate logins. But nothing tells you which one a window is actually using, and the Claude Code sidebar caches the account it saw at startup while API calls read credentials live. So the display can say one thing while your requests bill another.

This extension never caches. Every read runs `claude auth status --json` for each credential store, which is the same code path a real `claude` run uses.

## Set up a project in two clicks

Click the 🔑 in the **Claude Account** view title, or the **Not isolated** row, and run **Use a Specific Account For This Project**:

1. **Pick an account** from a list of every account already signed in on this machine — no typing.
   ```
   ✓ you@work.com          Acme · max     ~/.claude-work — used by 3 projects
   ✓ you@personal.com      pro            Default store (CLAUDE_CONFIG_DIR unset)
   ○ ~/.claude-client                     signed out — selecting this will sign in
     + Sign in with another account…
     ✎ Enter an email or *@domain manually…
   ```
2. **Done.** The extension writes `CLAUDE_CONFIG_DIR` into the folder's `.vscode/settings.json`, pins the expected account, and offers a reload.

Picking **Sign in with another account…** asks only for a short *label* (`work`, `personal`), creates `~/.claude-<label>`, runs `claude auth login` in a terminal, waits for it to finish, and pins the account it actually signed in as. You never type an email you could have picked, and never hand-edit JSON.

Stores are named after the **account**, not the project, so the second work repo reuses `~/.claude-work` and needs no new login.

## Knowing you are on the right account

The headline row and the status bar say one of:

| | Meaning |
|---|---|
| **Correct account** | Live account matches what this folder pinned. |
| **Wrong account** | It does not. Red status bar, view badge, and a notification offering to fix it. |
| **Wrong account (sidebar)** | The terminal is right but the Claude Code sidebar resolves a different store. Amber, with a different remedy — re-logging in cannot fix routing. |
| **API key in use** | An `ANTHROPIC_API_KEY` supersedes the login, so the pinned account is not what gets billed. |
| **Not logged in** | No account for this store. |
| **Unverified** | The CLI check did not succeed, so the reading came from disk and is not confirmed. Never shown as confident. |
| **No account pinned** | Nothing to check against. Click to set it up. |

Anything read from disk rather than confirmed live is always labelled `(unverified)`.

## Other features

- **Not isolated** — flags a folder that declares no store of its own, because signing in there silently changes the account for every other unconfigured project. One click fixes it.
- **Who uses what** — the terminal, the Claude Code sidebar, and this extension host resolve `CLAUDE_CONFIG_DIR` independently; each is verified separately and flagged when they disagree.
- **Account overrides** — API keys in the environment or in any `settings.json` `env` block, plus settings files that failed to parse.
- **Projects** — scans sibling folders and flags any two pointing at the same store, since those share one login.

## Shared repos: keeping your account out of git

`CLAUDE_CONFIG_DIR` says which account **you** use. `.vscode/settings.json` is usually committed. Putting one in the other pushes your personal credential-store path to your teammates.

The extension handles this rather than leaving you to `git update-index --skip-worktree`:

- **The expected account is never written to the repo.** It lives in the extension's own per-folder machine state. A committed `claudeAccount.expectedAccount` still wins if a team deliberately wants to share one.
- **When the folder's `settings.json` is tracked**, setup asks where `CLAUDE_CONFIG_DIR` should go:
  - **All my projects** — user settings. Nothing touches the repo. Right when this is your usual account; other folders can still override it.
  - **This folder only** — writes `.vscode/settings.json` and immediately masks it with `git update-index --skip-worktree`, so it will not show up in `git status`.
- **A `Committed to this repo` row** appears when a tracked, unmasked settings file already declares `CLAUDE_CONFIG_DIR` — the state where an ordinary `git commit -a` would leak it.

For a shared repo that needs a non-default account, the cleanest option remains an external `.code-workspace` file kept outside the repo: workspace settings live in that file, so the repo stays untouched and no git masking is needed. Open the workspace file instead of the folder.

Note that user settings alone cannot give two projects two different accounts — they apply everywhere. The workable pattern is *user settings for the account you use most, per-folder overrides for the exceptions.*

## Two traps it detects

**`CLAUDE_CONFIG_DIR=~/.claude` is not the same as leaving it unset**, even though `~/.claude` is the default directory. An explicit value selects a store at `~/.claude/.claude.json`; unset uses the legacy `~/.claude.json`. Verified: `claude auth status` reports a logged-in account with the variable unset and none with it set to `~/.claude`. A project configured that way looks mysteriously logged out.

**`claudeCode.environmentVariables` is machine-scoped.** VS Code ignores a workspace-level value outright — the settings editor says so on hover — which leaves the native panel on a different account from the terminal in the same window. The extension compares what your file declares against what the configuration API actually reports, and names the store the panel will really use.

**Fix Sidebar Account** offers the only three routes that exist, with their trade-offs stated:

| Route | Scope | Trade-off |
|---|---|---|
| **Terminal** *(recommended)* | this project | Claude opens as a terminal here rather than the native panel. One workspace setting, nothing else changes. |
| **Own editor profile** | this project | Keeps the native panel, but a profile has its own extension list — extensions you install later apply to one profile at a time, and you maintain two. |
| **User settings** | every project | The only scope the setting is honored in, so it is all-or-nothing. Always asks first, naming the projects it would break. |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeAccount.expectedAccount` | `""` | The account this folder should use. Exact email or `*@domain`. Written per folder by the setup flow. |
| `claudeAccount.verifyWithCli` | `true` | Verify via `claude auth status --json`. The authoritative check. |
| `claudeAccount.alertOnWrongAccount` | `true` | Notify when the live account does not match. |
| `claudeAccount.statusBar` | `true` | Show the account in the status bar. |
| `claudeAccount.scanProjects` | `true` | Scan sibling folders for `CLAUDE_CONFIG_DIR` overrides. |
| `claudeAccount.projectsRoot` | `""` | Folder to scan. Empty means the parent of the current folder. |
| `claudeAccount.refreshInterval` | `0` | Seconds between automatic re-reads. `0` disables polling; files are still watched. Clamped to ≥5. |
| `claudeAccount.claudePath` | `""` | Path to the `claude` executable. Empty auto-detects. Machine-scoped, so a cloned repo cannot redirect it. |

## Commands

All under the **Claude Account** category.

| Command | Description |
|---------|-------------|
| `Use a Specific Account For This Project` | The setup flow: pick an account, write the settings, log in if needed, pin the result. |
| `Pin Expected Account` | Change only what to expect, without changing which store the folder uses. |
| `Re-read Now` | Force a fresh read and re-verify. |
| `Show Details` | Full report, including the raw CLI JSON and a per-consumer verdict table. |
| `Log In…` / `Log Out…` | Run `claude auth login` / `logout` against the correct store. |

## How it works

1. Reads `.vscode/settings.json` off disk, because a machine-scoped setting's workspace value is hidden from the configuration API — then compares it against what the API reports, to detect a value VS Code is ignoring
2. Resolves `CLAUDE_CONFIG_DIR` separately for the terminal, the sidebar, and this extension host, expanding `~`, `${workspaceFolder}`, `${userHome}` and `${env:VAR}` the way VS Code does
3. Runs `claude auth status --json` per distinct store, omitting the variable entirely where nothing set it
4. Falls back to `oauthAccount` in `<store>/.claude.json` if the CLI is unavailable — and says so rather than implying the result is verified
5. Writes settings with `jsonc-parser`, splicing exact ranges so comments, key order, and unrelated settings survive; refuses to write to a file that does not parse

## Development

```bash
npm install
npm run compile     # or: npm run watch
```

<kbd>F5</kbd> launches an extension host with the extension loaded.

| Module | Responsibility |
|---|---|
| `accountReader.ts` | Stores, CLI verification, verdicts. No `vscode` import, so it runs under plain node. |
| `settingsIo.ts` | Surgical `.vscode/settings.json` writes. |
| `setupFlow.ts` | The per-project setup and login flow. |
| `verdictCopy.ts` | One exhaustive switch for every verdict's wording and colour. |
| `accountProvider.ts` | Tree view, load coalescing, file watching. |
| `statusBar.ts`, `detailsReport.ts`, `commands.ts` | Presentation surfaces and command wiring. |
