/**
 * JSONL events the orca_local adapter writes to the run's stdout.
 * Shared by the server (emitter), the UI transcript parser, and the CLI
 * formatter, so it must stay dependency-free.
 */

export type OrcaLocalOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";

export type OrcaLocalEvent =
  | {
      type: "orca_local.init";
      provider: string;
      mode: "interactive" | "headless";
      model?: string;
      sessionId?: string;
      resumed?: boolean;
      terminalHandle: string;
      paneKey?: string;
      orcaWorktree: string;
      title: string;
    }
  | { type: "orca_local.status"; state: string; detail?: string }
  | { type: "orca_local.assistant"; text: string }
  | { type: "orca_local.tool_call"; name: string; toolUseId?: string; input?: string }
  | { type: "orca_local.tool_result"; toolUseId?: string; content: string; isError: boolean }
  | { type: "orca_local.output"; text: string }
  | {
      type: "orca_local.result";
      outcome: OrcaLocalOutcome;
      summary?: string;
      error?: string;
      exitCode?: number | null;
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
    };

export const ORCA_LOCAL_EVENT_PREFIX = "orca_local.";

export function parseOrcaLocalEvent(line: string): OrcaLocalEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" && type.startsWith(ORCA_LOCAL_EVENT_PREFIX)
      ? (value as OrcaLocalEvent)
      : null;
  } catch {
    return null;
  }
}
