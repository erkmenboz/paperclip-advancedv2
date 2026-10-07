import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OrcaProviderId } from "../index.js";

/**
 * The launcher is the only thing typed into the Orca terminal: `sh '<runDir>/launch.sh'`.
 *
 * It sources the run's private env file (the Paperclip run token lives there),
 * deletes it, moves into the Paperclip workspace, and starts the provider. The
 * token therefore never reaches the prompt, the terminal scrollback, or shell
 * history, while the provider and its tool subprocesses still inherit it.
 */

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const RUN_DIR_FILES = {
  env: "env",
  prompt: "prompt.md",
  launcher: "launch.sh",
  exitCode: "exit-code",
  output: "output.log",
  lastMessage: "last-message.md",
} as const;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([key]) => ENV_KEY_PATTERN.test(key))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join("\n")
    .concat("\n");
}

export interface ProviderLaunchInput {
  provider: OrcaProviderId;
  command: string;
  runDir: string;
  /** Model id; for Cursor this is already the effort variant when one applies. */
  model: string | null;
  /** Thinking effort validated for the provider (unused for Cursor, whose model carries it). */
  effort: string | null;
  /** Provider session to resume; null starts fresh. */
  resumeSessionId: string | null;
  /** Session id to pin a fresh session to (Claude session id, Cursor chat id). */
  pinnedSessionId: string | null;
  dangerouslySkipPermissions: boolean;
  /** Pre-trust the workspace when the provider has a flag for it (Cursor, Muse). */
  trustWorkspace: boolean;
  codexSandbox: string;
  networkAccess: boolean;
  /** Extra directory exposed to Claude (Paperclip skills). */
  claudeAddDir: string | null;
  extraArgs: string[];
}

/** Placeholder the launcher replaces with the prompt file contents. */
export const PROMPT_ARG = "\u0000PROMPT\u0000";

/**
 * Provider argv with the prompt first. Claude's `--allowedTools` and
 * `--add-dir` are variadic and swallow a trailing positional prompt, so the
 * prompt must precede every option.
 */
export function buildProviderArgs(input: ProviderLaunchInput): string[] {
  switch (input.provider) {
    case "claude": {
      const args = [PROMPT_ARG];
      if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
      else if (input.pinnedSessionId) args.push("--session-id", input.pinnedSessionId);
      if (input.model) args.push("--model", input.model);
      if (input.effort) args.push("--effort", input.effort);
      if (input.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
      if (input.claudeAddDir) args.push("--add-dir", input.claudeAddDir);
      return [...args, ...input.extraArgs];
    }
    case "cursor": {
      const args = [PROMPT_ARG];
      // A chat created up front (create-chat) is resumed even on its first run, which pins it.
      const chatId = input.resumeSessionId ?? input.pinnedSessionId;
      if (chatId) args.push("--resume", chatId);
      if (input.model) args.push("--model", input.model);
      if (input.trustWorkspace) args.push("--trust");
      if (input.dangerouslySkipPermissions) args.push("--force");
      return [...args, ...input.extraArgs];
    }
    case "muse": {
      const args = [PROMPT_ARG];
      if (input.model) args.push("--model", input.model);
      if (input.effort) args.push("--reasoning-effort", input.effort);
      if (input.dangerouslySkipPermissions) {
        args.push("--yolo");
      } else {
        if (input.trustWorkspace) args.push("--trust-workspace");
        if (input.networkAccess) args.push("--sandbox-network", "enabled");
      }
      return [...args, ...input.extraArgs];
    }
    case "codex": {
      const args = input.resumeSessionId
        ? ["exec", "resume", input.resumeSessionId, PROMPT_ARG]
        : ["exec", PROMPT_ARG];
      if (input.model) args.push("-m", input.model);
      if (input.effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(input.effort)}`);
      if (input.dangerouslySkipPermissions) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      } else {
        args.push("-c", `sandbox_mode=${JSON.stringify(input.codexSandbox)}`);
        if (input.codexSandbox === "workspace-write") {
          args.push("-c", `sandbox_workspace_write.network_access=${input.networkAccess}`);
        }
      }
      args.push("--skip-git-repo-check", "-o", path.join(input.runDir, RUN_DIR_FILES.lastMessage));
      return [...args, ...input.extraArgs];
    }
  }
}

export function renderLaunchScript(input: {
  runId: string;
  runDir: string;
  cwd: string;
  command: string;
  args: string[];
  /** Headless providers tee their output so the adapter can stream it into the run log. */
  captureOutput: boolean;
}): string {
  const runDir = shellQuote(input.runDir);
  const providerLine = [shellQuote(input.command), ...input.args.map((arg) =>
    arg === PROMPT_ARG ? `"$(cat "$run_dir/${RUN_DIR_FILES.prompt}")"` : shellQuote(arg),
  )].join(" ");
  // The exit sentinel write may fail after the adapter removed the run dir
  // (a kept terminal whose provider exits later); that is expected and silent.
  const writeExit = `printf '%s\\n' "$code" > "$run_dir/${RUN_DIR_FILES.exitCode}" 2>/dev/null`;
  const run = input.captureOutput
    ? [
        `{ ${providerLine}; code=$?; ${writeExit}; } 2>&1 | tee "$run_dir/${RUN_DIR_FILES.output}"`,
      ]
    : [providerLine, "code=$?", writeExit];
  // Ctrl-C (cancel, timeout) reaches the whole foreground job. A handler trap,
  // unlike an ignored signal, resets to the default in the provider, so the
  // provider still sees Ctrl-C while the launcher survives to record it.
  const trapExit = (code: number) =>
    `trap 'code=${code}; printf "%s\\n" "$code" > "$run_dir/${RUN_DIR_FILES.exitCode}" 2>/dev/null; exit ${code}'`;
  return [
    "#!/bin/sh",
    `# Paperclip orca_local launcher for heartbeat run ${input.runId}`,
    `run_dir=${runDir}`,
    `${trapExit(130)} INT`,
    `${trapExit(143)} TERM`,
    "set -a",
    `. "$run_dir/${RUN_DIR_FILES.env}"`,
    "set +a",
    `rm -f "$run_dir/${RUN_DIR_FILES.env}"`,
    `cd ${shellQuote(input.cwd)} || { code=98; ${writeExit}; exit 98; }`,
    ...run,
    "",
  ].join("\n");
}

/** Private per-run directory (0700) outside the workspace. */
export async function createRunDir(parentDir: string = os.tmpdir()): Promise<string> {
  const runDir = await fs.mkdtemp(path.join(parentDir, "paperclip-orca-run-"));
  await fs.chmod(runDir, 0o700);
  return runDir;
}

/** Write env (0600), prompt, and launcher; returns the command typed into the Orca terminal. */
export async function writeRunFiles(input: {
  runId: string;
  runDir: string;
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  command: string;
  args: string[];
  captureOutput: boolean;
}): Promise<string> {
  await fs.writeFile(path.join(input.runDir, RUN_DIR_FILES.env), renderEnvFile(input.env), { mode: 0o600 });
  await fs.writeFile(path.join(input.runDir, RUN_DIR_FILES.prompt), input.prompt, { mode: 0o600 });
  const launcherPath = path.join(input.runDir, RUN_DIR_FILES.launcher);
  await fs.writeFile(
    launcherPath,
    renderLaunchScript({
      runId: input.runId,
      runDir: input.runDir,
      cwd: input.cwd,
      command: input.command,
      args: input.args,
      captureOutput: input.captureOutput,
    }),
    { mode: 0o700 },
  );
  return `sh ${shellQuote(launcherPath)}`;
}
