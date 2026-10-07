import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listCursorModels,
  listMuseModels,
  parseCursorModelList,
  resetCursorModelCacheForTests,
  resolveCursorEffortModel,
} from "./models.js";

// Excerpt of real `cursor-agent --list-models` output, zero-width padding included.
const CURSOR_OUTPUT = [
  "Available models",
  "",
  "auto - Auto (default)",
  "composer-2.5 - Composer 2.5",
  "grok-4.7-low - Grok 4.7  Low",
  "grok-4.7-low-fast - Grok 4.7  Low Fast​​",
  "grok-4.7-high - Grok 4.7  High",
  "grok-4.7-xhigh - Grok 4.7  Extra High",
  "grok-4.7-xhigh-fast - Grok 4.7  Extra High Fast​​",
  "cursor-grok-4.6-high - Grok 4.6",
  "kimi-k3-max - Kimi K3",
  "kimi-k3-low - Kimi K3 Low",
  "claude-fable-5-1-high - Claude Fable 5.1 1M (NO ZDR)",
  "claude-fable-5-1-max - Claude Fable 5.1 1M Max (NO ZDR)",
  "gpt-5.3-codex - Codex 5.3",
  "gpt-5.3-codex-high - Codex 5.3 High",
].join("\n");

describe("parseCursorModelList", () => {
  it("keeps ids and readable labels and drops headers and invisible padding", () => {
    const models = parseCursorModelList(CURSOR_OUTPUT);
    expect(models[0]).toEqual({ id: "auto", label: "Auto (default)" });
    expect(models).toContainEqual({ id: "grok-4.7-low-fast", label: "Grok 4.7 Low Fast" });
    expect(models).toContainEqual({ id: "kimi-k3-max", label: "Kimi K3" });
    expect(models).toContainEqual({ id: "claude-fable-5-1-high", label: "Claude Fable 5.1 1M (NO ZDR)" });
    expect(models.some((model) => model.id === "Available")).toBe(false);
  });
});

describe("resolveCursorEffortModel", () => {
  const available = parseCursorModelList(CURSOR_OUTPUT);

  it("swaps the effort suffix and keeps -fast", () => {
    expect(resolveCursorEffortModel("grok-4.7-low", "xhigh", available)).toBe("grok-4.7-xhigh");
    expect(resolveCursorEffortModel("grok-4.7-low-fast", "xhigh", available)).toBe("grok-4.7-xhigh-fast");
    expect(resolveCursorEffortModel("claude-fable-5-1-high", "max", available)).toBe("claude-fable-5-1-max");
    expect(resolveCursorEffortModel("kimi-k3-max", "low", available)).toBe("kimi-k3-low");
  });

  it("adds an effort suffix to a base model when that variant exists", () => {
    expect(resolveCursorEffortModel("gpt-5.3-codex", "high", available)).toBe("gpt-5.3-codex-high");
  });

  it("returns null when Cursor has no such variant", () => {
    expect(resolveCursorEffortModel("composer-2.5", "high", available)).toBeNull();
    expect(resolveCursorEffortModel("grok-4.7-low", "max", available)).toBeNull();
    expect(resolveCursorEffortModel("grok-4.7-low", "ultra", available)).toBeNull();
  });
});

describe("model catalogs", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    resetCursorModelCacheForTests();
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("caches Cursor's list and keeps the last good list when a refresh fails", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      if (calls > 1) throw new Error("signed out");
      return CURSOR_OUTPUT;
    };
    expect((await listCursorModels({ run })).length).toBeGreaterThan(10);
    expect((await listCursorModels({ run })).length).toBeGreaterThan(10);
    expect(calls).toBe(1);
    expect((await listCursorModels({ run, refresh: true })).length).toBeGreaterThan(10);
    expect(calls).toBe(2);
  });

  it("lists Muse's catalog plus the model in the operator's Muse settings", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-muse-settings-"));
    dirs.push(dir);
    const settings = path.join(dir, "settings.json");
    await fs.writeFile(settings, JSON.stringify({ model: "muse-spark-2.0-preview" }));
    expect(await listMuseModels(settings)).toEqual([
      { id: "muse-spark-1.3", label: "Muse Spark 1.3" },
      { id: "muse-spark-2.0-preview", label: "muse-spark-2.0-preview" },
    ]);
    expect(await listMuseModels(path.join(dir, "missing.json"))).toEqual([{ id: "muse-spark-1.3", label: "Muse Spark 1.3" }]);
  });
});
