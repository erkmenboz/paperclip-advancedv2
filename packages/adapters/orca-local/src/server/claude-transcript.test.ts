import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeTranscriptReader } from "./claude-transcript.js";

const SESSION_ID = "e43376d9-45af-45a9-820a-2f5f4a29939e";
const LAUNCHED_AT = Date.parse("2026-10-07T08:00:00.000Z");

function line(entry: Record<string, unknown>) {
  return `${JSON.stringify(entry)}\n`;
}

describe("ClaudeTranscriptReader", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function setup() {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-claude-config-"));
    dirs.push(configDir);
    const projectDir = path.join(configDir, "projects", "-Users-me-repo");
    await fs.mkdir(projectDir, { recursive: true });
    const file = path.join(projectDir, `${SESSION_ID}.jsonl`);
    return { configDir, file };
  }

  it("streams this turn's text and tools, skips earlier turns, and counts each message's usage once", async () => {
    const { configDir, file } = await setup();
    const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 7 };
    await fs.writeFile(
      file,
      line({ type: "assistant", uuid: "old", timestamp: "2026-10-07T07:00:00.000Z", message: { id: "m0", content: [{ type: "text", text: "previous turn" }], usage } }) +
        line({ type: "user", uuid: "u1", timestamp: "2026-10-07T08:00:01.000Z", message: { content: "the prompt" } }) +
        line({ type: "assistant", uuid: "a1", timestamp: "2026-10-07T08:00:02.000Z", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "Running tests." }], usage } }) +
        line({ type: "assistant", uuid: "a2", timestamp: "2026-10-07T08:00:02.100Z", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }], usage } }),
    );
    const reader = new ClaudeTranscriptReader({ claudeConfigDir: configDir, sessionId: SESSION_ID, launchedAt: LAUNCHED_AT });
    expect(await reader.poll()).toEqual([
      { type: "orca_local.assistant", text: "Running tests." },
      { type: "orca_local.tool_call", name: "Bash", toolUseId: "t1", input: '{"command":"pnpm test"}' },
    ]);

    // A partial line is held until its newline arrives.
    const result = JSON.stringify({ type: "user", uuid: "u2", timestamp: "2026-10-07T08:00:03.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false }] } });
    await fs.appendFile(file, result.slice(0, 20));
    expect(await reader.poll()).toEqual([]);
    await fs.appendFile(file, `${result.slice(20)}\n`);
    expect(await reader.poll()).toEqual([{ type: "orca_local.tool_result", toolUseId: "t1", content: "ok", isError: false }]);

    expect(reader.usage()).toEqual({ inputTokens: 102, outputTokens: 7, cachedInputTokens: 50 });
    expect(reader.model()).toBe("claude-opus-5-5");
  });

  it("yields nothing until the session transcript exists", async () => {
    const { configDir, file } = await setup();
    const reader = new ClaudeTranscriptReader({ claudeConfigDir: configDir, sessionId: SESSION_ID, launchedAt: LAUNCHED_AT });
    expect(await reader.poll()).toEqual([]);
    expect(reader.usage()).toBeNull();
    await fs.writeFile(file, line({ type: "assistant", uuid: "a1", timestamp: "2026-10-07T08:00:02.000Z", message: { id: "m1", content: [{ type: "text", text: "hi" }] } }));
    expect(await reader.poll()).toEqual([{ type: "orca_local.assistant", text: "hi" }]);
  });
});
