import { describe, expect, it } from "vitest";
import { OrcaCli, OrcaCliError, buildNeutralOrcaEnv, type OrcaExec } from "./orca-cli.js";

function fakeExec(responses: Record<string, unknown>): { exec: OrcaExec; calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const exec: OrcaExec = async (_command, args, options) => {
    calls.push({ args, env: options.env });
    const key = args.slice(0, 2).join(" ");
    const response = responses[key];
    if (response === undefined) throw new Error(`unexpected orca call: ${args.join(" ")}`);
    return { stdout: JSON.stringify(response), stderr: "", exitCode: 0 };
  };
  return { exec, calls };
}

describe("buildNeutralOrcaEnv", () => {
  it("drops Orca caller identity, routing, and tmux pane variables", () => {
    const env = buildNeutralOrcaEnv({
      PATH: "/bin",
      HOME: "/home/u",
      ORCA_TERMINAL_HANDLE: "term_x",
      ORCA_PANE_KEY: "secret",
      ORCA_ENVIRONMENT: "remote-box",
      ORCA_AGENT_SESSION_ID: "s",
      JCODE_RUNTIME_DIR: "/tmp/j",
      TMUX_PANE: "%1",
      TERM_PROGRAM: "Orca",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/u" });
  });
});

describe("OrcaCli", () => {
  it("passes --json, runs neutral, and returns the result envelope", async () => {
    const { exec, calls } = fakeExec({
      "worktree show": { ok: true, result: { worktree: { id: "repo::/r", path: "/r", displayName: "main" } } },
    });
    const cli = new OrcaCli({ exec, env: { PATH: "/bin", ORCA_TERMINAL_HANDLE: "term_parent" } });
    await expect(cli.findWorktree("path:/r")).resolves.toEqual({ id: "repo::/r", path: "/r", displayName: "main" });
    expect(calls[0].args).toEqual(["worktree", "show", "--worktree", "path:/r", "--json"]);
    expect(calls[0].env.ORCA_TERMINAL_HANDLE).toBeUndefined();
  });

  it("maps selector_not_found to null and other errors to OrcaCliError", async () => {
    const missing = new OrcaCli({
      exec: fakeExec({ "worktree show": { ok: false, error: { code: "selector_not_found", message: "selector_not_found" } } }).exec,
    });
    await expect(missing.findWorktree("path:/nope")).resolves.toBeNull();

    const broken = new OrcaCli({
      exec: fakeExec({ "terminal create": { ok: false, error: { code: "runtime_unavailable", message: "Orca is not running" } } }).exec,
    });
    await expect(broken.createTerminal({ worktree: "id:x", title: "t", command: "sh x" })).rejects.toMatchObject({
      name: "OrcaCliError",
      code: "runtime_unavailable",
      message: "Orca is not running",
    });
  });

  it("reports a missing CLI and non-JSON output clearly", async () => {
    const notFound = new OrcaCli({
      exec: async () => {
        throw Object.assign(new Error("spawn orca ENOENT"), { code: "ENOENT" });
      },
    });
    await expect(notFound.status()).rejects.toMatchObject({ code: "orca_not_found" });

    const garbage = new OrcaCli({ exec: async () => ({ stdout: "not json", stderr: "boom", exitCode: 2 }) });
    await expect(garbage.status()).rejects.toBeInstanceOf(OrcaCliError);
  });

  it("finds the hook status row for one pane across worktrees", async () => {
    const { exec } = fakeExec({
      "worktree ps": {
        ok: true,
        result: {
          worktrees: [
            { agents: [{ paneKey: "other:leaf", state: "working" }] },
            {
              agents: [{
                paneKey: "tab:leaf",
                state: "waiting",
                stateStartedAt: 5,
                agentType: "claude",
                prompt: "Do it",
                toolName: "Bash",
                toolInput: "ls",
                lastAssistantMessage: "",
                interrupted: false,
              }],
            },
          ],
        },
      },
    });
    const cli = new OrcaCli({ exec });
    await expect(cli.agentStatus("tab:leaf")).resolves.toMatchObject({
      paneKey: "tab:leaf",
      state: "waiting",
      toolName: "Bash",
      lastAssistantMessage: null,
    });
    await expect(cli.agentStatus("missing:pane")).resolves.toBeNull();
  });

  it("reads terminal liveness and treats a gone handle as null", async () => {
    const live = new OrcaCli({
      exec: fakeExec({
        "terminal show": { ok: true, result: { terminal: { connected: true, agentIdentity: "claude", agentWait: { source: "hook" } } } },
      }).exec,
    });
    await expect(live.showTerminal("term_1")).resolves.toEqual({
      handle: "term_1",
      connected: true,
      agentIdentity: "claude",
      agentWait: { source: "hook" },
    });
    const gone = new OrcaCli({
      exec: fakeExec({ "terminal show": { ok: false, error: { code: "terminal_gone", message: "gone" } } }).exec,
    });
    await expect(gone.showTerminal("term_1")).resolves.toBeNull();
  });
});
