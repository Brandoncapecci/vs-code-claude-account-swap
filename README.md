# Claude Account

Give each project its own Claude Code account, and see at a glance whether you are on the right one. Verified live against the CLI, never cached.

## Why

Claude Code keys credentials by the `CLAUDE_CONFIG_DIR` environment variable — separate dirs are separate logins. But nothing tells you which one a window is actually using, and the Claude Code sidebar caches the account it saw at startup while API calls read credentials live. So the display can say one thing while your requests bill another.

This extension never caches. Every read runs `claude auth status --json` for each credential store, which is the same code path a real `claude` run uses.

## Set up a project in two clicks

Click the **Not isolated** row, or run **Use a Specific Account For This Project** from the `…` menu in the **Claude Account** view title:

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

- **Accounts** — every credential store on this machine, which account each holds, which one this project is on, and duplicates marked inline. Arrows point the project at another one; right-click to sign in or out.
- **Not isolated** — flags a project whose account falls through to the store every unconfigured project shares. Scoped deliberately: see below.
- **Who uses what** — the terminal, the Claude Code sidebar, and this extension host resolve `CLAUDE_CONFIG_DIR` independently; each is verified separately and flagged when they disagree.
- **Account overrides** — API keys in the environment or in any `settings.json` `env` block, plus settings files that failed to parse.
- **Projects** — scans sibling folders and flags any two pointing at the same store, since those share one login.
- **Two stores, one account** — flags credential stores that are separate on disk but signed in as the same account, which is isolation that only looks real.

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

## How far a sign-in reaches

"Does this project have its own account" is really the question "who else would a sign-in here affect", and the two come apart as soon as an editor or terminal profile is involved. The view reads the answer off where `CLAUDE_CONFIG_DIR` is actually declared:

| Scope | Declared by | A sign-in here reaches | Shown as |
|---|---|---|---|
| **Folder** | the folder's `.vscode/settings.json` | this project only | nothing — this is the goal |
| **Profile** | a terminal profile, or user/profile settings | every project in this editor profile without its own | named on the store row |
| **Environment** | the environment the editor was launched with | this window, and it does not follow the project | an informational row |
| **None** | nothing, anywhere | every unconfigured project on the machine | the **Not isolated** warning |

Only the last one is a trap. Warning about profile scope meant telling people that the setup **Fix Sidebar Account** had just built for them was broken — a per-project account for the native panel *has* to come from a profile, because the setting that controls it is machine-scoped.

## Three traps it detects

**Two stores can hold one login.** Separate directories, separate Keychain entries, separate settings, each project pinned to its own — and the same account behind all of them, so nothing is actually isolated. It is the *default* outcome of signing the second store in, because the browser reuses the claude.ai session you already have and the sign-in completes without a word. Nothing else in the setup looks wrong, which is why it can survive for months.

The extension compares the `accountUuid` in each store, falling back to email and organization for stores that predate it, and says so on a row of its own. One person with two organizations is a genuine reason to run two stores, so the organization is part of the comparison and that case is left alone. `Add Account` runs the same check on the account that comes back and will not quietly finish on a duplicate.

**`CLAUDE_CONFIG_DIR=~/.claude` is not the same as leaving it unset**, even though `~/.claude` is the default directory. An explicit value selects a store at `~/.claude/.claude.json`; unset uses the legacy `~/.claude.json`. Verified: `claude auth status` reports a logged-in account with the variable unset and none with it set to `~/.claude`. A project configured that way looks mysteriously logged out.

**`claudeCode.environmentVariables` is machine-scoped.** VS Code ignores a workspace-level value outright — the settings editor says so on hover — which leaves the native panel on a different account from the terminal in the same window. The extension compares what your file declares against what the configuration API actually reports, and names the store the panel will really use.

This is also why an editor profile is the *only* way to give the native panel a per-project account. Claude Code v2.1.270 contributes exactly two settings that can redirect the credential store, `claudeCode.environmentVariables` and `claudeCode.claudeProcessWrapper`, and both are `machine`-scoped — a scope VS Code honours in user and profile settings and nowhere else. `claudeCode.useTerminal` is `window`-scoped, which is what makes the terminal route settable per folder. Two other candidates are ruled out by testing: an `env` block in `.claude/settings.local.json` cannot set `CLAUDE_CONFIG_DIR`, because the store is resolved before those settings are read, and the process environment belongs to the whole editor instance rather than to a project.

