import { buildAdapterEnvConfig, type CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildOrcaLocalConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {
    provider: "claude",
    terminalRetention: "keep",
    ...(values.adapterSchemaValues ?? {}),
  };
  if (values.cwd) config.cwd = values.cwd;
  if (values.instructionsFilePath) config.instructionsFilePath = values.instructionsFilePath;
  if (values.promptTemplate) config.promptTemplate = values.promptTemplate;
  if (values.bootstrapPrompt) config.bootstrapPromptTemplate = values.bootstrapPrompt;
  if (values.model?.trim()) config.model = values.model.trim();
  if (values.thinkingEffort?.trim()) config.effort = values.thinkingEffort.trim();

  const env = buildAdapterEnvConfig(values.envBindings, values.envVars);
  if (Object.keys(env).length > 0) config.env = env;
  return config;
}
