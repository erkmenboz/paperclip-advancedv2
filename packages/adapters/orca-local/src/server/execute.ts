import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult, UsageSummary } from "@paperclipai/adapter-utils";
import { adapterExecutionTargetIsRemote } from "@paperclipai/adapter-utils/execution-target";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  applyPaperclipWorkspaceEnv,
  asString,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  hydrateFreshSessionHandoff,
  isForbiddenConfigEnvKey,
  isPaperclipRecoveryWakePayload,
  isPaperclipRuntimeEnvKey,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  renderTemplate,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import type { OrcaLocalEvent, OrcaLocalOutcome } from "../events.js";
import { ClaudeTranscriptReader } from "./claude-transcript.js";
import { parseOrcaLocalConfig, type OrcaLocalConfig } from "./config.js";
import {
  PROMPT_ARG,
  RUN_DIR_FILES,
  buildProviderArgs,
  createRunDir,
  writeRunFiles,
} from "./launcher.js";
import { OrcaCli, OrcaCliError, type OrcaTerminal } from "./orca-cli.js";
import { normalizeOrcaLocalSession, type OrcaLocalSession } from "./session.js";
import { listCursorModels, resolveCursorEffortModel } from "./models.js";
import { mountClaudeSkills, renderSkillPathNote, resolveRunSkills } from "./skills.js";
import { ARROW_DOWN, ENTER, isClaudeTrustPrompt, isTrustOptionSelected } from "./trust-prompt.js";
import {
  OutputTail,
  readExitCodeFile,
  sleepWithSignal,
  superviseOrcaRun,
  type SupervisionOutcome,
} from "./supervise.js";

/** How long a cancelled or timed-out run waits for the provider to react to Ctrl-C. */
const STOP_GRACE_MS = 8_000;
const MAX_SUMMARY_CHARS = 4_000;
const CODEX_SESSION_ID_PATTERN = /session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const CODEX_MODEL_PATTERN = /^model:\s*(\S+)\s*$/m;

export interface OrcaExecuteDeps {
  cli?: OrcaCli;
  /** Create an empty Cursor chat and return its id (cursor-agent create-chat). */
  createCursorChat?: (command: string) => Promise<string | null>;
  /** Cursor's model list, used to apply effort as a model variant. */
  listCursorModels?: typeof listCursorModels;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Parent directory for run dirs; defaults to the OS temp dir. */
  runDirParent?: string;
  claudeConfigDir?: string;
}

function asStringEnvMap(value: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parseObject(value))) {
    if (typeof entry === "string") {
      env[key] = entry;
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      if (record.type === "plain" && typeof record.value === "string") env[key] = record.value;
    }
  }
  return env;
}

function trimNullable(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Environment for the provider process: configured env first, then the
 * harness-owned PAPERCLIP_* contract, which always wins. PAPERCLIP_API_KEY only
 * ever comes from the run token.
 */
export function buildProviderEnv(ctx: AdapterExecutionContext, cwd: string): Record<string, string> {
  const { runId, agent, context, authToken } = ctx;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(asStringEnvMap(ctx.config.env))) {
    if (isForbiddenConfigEnvKey(key) || isPaperclipRuntimeEnvKey(key)) continue;
    env[key] = value;
  }
  Object.assign(env, buildPaperclipEnv(agent), buildRuntimeToolsEnv(ctx.runtimeTools));
  env.PAPERCLIP_RUN_ID = runId;
  if (authToken) env.PAPERCLIP_API_KEY = authToken;

  const wakeTaskId = trimNullable(context.taskId) ?? trimNullable(context.issueId);
  const wakeReason = trimNullable(context.wakeReason);
  const wakeCommentId = trimNullable(context.wakeCommentId) ?? trimNullable(context.commentId);
  const approvalId = trimNullable(context.approvalId);
  const approvalStatus = trimNullable(context.approvalStatus);
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;

  const workspace = parseObject(context.paperclipWorkspace);
  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: cwd,
    workspaceSource: trimNullable(workspace.source),
    workspaceStrategy: trimNullable(workspace.strategy),
    workspaceId: trimNullable(workspace.workspaceId),
    workspaceRepoUrl: trimNullable(workspace.repoUrl),
    workspaceRepoRef: trimNullable(workspace.repoRef),
    workspaceBranch: trimNullable(workspace.branchName),
    workspaceWorktreePath: trimNullable(workspace.worktreePath),
    agentHome: trimNullable(workspace.agentHome),
  });
  return env;
}

