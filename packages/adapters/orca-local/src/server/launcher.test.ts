import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROMPT_ARG,
  RUN_DIR_FILES,
  buildProviderArgs,
  createRunDir,
  renderEnvFile,
  shellQuote,
  writeRunFiles,
  type ProviderLaunchInput,
} from "./launcher.js";

const base: ProviderLaunchInput = {
  provider: "claude",
  command: "claude",
  runDir: "/tmp/run",
  model: null,
  effort: null,
  resumeSessionId: null,
  pinnedSessionId: null,
  dangerouslySkipPermissions: false,
  trustWorkspace: true,
  codexSandbox: "workspace-write",
  networkAccess: true,
  claudeAddDir: null,
  extraArgs: [],
};

describe("buildProviderArgs", () => {
  it("puts the Claude prompt before variadic options and pins a fresh session", () => {
    const args = buildProviderArgs({
      ...base,
      pinnedSessionId: "11111111-1111-4111-8111-111111111111",
      model: "opus",
      claudeAddDir: "/tmp/run/skills",
      extraArgs: ["--allowedTools", "Bash(git:*)"],
    });
    expect(args).toEqual([
      PROMPT_ARG,
      "--session-id", "11111111-1111-4111-8111-111111111111",
      "--model", "opus",
      "--add-dir", "/tmp/run/skills",
      "--allowedTools", "Bash(git:*)",
    ]);
  });

  it("resumes a Claude session instead of pinning a new one", () => {
    const args = buildProviderArgs({ ...base, resumeSessionId: "abc", pinnedSessionId: "abc", dangerouslySkipPermissions: true });
    expect(args).toEqual([PROMPT_ARG, "--resume", "abc", "--dangerously-skip-permissions"]);
  });

  it("runs Codex headless with the sandbox passed as config so resume accepts it", () => {
    expect(buildProviderArgs({ ...base, provider: "codex", command: "codex", model: "gpt-5" })).toEqual([
      "exec", PROMPT_ARG,
      "-m", "gpt-5",
      "-c", 'sandbox_mode="workspace-write"',
      "-c", "sandbox_workspace_write.network_access=true",
      "--skip-git-repo-check",
      "-o", path.join("/tmp/run", RUN_DIR_FILES.lastMessage),
    ]);
    expect(buildProviderArgs({ ...base, provider: "codex", resumeSessionId: "thread-1", dangerouslySkipPermissions: true }))
      .toEqual([
        "exec", "resume", "thread-1", PROMPT_ARG,
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-o", path.join("/tmp/run", RUN_DIR_FILES.lastMessage),
      ]);
  });
});

describe("buildProviderArgs effort and new providers", () => {
  it("passes effort the way each CLI expects", () => {
    expect(buildProviderArgs({ ...base, effort: "xhigh" })).toEqual([PROMPT_ARG, "--effort", "xhigh"]);
    expect(buildProviderArgs({ ...base, provider: "codex", effort: "minimal" })).toContain('model_reasoning_effort="minimal"');
  });

  it("pins a Cursor chat, trusts the workspace, and maps skip-permissions to --force", () => {
    expect(buildProviderArgs({
      ...base,
      provider: "cursor",
      command: "cursor-agent",
      pinnedSessionId: "chat-1234abcd",
      model: "grok-4.7-high",
      dangerouslySkipPermissions: true,
    })).toEqual([PROMPT_ARG, "--resume", "chat-1234abcd", "--model", "grok-4.7-high", "--trust", "--force"]);
  });

  it("runs Muse with effort, workspace trust, and network for the Paperclip API", () => {
    expect(buildProviderArgs({ ...base, provider: "muse", command: "muse", model: "muse-spark-1.3", effort: "ultra" })).toEqual([
      PROMPT_ARG,
      "--model", "muse-spark-1.3",
      "--reasoning-effort", "ultra",
      "--trust-workspace",
      "--sandbox-network", "enabled",
    ]);
    expect(buildProviderArgs({ ...base, provider: "muse", command: "muse", dangerouslySkipPermissions: true })).toEqual([PROMPT_ARG, "--yolo"]);
  });
});

