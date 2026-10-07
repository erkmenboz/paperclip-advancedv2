import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
} from "@paperclipai/adapter-utils/server-utils";
import { ORCA_PROVIDER_EFFORTS, ORCA_PROVIDERS, type OrcaProviderId } from "../index.js";

const CODEX_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

export interface OrcaLocalConfig {
  provider: OrcaProviderId | null;
  /** The raw provider value, kept for error messages when it is unsupported. */
  rawProvider: string;
  mode: "interactive" | "headless";
  model: string | null;
  /** Thinking effort, already validated for the provider; null means the provider default. */
  effort: string | null;
  /** The raw effort value when it is not valid for the provider, for a warning. */
  rejectedEffort: string | null;
  orcaWorkspace: string | null;
  orcaCommand: string;
  providerCommand: string;
  extraArgs: string[];
  dangerouslySkipPermissions: boolean;
  /** Answer Claude's workspace-trust dialog for the run's own workspace. */
  trustWorkspace: boolean;
  codexSandbox: string;
  /** Sandbox network access for codex and muse; the agent needs it for the Paperclip API. */
  networkAccess: boolean;
  terminalRetention: "keep" | "close";
  pollIntervalMs: number;
  startupTimeoutMs: number;
  timeoutMs: number;
}

function defaultProviderCommand(provider: OrcaProviderId | null): string {
  return provider === "cursor" ? "cursor-agent" : (provider ?? "claude");
}

export function parseOrcaProvider(value: unknown): OrcaProviderId | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ORCA_PROVIDERS.find((provider) => provider.id === raw)?.id ?? null;
}

export function parseOrcaLocalConfig(config: Record<string, unknown>): OrcaLocalConfig {
  const rawProvider = asString(config.provider, "").trim();
  const provider = parseOrcaProvider(rawProvider);
  const descriptor = ORCA_PROVIDERS.find((entry) => entry.id === provider);
  const codexSandbox = asString(config.codexSandbox, "workspace-write").trim();
  const rawEffort = asString(config.effort, "").trim().toLowerCase();
  const effortValid = Boolean(provider && rawEffort && ORCA_PROVIDER_EFFORTS[provider].includes(rawEffort));
  return {
    provider,
    rawProvider,
    mode: descriptor?.mode ?? "interactive",
    model: asString(config.model, "").trim() || null,
    effort: effortValid ? rawEffort : null,
    rejectedEffort: rawEffort && !effortValid ? rawEffort : null,
    orcaWorkspace: asString(config.orcaWorkspace, "").trim() || null,
    orcaCommand: asString(config.orcaCommand, "").trim() || "orca",
    providerCommand: asString(config.providerCommand, "").trim() || defaultProviderCommand(provider),
    extraArgs: asStringArray(config.extraArgs),
    dangerouslySkipPermissions: asBoolean(config.dangerouslySkipPermissions, false),
    trustWorkspace: asBoolean(config.trustWorkspace, true),
    codexSandbox: CODEX_SANDBOX_MODES.has(codexSandbox) ? codexSandbox : "workspace-write",
    networkAccess: asBoolean(config.networkAccess, asBoolean(config.codexNetworkAccess, true)),
    terminalRetention: asString(config.terminalRetention, "keep").trim() === "close" ? "close" : "keep",
    pollIntervalMs: Math.max(0.5, asNumber(config.pollIntervalSec, 2)) * 1000,
    startupTimeoutMs: Math.max(10, asNumber(config.startupTimeoutSec, 120)) * 1000,
    timeoutMs: Math.max(0, asNumber(config.timeoutSec, 0)) * 1000,
  };
}
