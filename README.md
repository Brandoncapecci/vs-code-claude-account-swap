# Claude Account

Tells you plainly whether this project is using the **right** Claude Code account — verified live against the CLI, never cached — and audits whether your projects really have separate logins.

## Why

The Claude Code sidebar caches login info in memory from when the window started, while API calls read credentials live. Log in from another window and the display goes stale while requests use the new credentials. That is why `/account` can disagree with reality.

This extension never caches. It runs `claude auth status --json` for each config dir on every read, which is the same code path a real `claude` run uses, so it reflects the live Keychain rather than derived state.

## The headline row

Set the account a project is supposed to use, and the view says one of:

| | Meaning |
|---|---|
| **CORRECT ACCOUNT** | The live account matches what this project expects. |
| **WRONG ACCOUNT** | It does not. Shows both accounts, turns the status bar red, badges the view, and offers to re-login. |
| **NOT LOGGED IN** | No account for this config dir. Status bar turns amber. |
| **UNVERIFIED** | Read from disk, but the live CLI check did not run — so it is not confirmed. |
| **No expected account set** | Nothing to check against. Click the row to set one. |

Set it with **Claude Account: Set Expected Account For This Project** (the ✓ in the view title), which writes `claudeAccount.expectedAccount` into workspace settings. Accepts an exact email or a wildcard like `*@work.com`.

## Other features

- **Live account** — email, organization, plan, and auth method for this window
- **Config dir in effect** — the resolved `CLAUDE_CONFIG_DIR` and where it came from
- **Who uses what** — the terminal and the Claude Code sidebar resolve `CLAUDE_CONFIG_DIR` differently; each one's account is verified separately and flagged when they disagree
- **API key warnings** — when `claude auth status` reports an `apiKeySource`, or an `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` appears in the environment or a settings file, since a key supersedes any login
- **Isolation audit** — scans sibling projects for `CLAUDE_CONFIG_DIR` overrides and flags any two pointing at the same dir, because those share one login rather than having separate ones
- **Status bar** — the full account email, with a red or amber background when something is wrong

## How isolation works

On macOS, credentials live in the Keychain keyed by `CLAUDE_CONFIG_DIR`. Separate dirs are fully separate logins:

```jsonc
// <project>/.vscode/settings.json
{
  // Applies to `claude` run in the integrated terminal. Reliably honored.
  "terminal.integrated.env.osx": {
    "CLAUDE_CONFIG_DIR": "/Users/you/.claude-work"
  },
  // Read by the extension sidebar. Declared machine-scoped in the extension
  // manifest, so VS Code may ignore a workspace-level value.
  "claudeCode.environmentVariables": [
    { "name": "CLAUDE_CONFIG_DIR", "value": "/Users/you/.claude-work" }
  ]
}
```

Set both, reload the window, then log in once per config dir with the matching account.

If the sidebar still shows the wrong account after a reload while the terminal is correct, the machine-scoped setting is being ignored — use the integrated terminal for that project, or keep the user-level login as your default and override only the projects that need the other one.

### One trap worth knowing

`CLAUDE_CONFIG_DIR=~/.claude` is **not** the same as leaving it unset, even though `~/.claude` is the default directory. An explicit value selects a credential store at `~/.claude/.claude.json`, while unset uses the legacy `~/.claude.json`. Verified: `claude auth status` reports a logged-in account with the variable unset and no account with it set to `~/.claude`. A project configured that way looks mysteriously logged out. The view flags this case.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeAccount.expectedAccount` | `""` | The account this project should use. Exact email or `*@domain` wildcard. Set per project. |
| `claudeAccount.verifyWithCli` | `true` | Verify via `claude auth status --json`. This is the authoritative check. |
| `claudeAccount.claudePath` | `""` | Path to the `claude` executable. Empty auto-detects. |
| `claudeAccount.alertOnWrongAccount` | `true` | Notify when the live account does not match the expected one. |
| `claudeAccount.scanProjects` | `true` | Scan sibling projects for `CLAUDE_CONFIG_DIR` overrides. |
| `claudeAccount.projectsRoot` | `""` | Folder to scan. Empty means the parent of the current workspace. |
| `claudeAccount.refreshInterval` | `0` | Seconds between automatic re-reads. `0` disables polling; files are still watched. |
| `claudeAccount.statusBar` | `true` | Show the current account in the status bar. |

## Commands

| Command | Description |
|---------|-------------|
| `Set Expected Account For This Project` | Pin the account this project should use. |
| `Re-read Now` | Force a fresh read and re-verify. |
| `Show Details` | Full report as a markdown document, including the raw CLI JSON. |
| `Log In For This Config Dir` | Open a terminal with `CLAUDE_CONFIG_DIR` set and run `claude auth login`. |
| `Log Out Of This Config Dir` | Run `claude auth logout` for the current config dir, after confirmation. |

## How it works

1. Reads `.vscode/settings.json` off disk (tolerating comments and trailing commas) rather than through the configuration API, because a machine-scoped setting's workspace value is hidden from that API
2. Resolves `CLAUDE_CONFIG_DIR` separately for the terminal, the sidebar, and this extension host, applying each one's env block
3. Runs `claude auth status --json` per distinct config dir — omitting the variable entirely where nothing set it, since that is a distinct store
4. Falls back to reading `oauthAccount` from `<configDir>/.claude.json` (or `~/.claude.json` when unset) if the CLI is unavailable, and says so rather than implying the result is verified
5. Watches every file involved and re-reads on change, on window focus, and on demand

The cross-project audit reads from disk only — verifying it with the CLI would mean one subprocess per project.

## Development

```bash
npm install
npm run compile     # or: npm run watch
```

Press <kbd>F5</kbd> to launch an extension host with the extension loaded.
