import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MUSE_MODELS, ORCA_PROVIDER_EFFORTS } from "../index.js";

export interface OrcaModel {
  id: string;
  label: string;
}

const CURSOR_LIST_TIMEOUT_MS = 15_000;
const CURSOR_CACHE_TTL_MS = 5 * 60_000;
// Cursor pads some labels with zero-width spaces and doubled spaces.
const INVISIBLE_PATTERN = /[​-‍⁠﻿]/g;
const MODEL_LINE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._:/[\]=,-]*)\s+-\s+(.+)$/;

/** Parse `cursor-agent --list-models` output: one `<id> - <label>` line per model. */
export function parseCursorModelList(output: string): OrcaModel[] {
  const models: OrcaModel[] = [];
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const match = raw.replace(INVISIBLE_PATTERN, "").trim().match(MODEL_LINE_PATTERN);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: match[2].replace(/\s+/g, " ").trim() || id });
  }
  return models;
}

let cursorCache: { command: string; expiresAt: number; models: OrcaModel[] } | null = null;

export function resetCursorModelCacheForTests() {
  cursorCache = null;
}

/** Models the operator's Cursor account offers; empty when the CLI is missing or signed out. */
export async function listCursorModels(
  options: { command?: string; refresh?: boolean; run?: (command: string) => Promise<string> } = {},
): Promise<OrcaModel[]> {
  const command = options.command?.trim() || "cursor-agent";
  const now = Date.now();
  if (!options.refresh && cursorCache && cursorCache.command === command && cursorCache.expiresAt > now) {
    return cursorCache.models;
  }
  const run = options.run ?? runCursorListModels;
  let models: OrcaModel[] = [];
  try {
    models = parseCursorModelList(await run(command));
  } catch {
    models = [];
  }
  if (models.length > 0) cursorCache = { command, expiresAt: now + CURSOR_CACHE_TTL_MS, models };
  return models.length > 0 ? models : (cursorCache?.command === command ? cursorCache.models : []);
}

function runCursorListModels(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, ["--list-models"], { timeout: CURSOR_LIST_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error && !String(stdout).trim()) reject(error);
      else resolve(String(stdout));
    });
  });
}

/** Muse's catalog plus the model the operator's Muse settings name, if any. */
export async function listMuseModels(settingsPath = path.join(os.homedir(), ".config", "muse", "settings.json")): Promise<OrcaModel[]> {
  const models = [...MUSE_MODELS];
  try {
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as { model?: unknown };
    const configured = typeof settings.model === "string" ? settings.model.trim() : "";
    if (configured && !models.some((model) => model.id === configured)) models.push({ id: configured, label: configured });
  } catch {
    // No readable settings; the catalog alone still applies.
  }
  return models;
}

const CURSOR_EFFORT_SUFFIX = new RegExp(`-(${ORCA_PROVIDER_EFFORTS.cursor.join("|")})(-fast)?$`);

/**
 * Cursor exposes effort as model variants (grok-4.7-low … grok-4.7-xhigh).
 * Returns the variant of `model` at `effort` when Cursor offers it, else null.
 */
export function resolveCursorEffortModel(model: string, effort: string, available: OrcaModel[]): string | null {
  if (!ORCA_PROVIDER_EFFORTS.cursor.includes(effort)) return null;
  const ids = new Set(available.map((entry) => entry.id));
  const match = model.match(CURSOR_EFFORT_SUFFIX);
  const base = match ? model.slice(0, match.index) : model;
  const fast = match?.[2] ?? "";
  const candidate = `${base}-${effort}${fast}`;
  return ids.has(candidate) ? candidate : null;
}
