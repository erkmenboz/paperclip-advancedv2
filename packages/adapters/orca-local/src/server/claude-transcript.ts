import fs from "node:fs/promises";
import path from "node:path";
import type { UsageSummary } from "@paperclipai/adapter-utils";
import type { OrcaLocalEvent } from "../events.js";

/**
 * Tails the transcript of a pinned Claude session
 * (`<claudeConfigDir>/projects/<cwd-slug>/<sessionId>.jsonl`) so the run log
 * gets assistant text and tool activity, and the run gets token usage.
 *
 * The transcript is untrusted provider output: entries are parsed defensively,
 * truncated, and only ever recorded, never acted on. A resumed session also
 * contains earlier turns, so entries older than this run's launch are skipped.
 */

const MAX_TEXT_CHARS = 4_000;
const MAX_TOOL_CHARS = 2_000;
/** Tolerate small clock skew between the adapter and Claude's timestamps. */
const LAUNCH_SKEW_MS = 2_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyToolValue(content);
  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export async function findClaudeSessionTranscript(
  claudeConfigDir: string,
  sessionId: string,
): Promise<string | null> {
  const projectsDir = path.join(claudeConfigDir, "projects");
  let entries: string[];
  try {
    entries = await fs.readdir(projectsDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = path.join(projectsDir, entry, `${sessionId}.jsonl`);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Not in this project directory.
    }
  }
  return null;
}

export class ClaudeTranscriptReader {
  private filePath: string | null = null;
  private offset = 0;
  private partial = "";
  private readonly seenEntries = new Set<string>();
  private readonly usageByMessage = new Map<string, UsageSummary>();
  private lastModel: string | null = null;

  constructor(
    private readonly input: {
      claudeConfigDir: string;
      sessionId: string;
      /** Epoch ms of this run's launch; earlier entries belong to previous turns. */
      launchedAt: number;
    },
  ) {}

  /** New run-log events since the previous poll. Missing transcript yields none. */
  async poll(): Promise<OrcaLocalEvent[]> {
    if (!this.filePath) {
      this.filePath = await findClaudeSessionTranscript(this.input.claudeConfigDir, this.input.sessionId);
      if (!this.filePath) return [];
    }
    let chunk: string;
    try {
      const handle = await fs.open(this.filePath, "r");
      try {
        const { size } = await handle.stat();
        if (size <= this.offset) return [];
        const buffer = Buffer.alloc(size - this.offset);
        await handle.read(buffer, 0, buffer.length, this.offset);
        this.offset = size;
        chunk = buffer.toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
    const text = this.partial + chunk;
    const lines = text.split("\n");
    this.partial = lines.pop() ?? "";
    const events: OrcaLocalEvent[] = [];
    for (const line of lines) events.push(...this.consumeLine(line));
    return events;
  }

  usage(): UsageSummary | null {
    if (this.usageByMessage.size === 0) return null;
    const total: UsageSummary = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    for (const usage of this.usageByMessage.values()) {
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.cachedInputTokens = (total.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0);
    }
    return total;
  }

  model(): string | null {
    return this.lastModel;
  }

  private consumeLine(line: string): OrcaLocalEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let entry: Record<string, unknown> | null;
    try {
      entry = asRecord(JSON.parse(trimmed));
    } catch {
      return [];
    }
    if (!entry || (entry.type !== "assistant" && entry.type !== "user")) return [];
    const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    if (!Number.isFinite(timestamp) || timestamp < this.input.launchedAt - LAUNCH_SKEW_MS) return [];
    const entryId = typeof entry.uuid === "string" ? entry.uuid : trimmed;
    if (this.seenEntries.has(entryId)) return [];
    this.seenEntries.add(entryId);

    const message = asRecord(entry.message);
    if (!message) return [];
    const content = Array.isArray(message.content) ? message.content : [];

    if (entry.type === "assistant") {
      this.recordUsage(message);
      const events: OrcaLocalEvent[] = [];
      for (const part of content) {
        const block = asRecord(part);
        if (!block) continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          events.push({ type: "orca_local.assistant", text: truncate(block.text, MAX_TEXT_CHARS) });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          events.push({
            type: "orca_local.tool_call",
            name: block.name,
            ...(typeof block.id === "string" ? { toolUseId: block.id } : {}),
            input: truncate(stringifyToolValue(block.input), MAX_TOOL_CHARS),
          });
        }
      }
      return events;
    }

    const events: OrcaLocalEvent[] = [];
    for (const part of content) {
      const block = asRecord(part);
      if (block?.type !== "tool_result") continue;
      events.push({
        type: "orca_local.tool_result",
        ...(typeof block.tool_use_id === "string" ? { toolUseId: block.tool_use_id } : {}),
        content: truncate(toolResultText(block.content), MAX_TOOL_CHARS),
        isError: block.is_error === true,
      });
    }
    return events;
  }

  private recordUsage(message: Record<string, unknown>) {
    if (typeof message.model === "string" && message.model && message.model !== "<synthetic>") {
      this.lastModel = message.model;
    }
    const usage = asRecord(message.usage);
    const messageId = typeof message.id === "string" ? message.id : null;
    if (!usage || !messageId) return;
    // Claude writes one transcript line per content block, each repeating the
    // message's usage; keying by message id counts every message once.
    this.usageByMessage.set(messageId, {
      inputTokens: asNumber(usage.input_tokens) + asNumber(usage.cache_creation_input_tokens),
      outputTokens: asNumber(usage.output_tokens),
      cachedInputTokens: asNumber(usage.cache_read_input_tokens),
    });
  }
}
