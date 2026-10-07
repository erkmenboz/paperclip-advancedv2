---
title: Orca
summary: Run Paperclip heartbeats as visible Claude Code or Codex sessions in Orca terminals
---

The `orca_local` adapter runs each heartbeat inside [Orca](https://github.com/stablyai/orca), the desktop runtime for coding-agent worktrees and terminals. Paperclip stays the control plane: hiring, assignment, approvals, budgets, and the run log. Orca hosts the run in a terminal tab that you can watch, answer prompts in, or take over.

When an `orca_local` agent wakes, the adapter:

1. Opens a new terminal tab in the Orca worktree that contains the run's Paperclip workspace.
2. Starts the configured provider in the run's workspace directory with Paperclip's wake prompt.
3. Streams the provider's progress into the Paperclip run log.
4. Settles the run when the provider finishes its turn.

## Providers

| Provider | Runs as | How the run settles | Session continuity | Token usage |
|----------|---------|---------------------|--------------------|-------------|
| `claude` | Interactive Claude Code TUI | Orca status hooks report the turn `done` | Pinned with `--session-id`, resumed with `--resume` | Read from the pinned session transcript |
| `cursor` | Interactive Cursor Agent TUI | Orca status hooks | A chat created with `cursor-agent create-chat`, resumed with `--resume` | Not reported |
| `muse` | Interactive Muse TUI | Orca status hooks | Fresh session each heartbeat, plus Paperclip's session handoff | Not reported |
| `codex` | `codex exec` inside the tab | The provider exits | `codex exec resume <session id>` | Not reported |

Interactive providers pause the run at a permission prompt. The run log shows `Orca: waiting — Needs input in Orca (...)` until someone answers in the tab, unless `dangerouslySkipPermissions` is enabled.

### Models and thinking effort

The agent's model picker lists the selected provider's models:

- **Claude and Codex** use the same catalogs as `claude_local` and `codex_local`.
- **Cursor** lists every model your Cursor account offers (`cursor-agent --list-models`), for example Grok 4.7, Grok 4.6, Composer 2.5, Kimi K3, and Claude Fable.
- **Muse** lists `muse-spark-1.3`, plus the model your Muse settings name.

The thinking-effort picker shows the levels each provider accepts:

| Provider | Levels | Passed as |
|----------|--------|-----------|
| `claude` | low, medium, high, xhigh, max | `--effort` |
| `codex` | minimal, low, medium, high, xhigh | `-c model_reasoning_effort=` |
| `muse` | none, minimal, low, medium, high, xhigh, max, ultra | `--reasoning-effort` |
| `cursor` | low, medium, high, xhigh, max | The adapter switches to the model's matching variant, for example `grok-4.7-low` to `grok-4.7-xhigh`. If Cursor has no such variant, the run uses the selected model and logs a warning. |

## Prerequisites

- Orca installed and running on the same machine as the Paperclip server (`orca status` reports a reachable runtime).
- Orca agent status hooks enabled: `orca agent hooks on`. Claude supervision depends on them.
- The provider CLI (`claude`, `cursor-agent`, `muse`, or `codex`) installed and signed in, as it would be in any Orca terminal.
- The run's workspace inside a repository that Orca knows (`orca repo add --path <repo>`), or `orcaWorkspace` set on the agent.

## Configuration fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | Yes | `claude`, `cursor`, `muse`, or `codex` |
| `model` | string | No | Provider model ID. Omit it to use the provider default. |
| `effort` | string | No | Thinking effort; see the table above for each provider's levels |
| `orcaWorkspace` | string | No | Orca worktree selector for the terminal tab, such as `path:/abs/repo` or `id:<repo-id>::<path>`. Default: the git root of the run's workspace. |
| `cwd` | string | No | Fallback working directory when the run has no project workspace |
| `terminalRetention` | string | No | `keep` (default) leaves the tab open after a run. `close` closes it when the run succeeds. Failed and cancelled runs always keep their tab. |
| `trustWorkspace` | boolean | No | Answers Claude's first-run "do you trust this folder?" dialog, but only when it names the run's own workspace. Default `true`. With it off, the run waits until someone answers in the tab. |
| `dangerouslySkipPermissions` | boolean | No | Adds `--dangerously-skip-permissions` (Claude) or `--dangerously-bypass-approvals-and-sandbox` (Codex). Off by default. |
| `codexSandbox` | string | No | Codex sandbox mode when permissions are not bypassed. Default `workspace-write`. |
| `networkAccess` | boolean | No | Lets the Codex and Muse sandboxes reach the network, which the agent needs for the Paperclip API. Default `true`. |
| `timeoutSec` | number | No | Interrupts the run after this many seconds. `0` (the default) means no limit. |
| `startupTimeoutSec` | number | No | How long the provider has to start its turn. Default `120`. |
| `pollIntervalSec` | number | No | Supervision poll cadence. Default `2`. |
| `orcaCommand` | string | No | Path to the Orca CLI. Default `orca`. |
| `providerCommand` | string | No | Provider binary override |
| `extraArgs` | string[] | No | Extra provider arguments |
| `instructionsFilePath` | string | No | Agent instructions file prepended to the prompt |
| `promptTemplate` | string | No | Heartbeat prompt template |
| `env` | object | No | Extra environment variables for the provider (supports secret refs) |

## How credentials reach the agent

The provider needs the same `PAPERCLIP_*` environment as `claude_local`, including the run's API token. The adapter writes these variables to a private file (mode `0600`, in a `0700` temp directory outside the workspace). The only command typed into the Orca tab is `sh '<run dir>/launch.sh'`. The launcher sources the file, deletes it, and starts the provider. The token never appears in the prompt, the terminal scrollback, or shell history.

The adapter calls the `orca` CLI without any `ORCA_*` variables. If the Paperclip server was started from an Orca terminal, the adapter therefore does not act as that terminal.

## Kept tabs and credentials

With `terminalRetention: keep`, the provider stays open in its tab after the run settles, and its process still holds that run's Paperclip credentials. Paperclip attributes anything you ask it there afterwards to the finished run. To start new work, assign or comment on an issue, which starts a fresh run with fresh credentials.

## Limitations

- Local Orca only. The adapter cannot target a paired remote Orca server.
- Codex, Cursor, and Muse runs report no token usage, so budgets do not count their spend.
- Cancelling a run sends Ctrl-C to the tab and keeps it open.
