import fs from "node:fs/promises";
import type { OrcaLocalEvent } from "../events.js";
import type { OrcaAgentStatus, OrcaTerminalState } from "./orca-cli.js";

/**
 * Supervision loop for one heartbeat's Orca terminal.
 *
 * Interactive providers (Claude) settle on Orca's hook status: the pane must
 * be seen working on this run's prompt and then report `done`. A pane can
 * already read `done` before any turn runs, so `done` alone proves nothing.
 * Headless providers (Codex) settle on the launcher's exit sentinel. Either
 * mode fails when the terminal disappears without a settlement.
 */

export type SupervisionOutcome =
  | { kind: "completed"; status: OrcaAgentStatus | null; exitCode: number | null }
  | { kind: "exited"; exitCode: number }
  | { kind: "interrupted"; status: OrcaAgentStatus }
  | { kind: "terminal_gone" }
  | { kind: "startup_timeout" }
  | { kind: "timed_out" }
  | { kind: "cancelled" };

export interface SupervisionDeps {
  agentStatus(): Promise<OrcaAgentStatus | null>;
  showTerminal(): Promise<OrcaTerminalState | null>;
  readExitCode(): Promise<number | null>;
  /** Stream provider output (transcript or captured log) into the run log. */
  drainOutput(): Promise<void>;
  /** Called on each poll while an interactive provider has not started its turn. */
  onStartupPending?(): Promise<void>;
  emit(event: OrcaLocalEvent): Promise<void>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
}

export interface SupervisionOptions {
  mode: "interactive" | "headless";
  launchedAt: number;
  prompt: string;
  pollIntervalMs: number;
  startupTimeoutMs: number;
  /** 0 disables the hard limit. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Check terminal liveness every N polls (it is the more expensive call). */
  terminalCheckEvery?: number;
}

const PROMPT_MATCH_CHARS = 120;

function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, PROMPT_MATCH_CHARS);
}

/** Whether Orca's recorded prompt for the pane is the prompt this run submitted. */
export function promptMatches(reported: string | null, sent: string): boolean {
  if (!reported) return false;
  const a = normalizePrompt(reported);
  const b = normalizePrompt(sent);
  if (!a || !b) return false;
  return a.startsWith(b.slice(0, a.length)) || b.startsWith(a.slice(0, b.length));
}

function describeStatus(status: OrcaAgentStatus): string | undefined {
  if (status.state === "waiting" || status.state === "blocked") {
    const tool = status.toolName ? `${status.toolName}${status.toolInput ? `: ${status.toolInput.slice(0, 200)}` : ""}` : null;
    return tool ? `Needs input in Orca (${tool})` : "Needs input in Orca";
  }
  if (status.state === "working" && status.toolName) return `Running ${status.toolName}`;
  return undefined;
}

export async function superviseOrcaRun(
  deps: SupervisionDeps,
  options: SupervisionOptions,
): Promise<SupervisionOutcome> {
  const terminalCheckEvery = Math.max(1, options.terminalCheckEvery ?? 5);
  let started = options.mode === "headless";
  let lastState: string | null = null;
  let lastDetail: string | undefined;
  let tick = 0;

  for (;;) {
    if (options.signal?.aborted) return { kind: "cancelled" };
    const elapsed = deps.now() - options.launchedAt;
    if (options.timeoutMs > 0 && elapsed > options.timeoutMs) return { kind: "timed_out" };

    await deps.drainOutput();

    const exitCode = await deps.readExitCode();
    if (exitCode !== null) {
      // Headless: the provider finished. Interactive: the provider process
      // exited before reporting a completed turn (crash or manual quit).
      return options.mode === "headless"
        ? { kind: "completed", status: null, exitCode }
        : { kind: "exited", exitCode };
    }

    if (options.mode === "interactive") {
      const status = await deps.agentStatus();
      const fresh = status && (status.stateStartedAt ?? 0) >= options.launchedAt;
      if (status && fresh && status.state && status.state !== "done") started = true;
      if (status && !started && promptMatches(status.prompt, options.prompt)) started = true;

      if (status && started && status.state) {
        const detail = describeStatus(status);
        if (status.state !== lastState || detail !== lastDetail) {
          lastState = status.state;
          lastDetail = detail;
          await deps.emit({ type: "orca_local.status", state: status.state, ...(detail ? { detail } : {}) });
        }
        if (status.state === "done" && fresh) {
          await deps.drainOutput();
          return status.interrupted ? { kind: "interrupted", status } : { kind: "completed", status, exitCode: null };
        }
      }
      if (!started) {
        if (elapsed > options.startupTimeoutMs) return { kind: "startup_timeout" };
        await deps.onStartupPending?.();
      }
    }

    if (tick % terminalCheckEvery === 0) {
      const terminal = await deps.showTerminal();
      if (!terminal || !terminal.connected) {
        // The exit sentinel may land just before the PTY disappears.
        const lateExit = await deps.readExitCode();
        if (lateExit !== null && options.mode === "headless") {
          return { kind: "completed", status: null, exitCode: lateExit };
        }
        return lateExit !== null ? { kind: "exited", exitCode: lateExit } : { kind: "terminal_gone" };
      }
    }

    tick += 1;
    await deps.sleep(options.pollIntervalMs, options.signal);
  }
}

export async function readExitCodeFile(filePath: string): Promise<number | null> {
  try {
    const raw = (await fs.readFile(filePath, "utf8")).trim();
    if (!/^-?\d+$/.test(raw)) return null;
    return Number.parseInt(raw, 10);
  } catch {
    return null;
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\r/g;

/** Incremental reader for the headless provider's captured output. */
export class OutputTail {
  private offset = 0;
  private partial = "";

  constructor(private readonly filePath: string) {}

  /** Complete new lines since the previous read, ANSI-stripped. */
  async readLines(flush = false): Promise<string[]> {
    let chunk = "";
    try {
      const handle = await fs.open(this.filePath, "r");
      try {
        const { size } = await handle.stat();
        if (size > this.offset) {
          const buffer = Buffer.alloc(size - this.offset);
          await handle.read(buffer, 0, buffer.length, this.offset);
          this.offset = size;
          chunk = buffer.toString("utf8");
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Not created yet.
    }
    const text = this.partial + chunk;
    const lines = text.split("\n");
    this.partial = flush ? "" : (lines.pop() ?? "");
    return lines.map((line) => line.replace(ANSI_PATTERN, "")).filter((line) => line.trim().length > 0);
  }
}

export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
