import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseOrcaLocalEvent } from "../events.js";

function parseToolInput(input: string | undefined): unknown {
  if (!input) return {};
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

export function parseOrcaLocalStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const event = parseOrcaLocalEvent(line);
  if (!event) {
    const text = line.trimEnd();
    return text ? [{ kind: "stdout", ts, text }] : [];
  }

  switch (event.type) {
    case "orca_local.init":
      return [
        { kind: "init", ts, model: event.model ?? event.provider, sessionId: event.sessionId ?? event.terminalHandle },
        {
          kind: "system",
          ts,
          text: `Orca ${event.mode === "interactive" ? "interactive" : "headless"} ${event.provider} run in tab "${event.title}" (${event.orcaWorktree})${event.resumed ? ", resuming the previous session" : ""}.`,
        },
      ];
    case "orca_local.status":
      return [{ kind: "system", ts, text: `Orca: ${event.state}${event.detail ? ` — ${event.detail}` : ""}` }];
    case "orca_local.assistant":
      return [{ kind: "assistant", ts, text: event.text }];
    case "orca_local.tool_call":
      return [{
        kind: "tool_call",
        ts,
        name: event.name,
        input: parseToolInput(event.input),
        ...(event.toolUseId ? { toolUseId: event.toolUseId } : {}),
      }];
    case "orca_local.tool_result":
      return [{ kind: "tool_result", ts, toolUseId: event.toolUseId ?? "", content: event.content, isError: event.isError }];
    case "orca_local.output":
      return [{ kind: "stdout", ts, text: event.text }];
    case "orca_local.result":
      return [{
        kind: "result",
        ts,
        text: event.summary ?? event.error ?? "",
        inputTokens: event.inputTokens ?? 0,
        outputTokens: event.outputTokens ?? 0,
        cachedTokens: event.cachedInputTokens ?? 0,
        costUsd: 0,
        subtype: event.outcome,
        isError: event.outcome !== "succeeded",
        errors: event.error ? [event.error] : [],
      }];
    default:
      return [{ kind: "stdout", ts, text: line }];
  }
}
