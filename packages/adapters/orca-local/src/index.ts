export const type = "orca_local";
export const label = "Orca";

/** Orca agent providers this adapter can launch, with how each one is supervised. */
export const ORCA_PROVIDERS = [
  { id: "claude", label: "Claude Code", mode: "interactive" },
  { id: "codex", label: "Codex", mode: "headless" },
  { id: "cursor", label: "Cursor", mode: "interactive" },
  { id: "muse", label: "Muse", mode: "interactive" },
] as const;

export type OrcaProviderId = (typeof ORCA_PROVIDERS)[number]["id"];

/**
 * Thinking-effort levels each provider CLI accepts, in ascending order.
 * Claude: --effort; Codex: model_reasoning_effort; Muse: --reasoning-effort;
 * Cursor encodes effort in the model id (grok-4.7-high), so the adapter
 * switches to the matching model variant.
 */
export const ORCA_PROVIDER_EFFORTS: Record<OrcaProviderId, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  cursor: ["low", "medium", "high", "xhigh", "max"],
  muse: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
};

/** Muse has no model-list command; this is its published catalog. */
export const MUSE_MODELS = [{ id: "muse-spark-1.3", label: "Muse Spark 1.3" }];

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# orca_local agent configuration

Adapter: orca_local

Use when:
- The operator runs Orca (the desktop agent runtime) on the same machine as Paperclip and wants every heartbeat to be visible, and steerable, as an Orca terminal
- The agent should run through a provider CLI that Orca already manages (Claude Code or Codex)
- A human may need to answer permission prompts or take over a running agent from Orca

Don't use when:
- Orca is not installed or its runtime is not running on the Paperclip host (use claude_local or codex_local)
- The run must be fully unattended with no operator watching Orca and no permission bypass (an interactive Claude prompt waits until someone answers it)
- The agent must run on a remote machine (orca_local drives the local Orca runtime only)

Core fields:
- provider (string, required): "claude", "cursor", or "muse" (interactive in the Orca tab, supervised through Orca status hooks), or "codex" (headless codex exec inside the Orca tab, supervised by exit code)
- model (string, optional): provider model id; omit to use the provider default. Cursor accepts any id from \`cursor-agent --list-models\` (for example grok-4.7-high, composer-2.5, kimi-k3-max, claude-fable-5-1-high); Muse uses muse-spark-1.3
- effort (string, optional): thinking effort. claude: low|medium|high|xhigh|max; codex: minimal|low|medium|high|xhigh; muse: none|minimal|low|medium|high|xhigh|max|ultra; cursor: low|medium|high|xhigh|max, applied by switching to the model's matching effort variant (grok-4.7-low → grok-4.7-xhigh) when Cursor offers it
- orcaWorkspace (string, optional): Orca worktree selector that hosts the terminal tab, such as "path:/abs/repo" or "id:<repo-id>::<path>". Default: the git root of the run's workspace, which must already be an Orca worktree
- cwd (string, optional): fallback working directory when the run has no project workspace
- orcaCommand (string, optional): path to the Orca CLI. Default "orca"
- providerCommand (string, optional): provider binary override ("claude" or "codex" by default)
- extraArgs (string[], optional): extra provider arguments, appended after the adapter's own
- dangerouslySkipPermissions (boolean, optional, default false): claude --dangerously-skip-permissions; codex --dangerously-bypass-approvals-and-sandbox. Dangerous: the agent runs every tool call without asking
- trustWorkspace (boolean, optional, default true): answer Claude's first-run "do you trust this folder?" dialog for the run's own workspace. Interactive Claude shows it for every folder it has not opened before (agent-home workspaces included), and it would otherwise stall the run. Only the dialog naming the run's workspace is answered
- codexSandbox (string, optional, default "workspace-write"): codex sandbox mode when permissions are not bypassed
- networkAccess (boolean, optional, default true): let codex and muse sandboxes reach the network, which the agent needs for the Paperclip API
- terminalRetention (string, optional, default "keep"): "keep" leaves the Orca tab open after the run; "close" closes it when the run succeeds
- pollIntervalSec (number, optional, default 2): supervision poll cadence
- startupTimeoutSec (number, optional, default 120): how long to wait for the provider to start its turn
- timeoutSec (number, optional, default 0): hard run limit; 0 means no limit
- instructionsFilePath (string, optional): agent instructions file prepended to the prompt
- promptTemplate (string, optional): heartbeat prompt template
- bootstrapPromptTemplate (string, optional): first-run-only bootstrap prompt template
- env (object, optional): extra environment variables for the provider process

Notes:
- Every heartbeat opens a new Orca terminal tab in the selected worktree and runs the provider in the run's Paperclip workspace directory. The workspace stays the source of truth; nothing is pushed.
- PAPERCLIP_* variables (including the run token) reach the provider through a private file that the launcher sources and deletes. They never appear in the prompt, the terminal, or shell history.
- Claude sessions are pinned with --session-id and resumed with --resume; Cursor chats are created with cursor-agent create-chat and resumed with --resume; Codex sessions resume with codex exec resume. Muse starts a fresh session each heartbeat and gets Paperclip's session handoff.
- Claude token usage is read from the pinned session transcript. Codex, Cursor, and Muse runs report no token usage, so budgets do not count them.
- With terminalRetention "keep", a finished run's tab still holds that run's credentials. Anything typed into it afterwards is attributed to the finished run; start new work by assigning an issue instead.
- Orca must have agent status hooks enabled (orca agent hooks on) for Claude supervision.
`;
