import { execFile } from "node:child_process";

/**
 * Typed wrapper over the `orca` CLI's `--json` envelope.
 *
 * Every call runs as a neutral caller: Orca derives orchestration identity,
 * workspace defaults, and remote routing from `ORCA_*` variables (and
 * `TMUX_PANE`). When the Paperclip server itself was started from an Orca
 * terminal those variables would make the adapter act as that terminal, so
 * they are stripped from the child environment.
 */

const ORCA_CONTEXT_ENV_PATTERN = /^(ORCA_|JCODE_)/;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export type OrcaExec = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;

export class OrcaCliError extends Error {
  readonly code: string;
  readonly data: Record<string, unknown> | null;

  constructor(code: string, message: string, data: Record<string, unknown> | null = null) {
    super(message);
    this.name = "OrcaCliError";
    this.code = code;
    this.data = data;
  }
}

export function buildNeutralOrcaEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (ORCA_CONTEXT_ENV_PATTERN.test(key) || key === "TMUX_PANE") continue;
    env[key] = value;
  }
  if (env.TERM_PROGRAM === "Orca") delete env.TERM_PROGRAM;
  return env;
}

export const defaultOrcaExec: OrcaExec = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env: options.env, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
          // Spawn failures (ENOENT, EACCES) carry a string code; non-zero exits carry a number.
          reject(error);
          return;
        }
        if (error && (error as { killed?: boolean }).killed) {
          reject(new OrcaCliError("orca_timeout", `orca ${args.slice(0, 2).join(" ")} timed out after ${options.timeoutMs}ms`));
          return;
        }
        const exitCode = error ? ((error as { code?: number | null }).code ?? null) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
      },
    );
  });

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Last JSON object printed on stdout; Orca prints one envelope per `--json` call. */
function parseEnvelope(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    const start = trimmed.lastIndexOf("\n{");
    if (start < 0) return null;
    try {
      return asRecord(JSON.parse(trimmed.slice(start + 1)));
    } catch {
      return null;
    }
  }
}

export interface OrcaWorktree {
  id: string;
  path: string;
  displayName: string | null;
}

export interface OrcaTerminal {
  handle: string;
  paneKey: string | null;
  tabId: string | null;
  worktreeId: string | null;
  title: string | null;
}

export interface OrcaTerminalState {
  handle: string;
  connected: boolean;
  agentIdentity: string | null;
  /** Non-null when Orca proved the agent is parked on a prompt only a human can answer. */
  agentWait: Record<string, unknown> | null;
}

export type OrcaAgentState = "working" | "blocked" | "waiting" | "done";

export interface OrcaAgentStatus {
  paneKey: string;
  state: OrcaAgentState | null;
  stateStartedAt: number | null;
  updatedAt: number | null;
  agentType: string | null;
  prompt: string | null;
  toolName: string | null;
  toolInput: string | null;
  lastAssistantMessage: string | null;
  interrupted: boolean;
}

export interface OrcaProviderHookStatus {
  agent: string;
  state: string;
  managedHooksPresent: boolean;
}

export interface OrcaHooksStatus {
  enabled: boolean;
  providers: OrcaProviderHookStatus[];
}

export interface OrcaRuntimeStatus {
  reachable: boolean;
  state: string | null;
  appVersion: string | null;
}

const AGENT_STATES = new Set<OrcaAgentState>(["working", "blocked", "waiting", "done"]);
const TERMINAL_GONE_CODES = new Set([
  "terminal_gone",
  "terminal_not_found",
  "terminal_exited",
  "terminal_handle_stale",
  "selector_not_found",
]);

export class OrcaCli {
  private readonly command: string;
  private readonly exec: OrcaExec;
  private readonly env: NodeJS.ProcessEnv;

  constructor(input: { command?: string; exec?: OrcaExec; env?: NodeJS.ProcessEnv } = {}) {
    this.command = input.command?.trim() || "orca";
    this.exec = input.exec ?? defaultOrcaExec;
    this.env = buildNeutralOrcaEnv(input.env ?? process.env);
  }