**Fix Sidebar Account** offers the only three routes that exist, with their trade-offs stated:

| Route | Scope | Trade-off |
|---|---|---|
| **Terminal** *(recommended)* | this project | Claude opens as a terminal here rather than the native panel. One workspace setting, nothing else changes. |
| **Own editor profile** | this project | Keeps the native panel. A profile copies your extension list rather than sharing it, so the two drift unless you say otherwise — see below. |
| **User settings** | every project | The only scope the setting is honored in, so it is all-or-nothing. Always asks first, naming the projects it would break. |

### If you take the profile route, share your extensions

A new profile copies the extension list it was created from, and from then on the two are independent. An extension you update later lands in the profile you were in and stays at the old version in the other, with nothing on screen saying so — `--install-extension` writes to the default profile, and a window running under another profile never sees it. Installing into a specific one takes `--profile`:

```sh
cursor --profile "Claude Work" --install-extension my-extension.vsix --force
```

Two ways to avoid the split instead of managing it:

- **Per extension** — right-click it in the Extensions view and choose **Apply Extension to all Profiles**. It becomes application-scoped and one copy serves every profile.
- **Per profile** — in the profile editor, have the new profile use the *default profile's* extensions rather than a copy. Profiles inherit per category (settings, keybindings, snippets, tasks, extensions), so it can keep its own settings — which is all the account override needs — while sharing one extension list.

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

Two verbs cover the everyday work: **Switch Account** picks from the accounts you have, **Add Account** creates one. Signing in and out are consequences of those, not menu items of their own — a bare `Log In…` has to open by asking *which credential store?*, which is a question about plumbing, and one nobody can answer from a list of stores showing the same email twice.

| Command | Description |
|---------|-------------|
| `Switch Account` | Point this folder at another account you already have. One pick, no setup questions. |
| `Add Account` | Name it, create `~/.claude-<label>`, sign in, and **confirm the account that arrives is a new one**. Then offers to use it here. |
| `Use a Specific Account For This Project` | The full setup flow: pick an account, write the settings, log in if needed, pin the result. |
| `Pin Expected Account` | Change only what to expect, without changing which store the folder uses. |
| `Re-read Now` | Force a fresh read and re-verify. |
| `Show Details` | Full report: the raw CLI JSON, a per-consumer verdict table, and every account on the machine. |
| `Fix Two Stores Sharing One Account` | Sign one of the colliding stores in as a different account. |
| `Use This Account For This Project` | The arrow on an **Accounts** row. Points this folder at that account, writing the setting wherever it already lives. |
| `Sign In` / `Log Out…` | Act on one named store. On the tree row for that store, so there is never a "which one?" prompt. |

## How it works

1. Reads `.vscode/settings.json` off disk, because a machine-scoped setting's workspace value is hidden from the configuration API — then compares it against what the API reports, to detect a value VS Code is ignoring
2. Resolves `CLAUDE_CONFIG_DIR` separately for the terminal, the sidebar, and this extension host, expanding `~`, `${workspaceFolder}`, `${userHome}` and `${env:VAR}` the way VS Code does
3. Runs `claude auth status --json` per distinct store, omitting the variable entirely where nothing set it
4. Compares the `accountUuid` behind every store it can find, so two stores holding one login are named rather than left to look healthy
5. Falls back to `oauthAccount` in `<store>/.claude.json` if the CLI is unavailable — and says so rather than implying the result is verified
6. Writes settings with `jsonc-parser`, splicing exact ranges so comments, key order, and unrelated settings survive; refuses to write to a file that does not parse

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
| `setupFlow.ts` | Setup, switching, adding an account, and the sign-in flows. |
| `profileHandoff.ts` | Carries intent across the window that a new editor profile opens in. |
| `verdictCopy.ts` | One exhaustive switch for every verdict's wording and colour. |
| `accountProvider.ts` | Tree view, load coalescing, file watching. |
| `statusBar.ts`, `detailsReport.ts`, `commands.ts` | Presentation surfaces and command wiring. |