/** Same precedence as claude_local: project workspace, then configured cwd, then the server cwd. */
export function resolveRunCwd(config: Record<string, unknown>, context: Record<string, unknown>): string {
  const workspace = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspace.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfigured = asString(workspace.source, "") === "agent_home" && configuredCwd.length > 0;
  return (useConfigured ? "" : workspaceCwd) || configuredCwd || process.cwd();
}

const CURSOR_CHAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{7,}$/;

/** Create an empty Cursor chat so this agent's session id is known before launch. */
export function createCursorChat(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, ["create-chat"], { timeout: 30_000 }, (error, stdout) => {
      const id = String(stdout).trim().split(/\s+/).pop() ?? "";
      resolve(!error && CURSOR_CHAT_ID_PATTERN.test(id) ? id : null);
    });
  });
}

function gitToplevel(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null);
    });
  });
}

async function buildInstructionsPrefix(
  config: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
): Promise<string> {
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  if (!instructionsFilePath) return "";
  try {
    const contents = await fs.readFile(instructionsFilePath, "utf8");
    const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
    return `${contents.trim()}\n\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsDir}.\n`;
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return "";
  }
}

function renderEnvNote(env: Record<string, string>): string {
  const keys = Object.keys(env).filter((key) => key.startsWith("PAPERCLIP_")).sort();
  if (keys.length === 0) return "";
  return `Paperclip runtime note: these PAPERCLIP_* environment variables are set in your shell: ${keys.join(", ")}. Use them directly instead of assuming they are absent.`;
}

function billingFor(provider: string, env: Record<string, string>) {
  if (provider === "cursor") return { provider: "cursor", biller: "cursor", billingType: "subscription" } as const;
  if (provider === "muse") return { provider: "meta", biller: "meta", billingType: "subscription" } as const;
  if (provider === "codex") {
    return { provider: "openai", biller: "openai", billingType: env.OPENAI_API_KEY ? "api" : "subscription" } as const;
  }
  return { provider: "anthropic", biller: "anthropic", billingType: env.ANTHROPIC_API_KEY ? "api" : "subscription" } as const;
}

