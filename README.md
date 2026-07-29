# Claude Account

Shows which Claude Code account this VS Code window actually uses — read live from disk, never cached — and audits whether your projects really have separate logins.

## Why

The Claude Code sidebar caches login info in memory from when the window started, while API calls read credentials live. Log in from another window and the display goes stale while requests use the new credentials. That is why `/account` can disagree with reality and `/status` does not.

This extension never caches. Every render re-reads the files, so what you see is what the next `claude` run will use.

## Features

- **Live account** — the email, organization, and role for this window, re-read from disk on every render, on window focus, and whenever the underlying files change
- **Config dir in effect** — the resolved `CLAUDE_CONFIG_DIR` and where it came from (process env, workspace settings, or the default)
- **Who uses what** — the terminal and the Claude Code sidebar resolve `CLAUDE_CONFIG_DIR` differently; this shows each one's account side by side and warns when they disagree
- **API key warnings** — flags `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in the environment or in a settings file, since a key silently supersedes any login
- **Isolation audit** — scans sibling projects for `CLAUDE_CONFIG_DIR` overrides and flags any two projects pointing at the same dir, because those share one login rather than having separate ones
- **Status bar** — current account at a glance, click for a full report

## How isolation works

On macOS, credentials live in the Keychain keyed by `CLAUDE_CONFIG_DIR`. Separate dirs are fully separate logins:

```jsonc
// <project>/.vscode/settings.json
{
  // Applies to `claude` run in the integrated terminal. Reliably honoured.
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

Set both, reload the window, then run `claude` → `/login` once per config dir with the matching account.

If the sidebar still shows the wrong account after a reload while the terminal is correct, the machine-scoped setting is being ignored — use the integrated terminal for that project, or keep the user-level login as your default account and override only the projects that need the other one.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeAccount.scanProjects` | `true` | Scan sibling projects for `CLAUDE_CONFIG_DIR` overrides. |
| `claudeAccount.projectsRoot` | `""` | Folder to scan. Empty means the parent of the current workspace. |
| `claudeAccount.refreshInterval` | `0` | Seconds between automatic re-reads. `0` disables polling; files are still watched. |
| `claudeAccount.statusBar` | `true` | Show the current account in the status bar. |

## Commands

| Command | Description |
|---------|-------------|
| `Claude Account: Re-read Now` | Force a fresh read of every source. |
| `Claude Account: Show Details` | Open a full report as a markdown document. |
| `Claude Account: Log In For This Config Dir` | Open a terminal with `CLAUDE_CONFIG_DIR` set and start `claude`, ready for `/login`. |
| `Claude Account: Probe Keychain For Credentials` | Best-effort check for Keychain entries. Existence only — reads no secrets, so it does not prompt. |

## How it works

1. Reads `.vscode/settings.json` off disk (tolerating comments and trailing commas) rather than through the configuration API, because a machine-scoped setting's workspace value is hidden from that API
2. Resolves `CLAUDE_CONFIG_DIR` separately for the terminal, the sidebar, and this extension host
3. Reads the account from `<configDir>/.claude.json` — or `~/.claude.json` when no config dir is set — taking `oauthAccount`
4. Watches every file involved and re-reads on change, on window focus, and on demand

The reported account comes from `.claude.json`, the reliable on-disk signal. The Keychain probe is a diagnostic: Claude Code does not document its Keychain service naming for custom config dirs, so an `absent` result there is not proof of a missing login.

## Development

```bash
npm install
npm run compile     # or: npm run watch
```

Press <kbd>F5</kbd> to launch an extension host with the extension loaded.
