import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { afterEach, describe, expect, it } from "vitest";
import { parseOrcaLocalEvent, type OrcaLocalEvent } from "../events.js";
import { execute } from "./execute.js";
import type { OrcaAgentStatus, OrcaCli, OrcaTerminal, OrcaTerminalState, OrcaWorktree } from "./orca-cli.js";

/**
 * Stand-in for the Orca runtime: `createTerminal` really runs the launcher in
 * a shell, the way an Orca tab would, so these tests cover the launcher, env
 * file, prompt passing, and supervision end to end.
 */
class FakeOrca {
  readonly created: Array<{ worktree: string; title: string; command: string }> = [];
  readonly closed: string[] = [];
  readonly interrupted: string[] = [];
  readonly inputs: string[] = [];
  statuses: Array<OrcaAgentStatus | null> = [];
  /** Screens returned by readScreen, in order; the last one repeats. */
  screens: string[][] = [["screen"]];
  private child: ChildProcess | null = null;
  private exited = false;

  constructor(private readonly worktree: OrcaWorktree | null) {}

  async findWorktree(): Promise<OrcaWorktree | null> {
    return this.worktree;
  }

  async createTerminal(input: { worktree: string; title: string; command: string }): Promise<OrcaTerminal> {
    this.created.push(input);
    // Own process group, like a PTY's foreground job, so Ctrl-C reaches every process in it.
    this.child = spawn("/bin/sh", ["-c", input.command], { stdio: "ignore", detached: true, env: { PATH: process.env.PATH ?? "" } });
    this.child.on("exit", () => {
      this.exited = true;
    });
    return { handle: "term_fake", paneKey: "tab:leaf", tabId: "tab", worktreeId: this.worktree?.id ?? null, title: input.title };
  }

  async agentStatus(): Promise<OrcaAgentStatus | null> {
    return this.statuses.length > 1 ? this.statuses.shift()! : (this.statuses[0] ?? null);
  }

  async showTerminal(handle: string): Promise<OrcaTerminalState | null> {
    return { handle, connected: true, agentIdentity: null, agentWait: null };
  }

  async interrupt(handle: string) {
    this.interrupted.push(handle);
    if (this.child?.pid && !this.exited) process.kill(-this.child.pid, "SIGINT");
  }

  async closeTerminal(handle: string) {
    this.closed.push(handle);
  }

  async readScreen() {
    return this.screens.length > 1 ? this.screens.shift()! : this.screens[0];
  }

  async sendInput(_handle: string, text: string) {
    this.inputs.push(text);
  }