function failure(errorMessage: string, errorCode: string, extra: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult {
  return { exitCode: 1, signal: null, timedOut: false, errorMessage, errorCode, ...extra };
}

export async function execute(
  ctx: AdapterExecutionContext,
  deps: OrcaExecuteDeps = {},
): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, context, onLog, onMeta } = ctx;
  const config = parseOrcaLocalConfig(ctx.config);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepWithSignal;

  if (!config.provider) {
    return failure(
      config.rawProvider
        ? `orca_local does not support provider "${config.rawProvider}".`
        : "orca_local requires adapterConfig.provider.",
      "orca_provider_invalid",
    );
  }
  if (adapterExecutionTargetIsRemote(ctx.executionTarget)) {
    return failure("orca_local drives the local Orca runtime and cannot run on a remote execution target.", "orca_remote_unsupported");
  }
  const provider = config.provider;
  const cli = deps.cli ?? new OrcaCli({ command: config.orcaCommand });
  const cwd = resolveRunCwd(ctx.config, context);

  // Resolve where the terminal tab lives. The provider always works in `cwd`.
  const toplevel = config.orcaWorkspace ? null : await gitToplevel(cwd);
  const selector = config.orcaWorkspace ?? (toplevel ? `path:${toplevel}` : null);
  let worktree: Awaited<ReturnType<OrcaCli["findWorktree"]>> = null;
  try {
    worktree = selector ? await cli.findWorktree(selector) : null;
  } catch (err) {
    return failure(`Could not reach Orca: ${err instanceof Error ? err.message : String(err)}`, "orca_unreachable");
  }
  if (!worktree) {
    return failure(
      selector
        ? `Orca has no worktree for ${selector}. Add the repository with \`orca repo add --path ${toplevel ?? "<repo>"}\`, or set orcaWorkspace on this agent.`
        : `The run's workspace (${cwd}) is not inside a git repository, so there is no Orca worktree to host the terminal. Set orcaWorkspace on this agent.`,
      "orca_workspace_not_found",
    );
  }

  const env = buildProviderEnv(ctx, cwd);
  const previous = normalizeOrcaLocalSession(runtime.sessionParams);
  const canResume = Boolean(previous && previous.provider === provider && path.resolve(previous.cwd) === path.resolve(cwd));
  const resumeSessionId = canResume ? previous!.sessionId : null;
  if (config.rejectedEffort) {
    await onLog("stderr", `[paperclip] Ignoring effort "${config.rejectedEffort}": ${provider} does not accept it.\n`);
  }
  // Cursor carries effort in the model id, so switch to the matching variant.
  let model = config.model;
  if (provider === "cursor" && config.effort) {
    if (!model) {
      await onLog("stderr", `[paperclip] Effort "${config.effort}" needs a Cursor model to apply to; using Cursor's default model.\n`);
    } else {
      const available = await (deps.listCursorModels ?? listCursorModels)({ command: config.providerCommand });
      const variant = resolveCursorEffortModel(model, config.effort, available);
      if (variant) model = variant;
      else await onLog("stderr", `[paperclip] Cursor offers no "${config.effort}" variant of ${model}; running ${model} as selected.\n`);
    }
  }
  const pinnedSessionId =
    provider === "claude"
      ? (resumeSessionId ?? randomUUID())
      : provider === "cursor"
        ? (resumeSessionId ?? (await (deps.createCursorChat ?? createCursorChat)(config.providerCommand)))
        : null;

  const promptTemplate = asString(
    ctx.config.promptTemplate,
    context.conversationMode === true ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const bootstrapPromptTemplate = asString(ctx.config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  await hydrateFreshSessionHandoff(ctx, { resumedSession: canResume });
  const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
    resumedSession: canResume,
    includeCommunicationGuidance: false,
  });
  const skills = await resolveRunSkills(ctx.config, onLog);
  const prompt = joinPromptSections([
    selectInitialCommunicationGuidance(context, { resumedSession: canResume }),
    await buildInstructionsPrefix(ctx.config, onLog),
    !canResume && bootstrapPromptTemplate.trim() ? renderTemplate(bootstrapPromptTemplate, templateData).trim() : "",
    wakePrompt,
    taskContextNote,
    renderEnvNote(env),
    provider === "claude" ? "" : renderSkillPathNote(skills),
    (canResume && wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData).trim(),
    asString(context.paperclipSessionHandoffMarkdown, "").trim(),
  ]);

  const runDir = await createRunDir(deps.runDirParent);
  try {
    const claudeAddDir = provider === "claude" ? await mountClaudeSkills(runDir, skills, onLog) : null;
    const args = buildProviderArgs({
      provider,
      command: config.providerCommand,
      runDir,
      model,
      effort: provider === "cursor" ? null : config.effort,
      resumeSessionId,
      pinnedSessionId,
      dangerouslySkipPermissions: config.dangerouslySkipPermissions,
      codexSandbox: config.codexSandbox,
      networkAccess: config.networkAccess,
      trustWorkspace: config.trustWorkspace,
      claudeAddDir,
      extraArgs: config.extraArgs,
    });
    const terminalCommand = await writeRunFiles({
      runId,
      runDir,
      cwd,
      env,
      prompt,
      command: config.providerCommand,
      args,
      captureOutput: config.mode === "headless",
    });

    await onMeta?.({
      adapterType: "orca_local",
      command: config.providerCommand,
      cwd,
      commandArgs: args.map((arg) => (arg === PROMPT_ARG ? "<prompt>" : arg)),
      commandNotes: [
        `Orca worktree: ${worktree.path} (${worktree.id})`,
        `Supervision: ${config.mode === "interactive" ? "Orca status hooks" : "provider exit code"}`,
        resumeSessionId ? `Resuming ${provider} session ${resumeSessionId}` : `Starting a new ${provider} session`,
        `PAPERCLIP_* variables reach the provider through a private env file (${Object.keys(env).length} keys).`,
      ],
      prompt,
      promptMetrics: { promptChars: prompt.length, wakePromptChars: wakePrompt.length, taskContextChars: taskContextNote.length },
    });

    // No local child process exists to kill, so opt in to signal-based cancellation.
    await ctx.onCancellationReady?.();
    if (ctx.signal?.aborted) {
      return {
        ...cancelledResult(),
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      };
    }

    ctx.onDispatch?.();
    const launchedAt = now();
    let terminal: OrcaTerminal;
    try {
      terminal = await cli.createTerminal({
        worktree: `id:${worktree.id}`,
        title: `Paperclip · ${agent.name}`,
        command: terminalCommand,
      });
    } catch (err) {
      return failure(
        `Orca could not open a terminal: ${err instanceof OrcaCliError ? `${err.code}: ${err.message}` : String(err)}`,
        "orca_terminal_create_failed",
      );
    }

    const emit = (event: OrcaLocalEvent) => onLog("stdout", `${JSON.stringify(event)}\n`);
    await emit({
      type: "orca_local.init",
      provider,
      mode: config.mode,
      ...(model ? { model } : {}),
      ...(pinnedSessionId ?? resumeSessionId ? { sessionId: (pinnedSessionId ?? resumeSessionId)! } : {}),
      resumed: Boolean(resumeSessionId),
      terminalHandle: terminal.handle,
      ...(terminal.paneKey ? { paneKey: terminal.paneKey } : {}),
      orcaWorktree: worktree.path,
      title: terminal.title ?? `Paperclip · ${agent.name}`,
    });

    const transcript = provider === "claude" && pinnedSessionId
      ? new ClaudeTranscriptReader({
          claudeConfigDir: deps.claudeConfigDir ?? resolveClaudeConfigDir(env),
          sessionId: pinnedSessionId,
          launchedAt,
        })
      : null;
    const outputTail = config.mode === "headless" ? new OutputTail(path.join(runDir, RUN_DIR_FILES.output)) : null;
    const drainOutput = async (flush = false) => {
      if (transcript) for (const event of await transcript.poll()) await emit(event);
      if (outputTail) {
        const lines = await outputTail.readLines(flush);
        if (lines.length > 0) await emit({ type: "orca_local.output", text: lines.join("\n") });
      }
    };
    const exitCodePath = path.join(runDir, RUN_DIR_FILES.exitCode);
    const workspacePaths = [cwd, await fs.realpath(cwd).catch(() => cwd)];
    let trustAccepted = false;
    const answerTrustPrompt = async () => {
      if (trustAccepted) return;
      const screen = await cli.readScreen(terminal.handle).catch(() => null);
      if (!screen || !isClaudeTrustPrompt(screen, workspacePaths)) return;
      if (!isTrustOptionSelected(screen)) {
        await cli.sendInput(terminal.handle, ARROW_DOWN);
        await sleep(300);
        const moved = await cli.readScreen(terminal.handle).catch(() => null);
        // Never press Enter unless the cursor is proven to be on the trust option.
        if (!moved || !isTrustOptionSelected(moved)) return;
      }
      await cli.sendInput(terminal.handle, ENTER);
      trustAccepted = true;
      await emit({ type: "orca_local.status", state: "starting", detail: `Accepted Claude's workspace trust prompt for ${cwd}` });
    };

    const outcome = await superviseOrcaRun(
      {
        agentStatus: () => (terminal.paneKey ? cli.agentStatus(terminal.paneKey) : Promise.resolve(null)),
        showTerminal: () => cli.showTerminal(terminal.handle),
        readExitCode: () => readExitCodeFile(exitCodePath),
        drainOutput: () => drainOutput(),
        ...(provider === "claude" && config.trustWorkspace ? { onStartupPending: answerTrustPrompt } : {}),
        emit,
        sleep,
        now,
      },
      {
        mode: config.mode,
        launchedAt,
        prompt,
        pollIntervalMs: config.pollIntervalMs,
        startupTimeoutMs: config.startupTimeoutMs,
        timeoutMs: config.timeoutMs,
        signal: ctx.signal,
      },
    );

    if (outcome.kind === "cancelled" || outcome.kind === "timed_out") {
      await stopProvider(cli, terminal.handle, exitCodePath, sleep, now);
    }
    await drainOutput(true);
    const codexHeader = provider === "codex" ? await readCodexHeader(runDir) : null;

    return await settle({
      outcome,
      config,
      provider,
      cli,
      terminal,
      runDir,
      cwd,
      env,
      transcript,
      sessionId: pinnedSessionId ?? codexHeader?.sessionId ?? resumeSessionId,
      reportedModel: codexHeader?.model ?? model,
      resumed: Boolean(resumeSessionId),
      emit,
      onLog,
    });
  } finally {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function cancelledResult(): AdapterExecutionResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorCode: "cancelled",
    errorMessage: "Orca run was cancelled",
    resultJson: { executionCancellation: { state: "acknowledged", acknowledgedAt: new Date().toISOString() } },
  };
}