  /** Run one `orca ... --json` call and return its `result`, or throw `OrcaCliError`. */
  async call(args: string[], timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<Record<string, unknown>> {
    let output: Awaited<ReturnType<OrcaExec>>;
    try {
      output = await this.exec(this.command, [...args, "--json"], { env: this.env, timeoutMs });
    } catch (err) {
      if (err instanceof OrcaCliError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new OrcaCliError("orca_not_found", `Orca CLI "${this.command}" was not found on PATH.`);
      }
      throw new OrcaCliError("orca_spawn_failed", err instanceof Error ? err.message : String(err));
    }
    const envelope = parseEnvelope(output.stdout);
    if (!envelope) {
      const detail = (output.stderr || output.stdout).trim().slice(0, 500);
      throw new OrcaCliError(
        "orca_invalid_response",
        `orca ${args.slice(0, 2).join(" ")} returned no JSON envelope (exit ${output.exitCode ?? "unknown"})${detail ? `: ${detail}` : ""}`,
      );
    }
    if (envelope.ok !== true) {
      const error = asRecord(envelope.error);
      throw new OrcaCliError(
        asString(error?.code) ?? "orca_error",
        asString(error?.message) ?? `orca ${args.slice(0, 2).join(" ")} failed`,
        asRecord(error?.data),
      );
    }
    return asRecord(envelope.result) ?? {};
  }

  async status(): Promise<OrcaRuntimeStatus> {
    const result = await this.call(["status"]);
    const runtime = asRecord(result.runtime);
    return {
      reachable: runtime?.reachable === true,
      state: asString(runtime?.state),
      appVersion: asString(runtime?.appVersion),
    };
  }

  async hooksStatus(): Promise<OrcaHooksStatus> {
    const result = await this.call(["agent", "hooks", "status"]);
    const providers = Array.isArray(result.statuses)
      ? result.statuses.flatMap((entry) => {
          const row = asRecord(entry);
          const agent = asString(row?.agent);
          if (!row || !agent) return [];
          return [{ agent, state: asString(row.state) ?? "unknown", managedHooksPresent: row.managedHooksPresent === true }];
        })
      : [];
    return { enabled: result.enabled === true, providers };
  }

  /** Resolve a worktree selector; returns null when Orca reports `selector_not_found`. */
  async findWorktree(selector: string): Promise<OrcaWorktree | null> {
    try {
      const result = await this.call(["worktree", "show", "--worktree", selector]);
      const worktree = asRecord(result.worktree);
      const id = asString(worktree?.id);
      const worktreePath = asString(worktree?.path);
      if (!id || !worktreePath) return null;
      return { id, path: worktreePath, displayName: asString(worktree?.displayName) };
    } catch (err) {
      if (err instanceof OrcaCliError && err.code === "selector_not_found") return null;
      throw err;
    }
  }

  async createTerminal(input: { worktree: string; title: string; command: string }): Promise<OrcaTerminal> {
    const result = await this.call([
      "terminal", "create",
      "--worktree", input.worktree,
      "--title", input.title,
      "--command", input.command,
    ]);
    const terminal = asRecord(result.terminal);
    const handle = asString(terminal?.handle);
    if (!handle) throw new OrcaCliError("orca_invalid_response", "orca terminal create returned no terminal handle.");
    return {
      handle,
      paneKey: asString(terminal?.paneKey),
      tabId: asString(terminal?.tabId),
      worktreeId: asString(terminal?.worktreeId),
      title: asString(terminal?.title),
    };
  }

  /** Terminal liveness; returns null when the handle no longer resolves. */
  async showTerminal(handle: string): Promise<OrcaTerminalState | null> {
    try {
      const result = await this.call(["terminal", "show", "--terminal", handle]);
      const terminal = asRecord(result.terminal);
      if (!terminal) return null;
      return {
        handle,
        connected: terminal.connected !== false,
        agentIdentity: asString(terminal.agentIdentity),
        agentWait: asRecord(terminal.agentWait),
      };
    } catch (err) {
      if (err instanceof OrcaCliError && TERMINAL_GONE_CODES.has(err.code)) return null;
      throw err;
    }
  }

  async readScreen(handle: string): Promise<string[]> {
    const result = await this.call(["terminal", "read", "--terminal", handle, "--screen"]);
    const terminal = asRecord(result.terminal);
    return Array.isArray(terminal?.tail) ? terminal.tail.filter((line): line is string => typeof line === "string") : [];
  }

  /** Write raw input (keystrokes) to the terminal without pressing Enter. */
  async sendInput(handle: string, text: string): Promise<void> {
    await this.call(["terminal", "send", "--terminal", handle, "--text", text]);
  }

  async interrupt(handle: string): Promise<void> {
    await this.call(["terminal", "send", "--terminal", handle, "--interrupt"]);
  }

  async closeTerminal(handle: string): Promise<void> {
    await this.call(["terminal", "close", "--terminal", handle, "--tab"]);
  }

  /** Hook-reported status of the agent running in `paneKey`, or null when Orca has none. */
  async agentStatus(paneKey: string): Promise<OrcaAgentStatus | null> {
    const result = await this.call(["worktree", "ps", "--limit", "500"]);
    const worktrees = Array.isArray(result.worktrees) ? result.worktrees : [];
    for (const entry of worktrees) {
      const agents = asRecord(entry)?.agents;
      if (!Array.isArray(agents)) continue;
      for (const candidate of agents) {
        const row = asRecord(candidate);
        if (!row || row.paneKey !== paneKey) continue;
        const state = asString(row.state);
        return {
          paneKey,
          state: state && AGENT_STATES.has(state as OrcaAgentState) ? (state as OrcaAgentState) : null,
          stateStartedAt: asNumber(row.stateStartedAt),
          updatedAt: asNumber(row.updatedAt),
          agentType: asString(row.agentType),
          prompt: asString(row.prompt),
          toolName: asString(row.toolName),
          toolInput: asString(row.toolInput),
          lastAssistantMessage: asString(row.lastAssistantMessage),
          interrupted: row.interrupted === true,
        };
      }
    }
    return null;
  }
}
