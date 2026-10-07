import { describe, expect, it } from "vitest";
import type { OrcaLocalEvent } from "../events.js";
import type { OrcaAgentStatus, OrcaTerminalState } from "./orca-cli.js";
import { promptMatches, superviseOrcaRun, type SupervisionDeps, type SupervisionOptions } from "./supervise.js";

const LAUNCHED_AT = 1_000_000;
const PROMPT = "You are agent a-1 (Builder).\n\nWork on PAP-12.";

function status(partial: Partial<OrcaAgentStatus>): OrcaAgentStatus {
  return {
    paneKey: "tab:leaf",
    state: "working",
    stateStartedAt: LAUNCHED_AT + 1,
    updatedAt: LAUNCHED_AT + 1,
    agentType: "claude",
    prompt: null,
    toolName: null,
    toolInput: null,
    lastAssistantMessage: null,
    interrupted: false,
    ...partial,
  };
}

/** Deps that replay one scripted observation per poll and advance a fake clock. */
function scripted(input: {
  statuses?: Array<OrcaAgentStatus | null>;
  exitCodes?: Array<number | null>;
  terminals?: Array<OrcaTerminalState | null>;
  pollMs?: number;
}) {
  let clock = LAUNCHED_AT;
  let statusIndex = 0;
  let exitIndex = 0;
  let terminalIndex = 0;
  const events: OrcaLocalEvent[] = [];
  const live: OrcaTerminalState = { handle: "term_1", connected: true, agentIdentity: "claude", agentWait: null };
  const pick = <T>(list: T[] | undefined, index: number, fallback: T) =>
    list && list.length > 0 ? list[Math.min(index, list.length - 1)] : fallback;
  const deps: SupervisionDeps = {
    agentStatus: async () => pick(input.statuses, statusIndex++, null),
    showTerminal: async () => pick(input.terminals, terminalIndex++, live),
    readExitCode: async () => pick(input.exitCodes, exitIndex++, null),
    drainOutput: async () => undefined,
    emit: async (event) => {
      events.push(event);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, events };
}

const interactive: SupervisionOptions = {
  mode: "interactive",
  launchedAt: LAUNCHED_AT,
  prompt: PROMPT,
  pollIntervalMs: 1_000,
  startupTimeoutMs: 10_000,
  timeoutMs: 0,
  terminalCheckEvery: 1,
};

describe("superviseOrcaRun (interactive)", () => {
  it("ignores a done row from before the turn started, then settles after working → waiting → done", async () => {
    const { deps, events } = scripted({
      statuses: [
        status({ state: "done", prompt: null }),
        status({ state: "working", stateStartedAt: LAUNCHED_AT + 2_000 }),
        status({ state: "waiting", stateStartedAt: LAUNCHED_AT + 3_000, toolName: "Bash", toolInput: "pnpm test" }),
        status({ state: "done", stateStartedAt: LAUNCHED_AT + 4_000, lastAssistantMessage: "All green." }),
      ],
    });
    const outcome = await superviseOrcaRun(deps, interactive);
    expect(outcome.kind).toBe("completed");
    expect(outcome.kind === "completed" && outcome.status?.lastAssistantMessage).toBe("All green.");
    expect(events).toEqual([
      { type: "orca_local.status", state: "working" },
      { type: "orca_local.status", state: "waiting", detail: "Needs input in Orca (Bash: pnpm test)" },
      { type: "orca_local.status", state: "done" },
    ]);
  });

  it("settles a turn that finished between polls when Orca recorded this run's prompt", async () => {
    const { deps } = scripted({
      statuses: [status({ state: "done", prompt: "You are agent a-1 (Builder). Work on PAP-12.", lastAssistantMessage: "Done" })],
    });
    expect((await superviseOrcaRun(deps, interactive)).kind).toBe("completed");
  });

  it("reports an interrupted turn separately from a completed one", async () => {
    const { deps } = scripted({
      statuses: [status({ state: "working" }), status({ state: "done", stateStartedAt: LAUNCHED_AT + 5, interrupted: true })],
    });
    expect((await superviseOrcaRun(deps, interactive)).kind).toBe("interrupted");
  });

  it("fails startup when the provider never starts a turn", async () => {
    const { deps } = scripted({ statuses: [status({ state: "done", prompt: null })] });
    expect((await superviseOrcaRun(deps, interactive)).kind).toBe("startup_timeout");
  });

  it("treats a provider exit before completion as a failure", async () => {
    const { deps } = scripted({ statuses: [status({ state: "working" })], exitCodes: [null, null, 1] });
    expect(await superviseOrcaRun(deps, interactive)).toEqual({ kind: "exited", exitCode: 1 });
  });

  it("fails when the terminal disappears without an exit sentinel", async () => {
    const { deps } = scripted({ statuses: [status({ state: "working" })], terminals: [null] });
    expect((await superviseOrcaRun(deps, interactive)).kind).toBe("terminal_gone");
  });

  it("stops on cancellation and on the hard timeout", async () => {
    const controller = new AbortController();
    const cancelled = scripted({ statuses: [status({ state: "working" })] });
    const sleep = cancelled.deps.sleep;
    cancelled.deps.sleep = async (ms, signal) => {
      controller.abort();
      await sleep(ms, signal);
    };
    expect((await superviseOrcaRun(cancelled.deps, { ...interactive, signal: controller.signal })).kind).toBe("cancelled");

    const timed = scripted({ statuses: [status({ state: "working" })] });
    expect((await superviseOrcaRun(timed.deps, { ...interactive, timeoutMs: 5_000 })).kind).toBe("timed_out");
  });
});

describe("superviseOrcaRun (headless)", () => {
  it("settles on the exit sentinel without consulting hook status", async () => {
    const { deps } = scripted({ exitCodes: [null, null, 0] });
    deps.agentStatus = async () => {
      throw new Error("headless runs must not poll hook status");
    };
    expect(await superviseOrcaRun(deps, { ...interactive, mode: "headless" })).toEqual({
      kind: "completed",
      status: null,
      exitCode: 0,
    });
  });

  it("keeps an exit code that lands as the terminal disappears", async () => {
    const { deps } = scripted({ exitCodes: [null, 2], terminals: [null] });
    expect(await superviseOrcaRun(deps, { ...interactive, mode: "headless" })).toEqual({
      kind: "completed",
      status: null,
      exitCode: 2,
    });
  });
});

describe("promptMatches", () => {
  it("compares whitespace-normalized prefixes and rejects empty prompts", () => {
    expect(promptMatches("You are agent a-1 (Builder).   Work", PROMPT)).toBe(true);
    expect(promptMatches("Something else", PROMPT)).toBe(false);
    expect(promptMatches("", PROMPT)).toBe(false);
    expect(promptMatches(null, PROMPT)).toBe(false);
  });
});