  async waitForExit() {
    for (let i = 0; i < 100 && !this.exited; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  asCli(): OrcaCli {
    return this as unknown as OrcaCli;
  }
}

function makeCtx(input: {
  config: Record<string, unknown>;
  cwd: string;
  sessionParams?: Record<string, unknown> | null;
  signal?: AbortSignal;
  logs: string[];
}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Builder", adapterType: "orca_local", adapterConfig: input.config },
    runtime: { sessionId: null, sessionParams: input.sessionParams ?? null, sessionDisplayId: null, taskKey: null },
    config: input.config,
    context: { taskId: "issue-7", wakeReason: "issue_assigned", paperclipWorkspace: { cwd: input.cwd, source: "project_primary" } },
    onLog: async (_stream, chunk) => {
      input.logs.push(chunk);
    },
    onMeta: async () => undefined,
    authToken: "run-jwt-token",
    signal: input.signal,
  } as AdapterExecutionContext;
}

function eventsFrom(logs: string[]): OrcaLocalEvent[] {
  return logs.flatMap((chunk) => chunk.split("\n")).map(parseOrcaLocalEvent).filter((event): event is OrcaLocalEvent => event !== null);
}

describe("orca_local execute", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function sandbox() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "orca-execute-test-"));
    dirs.push(root);
    const workspace = path.join(root, "workspace");
    const runParent = path.join(root, "runs");
    const claudeConfigDir = path.join(root, "claude");
    await Promise.all([fs.mkdir(workspace), fs.mkdir(runParent), fs.mkdir(path.join(claudeConfigDir, "projects", "p"), { recursive: true })]);
    return { root, workspace, runParent, claudeConfigDir };
  }

  const worktree: OrcaWorktree = { id: "repo::/repo", path: "/repo", displayName: "main" };

  it("runs Codex headless: env reaches the provider, output streams, and the session id persists", async () => {
    const { root, workspace, runParent } = await sandbox();
    const fakeCodex = path.join(root, "codex");
    await fs.writeFile(
      fakeCodex,
      [
        "#!/bin/sh",
        'echo "model: gpt-test"',
        'echo "session id: 0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"',
        'echo "token=$PAPERCLIP_API_KEY task=$PAPERCLIP_TASK_ID cwd=$(pwd)"',
        // -o <file> is the last option pair the adapter passes.
        'for arg; do if [ "$prev" = "-o" ]; then printf "Fixed the bug." > "$arg"; fi; prev="$arg"; done',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const orca = new FakeOrca(worktree);
    const logs: string[] = [];
    const result = await execute(
      makeCtx({ config: { provider: "codex", providerCommand: fakeCodex, orcaWorkspace: "path:/repo", pollIntervalSec: 0.5 }, cwd: workspace, logs }),
      { cli: orca.asCli(), runDirParent: runParent },
    );

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      summary: "Fixed the bug.",
      provider: "openai",
      model: "gpt-test",
      sessionParams: { provider: "codex", sessionId: "0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", cwd: workspace },
    });
    expect(orca.created[0]).toMatchObject({ worktree: "id:repo::/repo", title: "Paperclip · Builder" });
    expect(orca.created[0].command).not.toContain("run-jwt-token");
    const output = eventsFrom(logs).filter((event) => event.type === "orca_local.output").map((event) => (event as { text: string }).text).join("\n");
    expect(output).toContain("token=run-jwt-token task=issue-7");
    expect(output).toContain(`cwd=${workspace}`);
    expect(eventsFrom(logs).at(-1)).toMatchObject({ type: "orca_local.result", outcome: "succeeded", summary: "Fixed the bug." });
    // Default retention keeps the tab; the private run directory is always removed.
    expect(orca.closed).toEqual([]);
    expect(await fs.readdir(runParent)).toEqual([]);
  });

  it("runs Claude interactively: pins the session, reads the transcript, and settles on hook status", async () => {
    const { root, workspace, runParent, claudeConfigDir } = await sandbox();
    const fakeClaude = path.join(root, "claude-bin");
    // Writes a transcript for the session id it was given, like Claude Code does.
    await fs.writeFile(
      fakeClaude,
      [
        "#!/bin/sh",
        'sid="$3"',
        'ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)',
        `printf '{"type":"assistant","uuid":"a1","timestamp":"%s","message":{"id":"m1","model":"claude-opus-5-5","content":[{"type":"text","text":"Patched."}],"usage":{"input_tokens":3,"cache_creation_input_tokens":10,"cache_read_input_tokens":20,"output_tokens":5}}}\\n' "$ts" > "${claudeConfigDir}/projects/p/$sid.jsonl"`,
        "sleep 3",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const orca = new FakeOrca(worktree);
    const base = { paneKey: "tab:leaf", agentType: "claude", prompt: null, toolName: null, toolInput: null, interrupted: false, updatedAt: null };
    const now = Date.now();
    orca.statuses = [
      null,
      { ...base, state: "working", stateStartedAt: now + 60_000, lastAssistantMessage: null },
      { ...base, state: "done", stateStartedAt: now + 61_000, lastAssistantMessage: "Patched." },
    ];
    const logs: string[] = [];
    const result = await execute(
      makeCtx({
        config: { provider: "claude", providerCommand: fakeClaude, orcaWorkspace: "path:/repo", pollIntervalSec: 0.5, terminalRetention: "close" },
        cwd: workspace,
        logs,
      }),
      { cli: orca.asCli(), runDirParent: runParent, claudeConfigDir },
    );

    const init = eventsFrom(logs).find((event) => event.type === "orca_local.init");
    expect(init).toMatchObject({ provider: "claude", mode: "interactive", resumed: false });
    const sessionId = (init as { sessionId: string }).sessionId;
    expect(result).toMatchObject({
      exitCode: 0,
      summary: "Patched.",
      model: "claude-opus-5-5",
      usage: { inputTokens: 13, outputTokens: 5, cachedInputTokens: 20 },
      usageBasis: "per_run",
      sessionParams: { provider: "claude", sessionId, cwd: workspace },
    });
    expect(eventsFrom(logs)).toContainEqual({ type: "orca_local.assistant", text: "Patched." });
    expect(orca.closed).toEqual(["term_fake"]);
    await orca.interrupt("term_fake");
  });

  it("accepts Claude's trust prompt for the run's workspace only after the cursor is on the trust option", async () => {
    const { root, workspace, runParent, claudeConfigDir } = await sandbox();
    const idleClaude = path.join(root, "claude-idle");
    await fs.writeFile(idleClaude, "#!/bin/sh\nsleep 3\n", { mode: 0o755 });
    const trustScreen = (selected: "no" | "yes") => [
      " Accessing workspace:",
      ` ${workspace}`,
      " Quick safety check: Is this a project you created or one you trust?",
      selected === "no" ? " ❯ No, exit" : "   No, exit",
      selected === "yes" ? " ❯ Yes, I trust this folder" : "   Yes, I trust this folder",
    ];
    const orca = new FakeOrca(worktree);
    orca.screens = [trustScreen("no"), trustScreen("yes"), ["Claude Code"]];
    const base = { paneKey: "tab:leaf", agentType: "claude", prompt: null, toolName: null, toolInput: null, interrupted: false, updatedAt: null };
    const now = Date.now();
    orca.statuses = [
      null,
      null,
      { ...base, state: "working", stateStartedAt: now + 60_000, lastAssistantMessage: null },
      { ...base, state: "done", stateStartedAt: now + 61_000, lastAssistantMessage: "Trusted and done." },
    ];
    const logs: string[] = [];
    const result = await execute(
      makeCtx({ config: { provider: "claude", providerCommand: idleClaude, orcaWorkspace: "path:/repo", pollIntervalSec: 0.5 }, cwd: workspace, logs }),
      { cli: orca.asCli(), runDirParent: runParent, claudeConfigDir },
    );
    expect(orca.inputs).toEqual(["\u001b[B", "\r"]);
    expect(result).toMatchObject({ exitCode: 0, summary: "Trusted and done." });
    expect(eventsFrom(logs)).toContainEqual({
      type: "orca_local.status",
      state: "starting",
      detail: `Accepted Claude's workspace trust prompt for ${workspace}`,
    });
    await orca.interrupt("term_fake");
  });

  it("leaves the trust prompt alone when trustWorkspace is off and says why the run stalled", async () => {
    const { root, workspace, runParent, claudeConfigDir } = await sandbox();
    const idleClaude = path.join(root, "claude-idle");
    await fs.writeFile(idleClaude, "#!/bin/sh\nsleep 3\n", { mode: 0o755 });
    const orca = new FakeOrca(worktree);
    orca.screens = [[" Accessing workspace:", ` ${workspace}`, " ❯ No, exit", "   Yes, I trust this folder"]];
    let clock = Date.now();
    const result = await execute(
      makeCtx({
        config: { provider: "claude", providerCommand: idleClaude, orcaWorkspace: "path:/repo", trustWorkspace: false, startupTimeoutSec: 10 },
        cwd: workspace,
        logs: [],
      }),
      { cli: orca.asCli(), runDirParent: runParent, claudeConfigDir, now: () => clock, sleep: async (ms) => { clock += ms; } },
    );
    expect(orca.inputs).toEqual([]);
    expect(result).toMatchObject({ errorCode: "orca_startup_timeout" });
    expect(result.errorMessage).toContain(`trust ${workspace}`);
    await orca.interrupt("term_fake");
  });

  it("resumes the previous Claude session when provider and cwd match", async () => {
    const { root, workspace, runParent, claudeConfigDir } = await sandbox();
    const idleClaude = path.join(root, "claude-idle");
    await fs.writeFile(idleClaude, "#!/bin/sh\nsleep 3\n", { mode: 0o755 });
    const orca = new FakeOrca(worktree);
    orca.statuses = [{ paneKey: "tab:leaf", agentType: "claude", prompt: null, toolName: null, toolInput: null, interrupted: false, updatedAt: null, state: "working", stateStartedAt: Date.now() + 60_000, lastAssistantMessage: null }];
    const controller = new AbortController();
    const logs: string[] = [];
    const run = execute(
      makeCtx({
        config: { provider: "claude", providerCommand: idleClaude, orcaWorkspace: "path:/repo", pollIntervalSec: 0.5 },
        cwd: workspace,
        sessionParams: { provider: "claude", sessionId: "11111111-1111-4111-8111-111111111111", cwd: workspace },
        signal: controller.signal,
        logs,
      }),
      { cli: orca.asCli(), runDirParent: runParent, claudeConfigDir },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();
    const result = await run;
    expect(eventsFrom(logs).find((event) => event.type === "orca_local.init")).toMatchObject({
      resumed: true,
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result).toMatchObject({
      errorCode: "cancelled",
      resultJson: { executionCancellation: { state: "acknowledged" } },
    });
    expect(orca.interrupted).toEqual(["term_fake"]);
  });

  it("fails with guidance when the workspace is not an Orca worktree", async () => {
    const { workspace, runParent } = await sandbox();
    const orca = new FakeOrca(null);
    const logs: string[] = [];
    const result = await execute(
      makeCtx({ config: { provider: "claude", orcaWorkspace: "path:/unknown" }, cwd: workspace, logs }),
      { cli: orca.asCli(), runDirParent: runParent },
    );
    expect(result).toMatchObject({ exitCode: 1, errorCode: "orca_workspace_not_found" });
    expect(result.errorMessage).toContain("orca repo add");
    expect(orca.created).toEqual([]);
  });

  it("runs Cursor on a pinned chat and applies effort as the matching model variant", async () => {
    const { root, workspace, runParent } = await sandbox();
    const idleCursor = path.join(root, "cursor-idle");
    await fs.writeFile(idleCursor, "#!/bin/sh\nsleep 3\n", { mode: 0o755 });
    const orca = new FakeOrca(worktree);
    const base = { paneKey: "tab:leaf", agentType: "cursor", prompt: null, toolName: null, toolInput: null, interrupted: false, updatedAt: null };
    const now = Date.now();
    orca.statuses = [
      { ...base, state: "working", stateStartedAt: now + 60_000, lastAssistantMessage: null },
      { ...base, state: "done", stateStartedAt: now + 61_000, lastAssistantMessage: "Shipped." },
    ];
    const logs: string[] = [];
    let metaArgs: string[] = [];
    const ctx = makeCtx({
      config: { provider: "cursor", providerCommand: idleCursor, model: "grok-4.7-low", effort: "xhigh", orcaWorkspace: "path:/repo", pollIntervalSec: 0.5 },
      cwd: workspace,
      logs,
    });
    ctx.onMeta = async (meta) => {
      metaArgs = meta.commandArgs ?? [];
    };
    const result = await execute(ctx, {
      cli: orca.asCli(),
      runDirParent: runParent,
      createCursorChat: async () => "chat-0f1e2d3c",
      listCursorModels: async () => [{ id: "grok-4.7-low", label: "Grok 4.7 Low" }, { id: "grok-4.7-xhigh", label: "Grok 4.7 Extra High" }],
    });
    expect(metaArgs).toEqual(["<prompt>", "--resume", "chat-0f1e2d3c", "--model", "grok-4.7-xhigh", "--trust"]);
    expect(result).toMatchObject({
      exitCode: 0,
      summary: "Shipped.",
      provider: "cursor",
      model: "grok-4.7-xhigh",
      sessionParams: { provider: "cursor", sessionId: "chat-0f1e2d3c", cwd: workspace },
    });
    await orca.interrupt("term_fake");
  });

  it("rejects unsupported providers before touching Orca", async () => {
    const { workspace } = await sandbox();
    const orca = new FakeOrca(worktree);
    const result = await execute(makeCtx({ config: { provider: "gemini-cli" }, cwd: workspace, logs: [] }), { cli: orca.asCli() });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "orca_provider_invalid" });
    expect(orca.created).toEqual([]);
  });
});
