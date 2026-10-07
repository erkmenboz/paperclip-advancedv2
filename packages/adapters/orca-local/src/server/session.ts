import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export interface OrcaLocalSession {
  provider: string;
  /** Provider session id: the pinned Claude session or the Codex thread id. */
  sessionId: string;
  /** Working directory the session was created in; resume only from the same cwd. */
  cwd: string;
  /** Orca terminal of the last run, for display and diagnostics only. */
  lastTerminalHandle?: string;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeOrcaLocalSession(raw: unknown): OrcaLocalSession | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const provider = readString(record.provider);
  const sessionId = readString(record.sessionId);
  const cwd = readString(record.cwd);
  if (!provider || !sessionId || !cwd) return null;
  const lastTerminalHandle = readString(record.lastTerminalHandle);
  return { provider, sessionId, cwd, ...(lastTerminalHandle ? { lastTerminalHandle } : {}) };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize: (raw) => normalizeOrcaLocalSession(raw) as Record<string, unknown> | null,
  serialize: (params) => normalizeOrcaLocalSession(params) as Record<string, unknown> | null,
  getDisplayId(params) {
    return normalizeOrcaLocalSession(params)?.sessionId ?? null;
  },
};
