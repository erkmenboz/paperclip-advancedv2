import { describe, expect, it } from "vitest";
import { isClaudeTrustPrompt, isTrustOptionSelected } from "./trust-prompt.js";

const WORKSPACE = "/Users/me/.paperclip/instances/default/workspaces/3c8a3d5b-1d0c-4d16-b4da-1e88bdeac2d0";

/** Shape of a real Orca screen capture; the path wraps at the terminal width. */
function trustScreen(selected: "no" | "yes", workspace = WORKSPACE): string[] {
  return [
    "────────────────────────────────────────",
    " Accessing workspace:",
    ` ${workspace.slice(0, 40)}`,
    ` ${workspace.slice(40)}`,
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
    " project, or work from your team). If not, take a moment to review what's in this folder first.",
    " Claude Code'll be able to read, edit, and execute files here.",
    " Security guide",
    selected === "no" ? " ❯ No, exit" : "   No, exit",
    selected === "yes" ? " ❯ Yes, I trust this folder" : "   Yes, I trust this folder",
    " Enter to confirm · Esc to cancel",
  ];
}

describe("Claude trust prompt detection", () => {
  it("matches the dialog for the run's own workspace even when the path wraps", () => {
    expect(isClaudeTrustPrompt(trustScreen("no"), [WORKSPACE])).toBe(true);
  });

  it("refuses a dialog for any other folder", () => {
    expect(isClaudeTrustPrompt(trustScreen("no", "/Users/me/somewhere-else"), [WORKSPACE])).toBe(false);
  });

  it("ignores screens that are not the trust dialog", () => {
    expect(isClaudeTrustPrompt([" ❯ Try \"fix typecheck errors\"", WORKSPACE], [WORKSPACE])).toBe(false);
  });

  it("knows which option the cursor is on", () => {
    expect(isTrustOptionSelected(trustScreen("no"))).toBe(false);
    expect(isTrustOptionSelected(trustScreen("yes"))).toBe(true);
  });
});
