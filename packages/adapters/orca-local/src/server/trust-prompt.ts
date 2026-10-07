/**
 * Claude Code asks "Is this a project you created or one you trust?" the first
 * time it opens a folder interactively, with the cursor on "No, exit". Status
 * hooks do not fire before a session starts, so an unanswered dialog would
 * stall the run until the startup timeout. claude_local never meets this
 * dialog because print mode skips it.
 *
 * The adapter answers only this dialog, only for the run's own workspace, and
 * only after confirming the cursor sits on the "trust" option.
 */

const TRUST_OPTION = "Yes, I trust this folder";
const TRUST_MARKERS = ["Accessing workspace:", TRUST_OPTION];
const SELECTED_PREFIX = "❯";

export const ARROW_DOWN = "\u001b[B";
export const ENTER = "\r";

/** Screen lines wrap at the terminal width; join them so a long path is matched whole. */
function joinWrapped(screen: string[]): string {
  return screen.map((line) => line.trim()).join("");
}

export function isClaudeTrustPrompt(screen: string[], cwdCandidates: string[]): boolean {
  const text = screen.join("\n");
  if (!TRUST_MARKERS.every((marker) => text.includes(marker))) return false;
  const joined = joinWrapped(screen);
  return cwdCandidates.some((cwd) => cwd.length > 0 && joined.includes(cwd));
}

export function isTrustOptionSelected(screen: string[]): boolean {
  return screen.some((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith(SELECTED_PREFIX) && trimmed.includes(TRUST_OPTION);
  });
}
