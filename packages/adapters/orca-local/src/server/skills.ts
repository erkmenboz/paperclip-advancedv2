import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterExecutionContext,
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
  ensurePaperclipSkillSymlink,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildOrcaSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: "orca_local",
    availableEntries,
    desiredSkills: resolveLegacyPaperclipDesiredSkillNames(config, availableEntries),
    configuredDetail: "Will be mounted for the provider on the next Orca run.",
  });
}

export async function listOrcaSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOrcaSkillSnapshot(ctx.config);
}

export async function syncOrcaSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildOrcaSkillSnapshot(ctx.config);
}

/** Desired, mountable skills for this run; logs each enabled skill whose files are missing. */
export async function resolveRunSkills(
  config: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
): Promise<PaperclipSkillEntry[]> {
  const entries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desired = new Set(resolveLegacyPaperclipDesiredSkillNames(config, entries));
  const mountable: PaperclipSkillEntry[] = [];
  for (const entry of entries) {
    if (!desired.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) {
      await onLog(
        "stderr",
        `[paperclip] Warning: skill "${entry.key}" is enabled for this agent but its files are unavailable and it was not mounted${entry.missingDetail ? `: ${entry.missingDetail}` : "."}\n`,
      );
      continue;
    }
    mountable.push(entry);
  }
  return mountable;
}

/**
 * Claude discovers skills from `<dir>/.claude/skills` for every `--add-dir`.
 * Mount the run's skills under the private run directory so nothing is
 * written into the workspace or the user's Claude home.
 */
export async function mountClaudeSkills(
  runDir: string,
  skills: PaperclipSkillEntry[],
  onLog: AdapterExecutionContext["onLog"],
): Promise<string | null> {
  if (skills.length === 0) return null;
  const root = path.join(runDir, "skills");
  const skillsHome = path.join(root, ".claude", "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  for (const entry of skills) {
    try {
      await ensurePaperclipSkillSymlink(entry.source, path.join(skillsHome, entry.runtimeName));
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to mount skill "${entry.key}" for Claude: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return root;
}

/** Codex runs with the operator's own CODEX_HOME, so skills are referenced by path in the prompt. */
export function renderSkillPathNote(skills: PaperclipSkillEntry[]): string {
  if (skills.length === 0) return "";
  return [
    "Paperclip skills for this run (read a skill's SKILL.md before following its procedure):",
    ...skills.map((entry) => `- ${entry.runtimeName}: ${path.join(entry.source, "SKILL.md")}`),
  ].join("\n");
}
