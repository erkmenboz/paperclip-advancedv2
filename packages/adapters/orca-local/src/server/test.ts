import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { ensureCommandResolvable, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { ORCA_PROVIDERS } from "../index.js";
import { parseOrcaLocalConfig } from "./config.js";
import { OrcaCli, OrcaCliError } from "./orca-cli.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function describeError(err: unknown): string {
  if (err instanceof OrcaCliError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
  deps: { cli?: OrcaCli } = {},
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseOrcaLocalConfig(parseObject(ctx.config));
  const result = () => ({
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  });

  if (!config.provider) {
    checks.push({
      code: "orca_provider_invalid",
      level: "error",
      message: config.rawProvider
        ? `Provider "${config.rawProvider}" is not supported by orca_local.`
        : "provider is required.",
      hint: `Choose one of: ${ORCA_PROVIDERS.map((provider) => provider.id).join(", ")}.`,
    });
  }

  const cli = deps.cli ?? new OrcaCli({ command: config.orcaCommand });
  try {
    const status = await cli.status();
    if (!status.reachable) {
      checks.push({
        code: "orca_runtime_unreachable",
        level: "error",
        message: `Orca is installed but its runtime is not reachable (state: ${status.state ?? "unknown"}).`,
        hint: "Open the Orca app, or run `orca open`, on the Paperclip host.",
      });
      return result();
    }
    checks.push({
      code: "orca_runtime_ready",
      level: "info",
      message: `Orca runtime is reachable${status.appVersion ? ` (Orca ${status.appVersion})` : ""}.`,
    });
  } catch (err) {
    checks.push({
      code: err instanceof OrcaCliError && err.code === "orca_not_found" ? "orca_cli_missing" : "orca_status_failed",
      level: "error",
      message: `Could not query Orca: ${describeError(err)}`,
      hint: "Install Orca and make sure its CLI is on PATH, or set orcaCommand to its absolute path.",
    });
    return result();
  }

  if (config.provider && config.mode === "interactive") {
    const providerLabel = ORCA_PROVIDERS.find((provider) => provider.id === config.provider)?.label ?? config.provider;
    try {
      const hooks = await cli.hooksStatus();
      const entry = hooks.providers.find((provider) => provider.agent === config.provider);
      if (!hooks.enabled || !entry?.managedHooksPresent) {
        checks.push({
          code: "orca_provider_hooks_missing",
          level: "error",
          message: `Orca status hooks are not active for ${providerLabel}, so the adapter cannot tell when a turn finishes.`,
          hint: "Run `orca agent hooks on` on the Paperclip host.",
        });
      } else {
        checks.push({ code: "orca_provider_hooks_ready", level: "info", message: `Orca status hooks are active for ${providerLabel}.` });
      }
    } catch (err) {
      checks.push({
        code: "orca_hooks_status_failed",
        level: "warn",
        message: `Could not read Orca hook status: ${describeError(err)}`,
      });
    }
  }

  if (config.provider) {
    try {
      await ensureCommandResolvable(config.providerCommand, process.cwd(), process.env);
      checks.push({
        code: "orca_provider_command_found",
        level: "info",
        message: `Provider command "${config.providerCommand}" is on the Paperclip server's PATH.`,
      });
    } catch {
      checks.push({
        code: "orca_provider_command_unresolved",
        level: "warn",
        message: `Provider command "${config.providerCommand}" is not on the Paperclip server's PATH.`,
        detail: "The provider runs in an Orca terminal's login shell, whose PATH may differ.",
        hint: "Set providerCommand to an absolute path if the run cannot start it.",
      });
    }
  }

  if (config.orcaWorkspace) {
    try {
      const worktree = await cli.findWorktree(config.orcaWorkspace);
      checks.push(
        worktree
          ? { code: "orca_workspace_found", level: "info", message: `Orca workspace resolves to ${worktree.path}.` }
          : {
              code: "orca_workspace_not_found",
              level: "error",
              message: `Orca does not know the workspace "${config.orcaWorkspace}".`,
              hint: "Use an exact worktree root such as path:/abs/repo, or add the repository with `orca repo add --path <repo>`.",
            },
      );
    } catch (err) {
      checks.push({
        code: "orca_workspace_check_failed",
        level: "warn",
        message: `Could not resolve the Orca workspace: ${describeError(err)}`,
      });
    }
  } else {
    checks.push({
      code: "orca_workspace_from_run",
      level: "info",
      message: "Each run opens its terminal in the Orca worktree that contains the run's workspace.",
      hint: "Set orcaWorkspace when the workspace is not an Orca worktree (for example, agent-home runs).",
    });
  }

  return result();
}