function resolveClaudeConfigDir(env: Record<string, string>): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

/** Interrupt the provider (Ctrl-C) and give it a moment to settle; the tab itself is kept. */
async function stopProvider(
  cli: OrcaCli,
  handle: string,
  exitCodePath: string,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
) {
  try {
    await cli.interrupt(handle);
  } catch {
    // The terminal may already be gone; nothing left to stop.
    return;
  }
  const deadline = now() + STOP_GRACE_MS;
  while (now() < deadline) {
    if ((await readExitCodeFile(exitCodePath)) !== null) return;
    await sleep(500);
  }
}

/** Session id and model from the header `codex exec` prints before it starts. */
async function readCodexHeader(runDir: string): Promise<{ sessionId: string | null; model: string | null }> {
  try {
    const output = await fs.readFile(path.join(runDir, RUN_DIR_FILES.output), "utf8");
    const header = output.slice(0, 4_000);
    return {
      sessionId: header.match(CODEX_SESSION_ID_PATTERN)?.[1] ?? null,
      model: header.match(CODEX_MODEL_PATTERN)?.[1] ?? null,
    };
  } catch {
    return { sessionId: null, model: null };
  }
}

async function readLastMessage(runDir: string): Promise<string | null> {
  try {
    const text = (await fs.readFile(path.join(runDir, RUN_DIR_FILES.lastMessage), "utf8")).trim();
    return text || null;
  } catch {
    return null;
  }
}