describe("renderEnvFile", () => {
  it("single-quotes values and drops keys a shell cannot assign", () => {
    expect(renderEnvFile({ A: "it's $HOME `x`", "BAD-KEY": "x", B: "" })).toBe(
      "A='it'\\''s $HOME `x`'\nB=''\n",
    );
  });
});

describe("launch script", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function runLauncher(input: { exitCode: number; captureOutput: boolean }) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "orca-launcher-test-"));
    dirs.push(parent);
    const workspace = path.join(parent, "workspace");
    await fs.mkdir(workspace);
    const fakeProvider = path.join(parent, "fake-provider.sh");
    await fs.writeFile(
      fakeProvider,
      [
        "#!/bin/sh",
        'printf "cwd=%s\\n" "$(pwd)"',
        'printf "token=%s\\n" "$PAPERCLIP_API_KEY"',
        'printf "arg1=%s|\\n" "$1"',
        `exit ${input.exitCode}`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const runDir = await createRunDir(parent);
    const prompt = "Fix it's \"quoted\" $PATH `cmd`\nsecond line";
    const terminalCommand = await writeRunFiles({
      runId: "run-1",
      runDir,
      cwd: workspace,
      env: { PAPERCLIP_API_KEY: "secret-token" },
      prompt,
      command: fakeProvider,
      args: [PROMPT_ARG],
      captureOutput: input.captureOutput,
    });
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("/bin/sh", ["-c", terminalCommand], { env: { PATH: process.env.PATH ?? "" } }, (error, out) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve(String(out));
      });
    });
    return { runDir, workspace, prompt, stdout, terminalCommand };
  }

  it("sources and deletes the env file, runs in the workspace, passes the prompt intact, and records the exit code", async () => {
    const { runDir, workspace, prompt, stdout, terminalCommand } = await runLauncher({ exitCode: 3, captureOutput: false });
    expect(terminalCommand).not.toContain("secret-token");
    expect(stdout).toContain(`cwd=${workspace}`);
    expect(stdout).toContain("token=secret-token");
    expect(stdout).toContain(`arg1=${prompt}|`);
    await expect(fs.access(path.join(runDir, RUN_DIR_FILES.env))).rejects.toThrow();
    expect((await fs.readFile(path.join(runDir, RUN_DIR_FILES.exitCode), "utf8")).trim()).toBe("3");
    expect((await fs.stat(runDir)).mode & 0o777).toBe(0o700);
  });

  it("captures headless output while keeping the provider exit code", async () => {
    const { runDir } = await runLauncher({ exitCode: 0, captureOutput: true });
    const output = await fs.readFile(path.join(runDir, RUN_DIR_FILES.output), "utf8");
    expect(output).toContain("token=secret-token");
    expect((await fs.readFile(path.join(runDir, RUN_DIR_FILES.exitCode), "utf8")).trim()).toBe("0");
  });

  it("records 130 when Ctrl-C reaches the job, instead of dying silently", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "orca-launcher-test-"));
    dirs.push(parent);
    const runDir = await createRunDir(parent);
    const terminalCommand = await writeRunFiles({
      runId: "run-1",
      runDir,
      cwd: parent,
      env: {},
      prompt: "p",
      command: "sleep",
      args: ["5"],
      captureOutput: true,
    });
    const startedAt = Date.now();
    const child = spawn("/bin/sh", ["-c", terminalCommand], { stdio: "ignore", detached: true });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    await new Promise((resolve) => setTimeout(resolve, 300));
    process.kill(-child.pid!, "SIGINT");
    await exited;
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect((await fs.readFile(path.join(runDir, RUN_DIR_FILES.exitCode), "utf8")).trim()).toBe("130");
  });

  it("quotes paths with spaces and quotes", () => {
    expect(shellQuote("/a b/it's")).toBe("'/a b/it'\\''s'");
  });
});
