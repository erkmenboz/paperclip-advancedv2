import { describe, expect, it } from "vitest";
import { parseOrcaLocalStdoutLine } from "./parse-stdout.js";

const ts = "2026-10-07T08:00:00.000Z";

describe("parseOrcaLocalStdoutLine", () => {
  it("maps init, status, and tool events to transcript entries", () => {
    expect(
      parseOrcaLocalStdoutLine(
        JSON.stringify({
          type: "orca_local.init",
          provider: "claude",
          mode: "interactive",
          sessionId: "s-1",
          resumed: true,
          terminalHandle: "term_1",
          orcaWorktree: "/repo",
          title: "Paperclip · Builder",
        }),
        ts,
      ),
    ).toEqual([
      { kind: "init", ts, model: "claude", sessionId: "s-1" },
      { kind: "system", ts, text: 'Orca interactive claude run in tab "Paperclip · Builder" (/repo), resuming the previous session.' },
    ]);
    expect(parseOrcaLocalStdoutLine(JSON.stringify({ type: "orca_local.status", state: "waiting", detail: "Needs input in Orca" }), ts))
      .toEqual([{ kind: "system", ts, text: "Orca: waiting — Needs input in Orca" }]);
    expect(parseOrcaLocalStdoutLine(JSON.stringify({ type: "orca_local.tool_call", name: "Bash", toolUseId: "t1", input: '{"command":"ls"}' }), ts))
      .toEqual([{ kind: "tool_call", ts, name: "Bash", toolUseId: "t1", input: { command: "ls" } }]);
  });

  it("maps the result with usage and marks failures as errors", () => {
    expect(
      parseOrcaLocalStdoutLine(
        JSON.stringify({ type: "orca_local.result", outcome: "failed", error: "claude exited", inputTokens: 10, outputTokens: 2 }),
        ts,
      ),
    ).toEqual([{
      kind: "result",
      ts,
      text: "claude exited",
      inputTokens: 10,
      outputTokens: 2,
      cachedTokens: 0,
      costUsd: 0,
      subtype: "failed",
      isError: true,
      errors: ["claude exited"],
    }]);
  });

  it("falls back to stdout for non-event lines", () => {
    expect(parseOrcaLocalStdoutLine("[paperclip] note", ts)).toEqual([{ kind: "stdout", ts, text: "[paperclip] note" }]);
    expect(parseOrcaLocalStdoutLine('{"type":"other"}', ts)).toEqual([{ kind: "stdout", ts, text: '{"type":"other"}' }]);
  });
});