async function settle(input: {
  outcome: SupervisionOutcome;
  config: OrcaLocalConfig;
  provider: string;
  cli: OrcaCli;
  terminal: OrcaTerminal;
  runDir: string;
  cwd: string;
  env: Record<string, string>;
  transcript: ClaudeTranscriptReader | null;
  sessionId: string | null;
  /** Model the provider reported, when it is not available from a transcript. */
  reportedModel: string | null;
  resumed: boolean;
  emit: (event: OrcaLocalEvent) => Promise<void>;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<AdapterExecutionResult> {
  const { outcome, config, provider, cli, terminal, transcript } = input;
  const usage: UsageSummary | null = transcript?.usage() ?? null;
  const model = transcript?.model() ?? input.reportedModel ?? config.model;
  const transcriptSeen = transcript ? usage !== null : true;

  let result: OrcaLocalOutcome;
  let errorMessage: string | null = null;
  let errorCode: string | null = null;
  let exitCode: number | null = null;
  let summary: string | null = null;
  let clearSession = false;
  let screen: string[] | null = null;

  switch (outcome.kind) {
    case "completed": {
      exitCode = outcome.exitCode ?? 0;
      summary = outcome.status?.lastAssistantMessage ?? (await readLastMessage(input.runDir));
      if (exitCode === 0) {
        result = "succeeded";
      } else {
        result = "failed";
        errorCode = "orca_provider_failed";
        errorMessage = `${provider} exited with code ${exitCode}.`;
      }
      break;
    }
    case "interrupted":
      result = "failed";
      errorCode = "orca_turn_interrupted";
      errorMessage = "The turn was interrupted in Orca before it finished.";
      summary = outcome.status.lastAssistantMessage;
      break;
    case "exited":
      result = "failed";
      exitCode = outcome.exitCode;
      errorCode = "orca_provider_exited";
      errorMessage = `${provider} exited (code ${outcome.exitCode}) before finishing its turn.`;
      // A resume of a session the provider no longer has fails immediately; start fresh next time.
      clearSession = input.resumed && !transcriptSeen;
      break;
    case "terminal_gone":
      result = "failed";
      errorCode = "orca_terminal_gone";
      errorMessage = "The Orca terminal closed before the turn finished.";
      break;
    case "startup_timeout":
      result = "failed";
      errorCode = "orca_startup_timeout";
      screen = await cli.readScreen(terminal.handle).catch(() => null);
      errorMessage = screen && isClaudeTrustPrompt(screen, [input.cwd])
        ? `Claude is waiting for someone to trust ${input.cwd} in the Orca tab. Answer it there, or enable trustWorkspace on this agent.`
        : `${provider} did not start its turn within ${Math.round(config.startupTimeoutMs / 1000)}s. Check the Orca tab for a prompt that needs an answer.`;
      break;
    case "timed_out":
      result = "timed_out";
      errorCode = "timeout";
      errorMessage = `Orca run exceeded timeoutSec (${Math.round(config.timeoutMs / 1000)}s) and was interrupted.`;
      break;
    case "cancelled":
      result = "cancelled";
      break;
  }

  await input.emit({
    type: "orca_local.result",
    outcome: result,
    ...(summary ? { summary: truncate(summary, MAX_SUMMARY_CHARS) } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
    ...(exitCode !== null ? { exitCode } : {}),
    ...(usage
      ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens ?? 0 }
      : {}),
  });

  if (result === "succeeded" && config.terminalRetention === "close") {
    await cli.closeTerminal(terminal.handle).catch(async (err) => {
      await input.onLog("stderr", `[paperclip] Could not close Orca terminal ${terminal.handle}: ${String(err)}\n`);
    });
  }

  const nextSession: OrcaLocalSession | null =
    input.sessionId && transcriptSeen && !clearSession
      ? { provider, sessionId: input.sessionId, cwd: input.cwd, lastTerminalHandle: terminal.handle }
      : null;
  const billing = billingFor(provider, input.env);
  const resultJson: Record<string, unknown> = {
    outcome: result,
    terminalHandle: terminal.handle,
    paneKey: terminal.paneKey,
    ...(summary ? { summary: truncate(summary, MAX_SUMMARY_CHARS) } : {}),
    ...(screen ? { screen } : {}),
  };

  if (result === "cancelled") {
    const cancelled = cancelledResult();
    return {
      ...cancelled,
      ...billing,
      model,
      ...(usage ? { usage, usageBasis: "per_run" as const } : {}),
      sessionParams: nextSession as Record<string, unknown> | null,
      sessionDisplayId: nextSession?.sessionId ?? null,
      resultJson: { ...resultJson, ...cancelled.resultJson },
    };
  }

  return {
    exitCode: result === "succeeded" ? 0 : (exitCode ?? 1),
    signal: null,
    timedOut: result === "timed_out",
    errorMessage,
    errorCode,
    ...billing,
    model,
    ...(usage ? { usage, usageBasis: "per_run" as const } : {}),
    costUsd: null,
    summary: summary ? truncate(summary, MAX_SUMMARY_CHARS) : null,
    sessionId: nextSession?.sessionId ?? null,
    sessionParams: nextSession as Record<string, unknown> | null,
    sessionDisplayId: nextSession?.sessionId ?? null,
    clearSession,
    resultJson,
  };
}
