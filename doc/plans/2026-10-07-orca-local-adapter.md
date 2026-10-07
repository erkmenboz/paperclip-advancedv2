# Orca Local Adapter — Technical Plan

## Overview

This plan defines an `orca_local` adapter. Paperclip uses it to run agent
heartbeats inside [Orca](https://github.com/stablyai/orca), a desktop runtime
that manages worktrees, terminals, and coding-agent CLIs.

The operator gets one control plane and one execution surface:

- **Paperclip** owns the following: hiring, task assignment, approvals, budgets,
  the run log, and issue state.
- **Orca** owns the following: the visible agent terminal, provider launch
  (`claude`, `codex`, `cursor-agent`, `muse`), provider status hooks, and live
  human takeover of a running agent.

Assigning an issue to an `orca_local` agent wakes the agent. The heartbeat then
opens a terminal in Orca, starts the configured provider CLI with the Paperclip
wake prompt, and streams status into the Paperclip run log. The heartbeat
settles when the provider reports that its turn is done.

## Findings that shape the design

These facts were verified against Orca 1.4.221 (`orca agent-context --json`,
the bundled `orchestration` and `orca-cli` skill guides, and the CLI source in
`Orca.app/Contents/Resources/app.asar.unpacked/out/cli`).

1. **Orca orchestration requires a coordinator terminal.** The commands
   `orchestration run-create`, `task-create`, and `worker-start` resolve a
   coordinator terminal handle. The handle comes from `ORCA_TERMINAL_HANDLE`,
   from `--from`, or from an unambiguous terminal at the current directory.
   The Paperclip server is a headless process, so it has no handle. The Orca
   CLI error for this case says to drive the agent directly with
   `terminal create` and `terminal read`. For that reason, V1 does not use
   orchestration Runs or Dispatches.
2. **Workspace selection uses exact roots.** `--worktree path:<abs>` resolves
   only the exact root of a worktree that Orca already knows. A subdirectory or
   an unregistered folder returns the error `selector_not_found`. Errors come
   back as `{ ok: false, error: { code, message, data } }` JSON.
3. **Provider status comes from Orca hooks.** `orca worktree ps --json` lists
   one row per agent pane (`paneKey = <tabId>:<leafId>`). Each row has a
   `state` (`working | blocked | waiting | done`), plus `stateStartedAt`,
   `toolName`, `toolInput`, `lastAssistantMessage`, and `interrupted`.
   `orca terminal show --json` gives `tabId`, `leafId`, `agentIdentity`, and
   `agentWait`.
4. **Provider inventory is available.** `orca agent hooks status --json` lists
   each provider, whether it is installed, and whether `managedHooksPresent` is
   true. On the reference machine the providers are `claude`, `codex`,
   `cursor`, and `muse`.
5. **Orca exposes no provider session ID or token usage.** Conversation
   continuity must therefore come from the adapter pinning the provider
   session. Claude supports this with `--session-id` and `--resume`.
6. **A Paperclip run JWT stays valid after its run ends.** The default lifetime
   is 48 hours. The token carries `run_id`, and the server rejects a request
   whose `X-Paperclip-Run-Id` header does not match it. An agent process reused
   across heartbeats would keep an old run's credentials and attribute its work
   to that finished run. V1 therefore starts a fresh agent process on every
   heartbeat.

## Live spike results (2026-10-07, Orca 1.4.221)

These checks ran from a neutral caller with every `ORCA_*` variable removed,
against the `paperclip` worktree:

- `terminal create --worktree path:<root> --command "sh '<dir>/launch.sh'"`
  works. Its JSON result already includes `handle`, `tabId`, and `paneKey`, so
  no `terminal show` call is needed to bind the pane.
- **Claude, interactive.** The pane's status row moved `working`, then
  `waiting` (a Bash permission prompt with `toolName` and `toolInput` filled in
  and `agentWait.source=hook`), then `done`, with `lastAssistantMessage` set to
  the reply. The launcher's env file was sourced, deleted, and inherited by the
  agent's tool subprocess.
- **Claude, argument order.** `--allowedTools` is variadic and swallows a
  trailing positional prompt. The prompt must come first:
  `claude "<prompt>" --session-id <uuid> ...`. In that order the prompt is
  submitted automatically.
- **Claude, existing status rows.** A pane can report `done` before any turn
  has run. Completion therefore requires a `working` state seen after launch,
  or a row whose `prompt` matches the prompt the adapter sent.
- **Claude transcript.** The pinned session transcript is
  `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`. Its `assistant` entries
  carry `message.id`, `message.model`, `message.usage`, and `timestamp`. V1 sums
  the usage of this turn, deduplicated by message ID, so budgets keep working.
- **Codex, interactive.** Orca reports no status row. Orca installs its Codex
  hooks only in its managed `CODEX_HOME`. Using that home from outside Orca
  ends at a sign-in screen. In the interactive TUI, the tool shell also did not
  see the launcher's env. Codex therefore runs headless in V1: `codex exec`
  inside the Orca terminal (the same mode `codex_local` uses), and completion
  comes from the launcher's exit sentinel.
- **`terminal close --tab`** reports `ptyKilled: false`, but the processes
  ended and `terminal list` no longer showed the tabs.
- **`terminal send --text ... --enter --wait-submit <s>`** returns the stages
  `input_accepted` and `turn_started` for Claude. A reusable-terminal mode
  could build on this later.

## Live verification of the adapter (2026-10-07)

These runs called `execute()` from the adapter source against the real Orca
runtime and real provider CLIs, without a Paperclip server:

- **Claude, permissions on.** The run log showed `working`, then the Bash
  tool call from the transcript, then `waiting` with the exact pending command.
  `timeoutSec` then interrupted the run and settled it as `timed_out`. Usage
  and model came from the transcript. The tab was kept for inspection.
- **Claude, `dangerouslySkipPermissions`.** The run succeeded with summary
  `ORCA-LIVE-OK live-check-claude`, which proves `PAPERCLIP_RUN_ID` reached the
  tool shell. `terminalRetention: close` closed the tab.
- **Claude resume.** A second run with the first run's `sessionParams` launched
  with `--resume <id>`. The model recalled its previous reply, and usage
  counted only the new turn.
- **Codex headless.** `codex exec` in the tab streamed its output. The env
  reached the sandboxed shell, the session ID and model came from Codex's
  header, the summary came from `-o`, and the exit code was 0.
- No run directories or tabs leaked afterwards.

The launcher traps `INT` and `TERM` and records exit code 130 or 143. In a
real tab, Ctrl-C reaches the whole foreground job. Without the trap, a headless
cancel would wait out the full stop grace period with no exit code.

## Folder trust (found in the first real hires, 2026-10-07)

The first Paperclip-driven runs (a CTO agent on its agent-home workspace)
failed with `orca_startup_timeout`. Interactive Claude shows a "do you trust
this folder?" dialog for every folder it has not opened before, with the
cursor on "No, exit". Status hooks do not fire before the session starts, so
the run waited until the startup timeout. `claude_local` never sees this dialog
because print mode skips it. The adapter now answers this dialog by default
(`trustWorkspace`). It acts only when the dialog names the run's workspace,
and it presses Enter only after confirming the cursor is on the trust option.
Claude then records the trust itself. A manual probe confirmed the keystrokes
(Down, then Enter). After that, Claude submitted the queued prompt by itself.

## Cursor, Muse, models, and effort (2026-10-07)

- Two new providers run interactively and are supervised through Orca hooks:
  `cursor` (`cursor-agent`) and `muse`. Orca installs hooks for both in their
  global config files (`~/.cursor/hooks.json` and `~/.config/muse/settings.json`).
- Cursor sessions are pinned with `cursor-agent create-chat` and resumed with
  `--resume`. Muse starts fresh on each heartbeat; `muse resume` takes only an
  existing session reference, so there is no ID to pin up front.
- The models API (`/adapters/orca_local/models?provider=`) returns the list for
  the selected provider: Claude and Codex reuse their local catalogs, Cursor
  parses `--list-models` (246 models on the reference account, labels kept),
  and Muse uses its catalog plus the model named in the operator's Muse
  settings.
- `effort` sets the thinking level: Claude `--effort`, Codex
  `model_reasoning_effort`, and Muse `--reasoning-effort`. Cursor has no effort
  flag and encodes effort in its model IDs, so the adapter switches to the
  matching variant.
- These still need live confirmation through a Paperclip run: hook status
  rows for a `cursor-agent` or `muse` typed into a tab, `PAPERCLIP_*`
  reaching their tool shells, and Muse's sandbox reaching the local Paperclip
  API.

## Decisions

- Terminal retention: **keep** by default, as the operator chose. Kept tabs
  hold the finished run's credentials in the agent's process environment, so a
  manual follow-up typed into that tab is attributed to that finished run. This
  caveat appears in `agentConfigurationDoc`.
- Supervision mode follows the provider. `claude` runs interactively and is
  supervised through hook status. `codex` runs headless and is supervised
  through its exit code. `cursor` and `muse` are follow-ups.

## Heartbeat lifecycle

```
execute(ctx)
  1. resolve Orca workspace     orca worktree show --worktree <selector> --json
  2. prepare private run dir    mkdtemp (0700): env (0600), prompt.md, launch.sh
  3. open terminal              orca terminal create --worktree <sel> --title <t>
                                  --command "sh '<runDir>/launch.sh'" --json
  4. bind pane                  orca terminal show --terminal <h> --json -> tabId:leafId
  5. supervise (poll)           orca worktree ps --json (status row for our pane)
                                orca terminal show (liveness, agentWait)
                                <runDir>/exit-code (launcher exit sentinel)
  6. settle                     state=done after launch      -> success
                                terminal or provider exited  -> failure
                                ctx.signal aborted           -> interrupt and close
                                timeoutSec elapsed           -> interrupt and close
  7. cleanup                    rm the run dir; close the terminal only if terminalRetention=close
```

### Workspace resolution

Paperclip resolves the execution workspace (`context.paperclipWorkspace.cwd`).
That directory stays the only persistence boundary across runs, as the
no-remote-git contract in `packages/adapters/AUTHORING.md` requires. The Orca
worktree only hosts the terminal tab. The launcher always runs
`cd "<paperclip cwd>"` before it starts the provider.

The adapter picks the Orca selector in this order:

1. `orcaWorkspace` from the adapter config, which is an explicit Orca selector
   such as `path:/abs` or `id:<repo>::<path>`.
2. `path:<git toplevel of cwd>`, when Orca knows that worktree.
3. Otherwise the run fails with a clear message and hint (register the repo
   with `orca repo add`, or set `orcaWorkspace`). V1 does not register repos
   automatically, because that would change Orca state as a side effect.

### Credentials

The agent needs the same `PAPERCLIP_*` environment that `claude_local` gets:
API URL, run JWT, run, agent, company, and task IDs, wake reason, and
workspace variables. The run JWT must never appear in a prompt, in terminal
scrollback, or in shell history. The flow is:

- The adapter writes `env` (mode 0600) into a `mkdtemp` directory (mode 0700)
  outside the workspace.
- The terminal receives only `sh '<runDir>/launch.sh'`.
- `launch.sh` runs `set -a; . ./env; set +a`, deletes `env`, changes into the
  workspace, and runs the provider. The provider and its tool subprocesses
  inherit the environment, so the `paperclip` skill works unchanged.
- The `finally` block removes the run directory.

The adapter calls the `orca` CLI with every `ORCA_*` terminal-identity variable
removed. If the Paperclip server was started from an Orca terminal, the adapter
must not act as that terminal.

### Provider launch

| Provider | Command        | Model flag | Initial prompt  | Session pinning                       |
| -------- | -------------- | ---------- | --------------- | ------------------------------------- |
| claude   | `claude`       | `--model`  | positional      | `--session-id <uuid>`, `--resume <uuid>` |
| codex    | `codex`        | `-m`       | positional      | fresh session plus Paperclip handoff  |
| cursor   | `cursor-agent` | `--model`  | positional      | fresh session plus Paperclip handoff  |
| muse     | `muse`         | `--model`  | positional      | fresh session plus Paperclip handoff  |

The provider runs interactively, so the operator can watch it or take it over
in Orca. Permission prompts move the status to `waiting` or `blocked`. The
adapter logs this ("waiting for input in Orca terminal <title>") and keeps
waiting. An operator can answer in Orca, or opt in with
`dangerouslySkipPermissions`.

### Sessions

`sessionParams = { provider, providerSessionId?, cwd, orcaWorktreeId }`.
For Claude, the adapter resumes `providerSessionId` when `provider` and `cwd`
match the current run. Other providers start fresh and receive Paperclip's
fresh-session handoff (`hydrateFreshSessionHandoff`).

### Run-log output

The adapter emits JSONL events on stdout. The UI and CLI parsers render them as
transcript entries:

- `orca.init`: provider, terminal handle, pane, and Orca worktree
- `orca.status`: state transitions (`working`, `waiting`, and so on)
- `orca.tool`: changes to `toolName` and `toolInput`
- `orca.assistant`: changes to `lastAssistantMessage`
- `orca.result`: the final outcome; `lastAssistantMessage` becomes the run
  summary

Token usage and cost are not available from Orca in V1. Runs report
`usage: null` and `costUsd: null`. Budget hard-stops therefore do not count
these runs. This limitation is documented in `agentConfigurationDoc`.

## Configuration (`adapterConfig`)

| Field                       | Type     | Default | Notes                                                  |
| --------------------------- | -------- | ------- | ------------------------------------------------------ |
| `provider`                  | string   | —       | Required. `claude` or `codex` in V1                    |
| `model`                     | string   | —       | Provider model ID; omitted means the provider default  |
| `orcaWorkspace`             | string   | —       | Explicit Orca selector that hosts the terminal         |
| `orcaCommand`               | string   | `orca`  | Path to the Orca CLI                                   |
| `providerCommand`           | string   | —       | Overrides the provider binary                          |
| `extraArgs`                 | string[] | `[]`    | Appended to the provider argv                          |
| `dangerouslySkipPermissions`| boolean  | false   | Adds the provider's bypass-permissions flag            |
| `terminalRetention`         | string   | `keep`  | `keep` or `close` after the run settles                |
| `pollIntervalSec`           | number   | 3       | Supervision poll cadence                               |
| `startupTimeoutSec`         | number   | 120     | Time allowed for the provider status row to appear     |
| `timeoutSec`                | number   | 0       | 0 means no limit                                       |
| `promptTemplate`, `bootstrapPromptTemplate`, `instructionsFilePath`, `env` | — | — | Same meaning as in `claude_local` |

## `testEnvironment`

- The Orca CLI resolves, and `orca status --json` reports a reachable runtime.
- `orca agent hooks status --json` shows that hooks are enabled and the
  configured provider is installed with managed hooks.
- The provider binary resolves on `PATH`.
- `orcaWorkspace`, when set, resolves through `orca worktree show`.

## Files

New package `packages/adapters/orca-local/` (`@paperclipai/adapter-orca-local`):

- `src/index.ts`: type, label, models, `agentConfigurationDoc`
- `src/server/{index,execute,orca-cli,launcher,supervise,session,test}.ts`
- `src/ui/{index,build-config,parse-stdout}.ts`
- `src/cli/{index,format-event}.ts`

Registration (following `cursor_cloud`):

- `server/src/adapters/registry.ts`, `server/src/adapters/builtin-adapter-types.ts`
- `cli/src/adapters/registry.ts`
- `ui/src/adapters/orca-local/index.ts`, `ui/src/adapters/registry.ts`,
  `ui/src/adapters/adapter-display-registry.ts`
- `packages/shared/src/constants.ts` (`AGENT_ADAPTER_TYPES`)
- `packages/adapter-utils/src/session-compaction.ts`
- `server/package.json`, `ui/package.json`, `cli/package.json`,
  `scripts/release-package-manifest.json`
- `docs/adapters/orca-local.md`

The telemetry contract is not changed. Telemetry emitters send the raw adapter
type, and the receiving layer canonicalizes it
(`packages/shared/src/telemetry/README.md`).

## Phases

0. **Live spike (needs operator approval, because it writes Orca state).**
   From a neutral caller (no `ORCA_*` variables), run
   `terminal create --command` in a known worktree. Confirm that hook status
   rows appear for that pane, with `working` changing to `done`, for `claude`
   and `codex`. Confirm that `terminal close` cleans up.
1. **Adapter core.** Write `orca-cli` (a typed JSON wrapper), the launcher, and
   the supervision loop. Unit-test them against a scripted fake `orca`
   executable.
2. **Registration.** Register the adapter in server, UI, and CLI, add the
   schema-driven config form, and add the stdout parser.
3. **Live verification.** Hire an `orca_local` agent, assign an issue, watch the
   run in Orca and in the Paperclip run log, then cancel a run.
4. **Follow-ups.** Read Claude token usage from the pinned session transcript
   to support budgets. Support remote Orca servers (`--environment`) together
   with workspace transport. Register repos automatically (opt-in).
