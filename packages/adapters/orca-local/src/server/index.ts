import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { ORCA_PROVIDERS } from "../index.js";

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { sessionCodec } from "./session.js";
export { listOrcaSkills, syncOrcaSkills } from "./skills.js";
export { listCursorModels as listOrcaCursorModels, listMuseModels as listOrcaMuseModels } from "./models.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "provider",
        label: "Orca provider",
        type: "select",
        required: true,
        default: "claude",
        options: ORCA_PROVIDERS.map((provider) => ({
          value: provider.id,
          label: `${provider.label} (${provider.mode === "interactive" ? "interactive" : "headless"})`,
        })),
        hint: "Agent CLI Orca runs for this agent. Claude, Cursor, and Muse run interactively in the Orca tab; Codex runs codex exec there.",
      },
      {
        key: "model",
        label: "Model",
        type: "text",
        hint: "Provider model id. Leave empty to use the provider's default.",
      },
      {
        key: "orcaWorkspace",
        label: "Orca workspace",
        type: "text",
        hint: "Optional Orca worktree selector (for example path:/abs/repo). Default: the Orca worktree containing the run's workspace.",
      },
      {
        key: "terminalRetention",
        label: "After a run",
        type: "select",
        default: "keep",
        options: [
          { value: "keep", label: "Keep the Orca tab open" },
          { value: "close", label: "Close the tab when the run succeeds" },
        ],
        hint: "Failed and cancelled runs always keep their tab for inspection.",
      },
      {
        key: "trustWorkspace",
        label: "Trust the run's workspace",
        type: "toggle",
        default: true,
        hint: "Answer Claude's first-run folder trust dialog for this run's workspace. Off means someone answers it in Orca.",
      },
      {
        key: "dangerouslySkipPermissions",
        label: "Skip permission prompts",
        type: "toggle",
        default: false,
        hint: "Dangerous: the agent runs every tool call without asking. Off means someone answers prompts in Orca.",
      },
      {
        key: "timeoutSec",
        label: "Timeout (seconds)",
        type: "number",
        default: 0,
        hint: "Interrupt the run after this many seconds. 0 means no limit.",
      },
    ],
  };
}
