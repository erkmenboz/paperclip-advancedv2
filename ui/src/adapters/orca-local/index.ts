import type { UIAdapterModule } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";
import {
  buildOrcaLocalConfig,
  parseOrcaLocalStdoutLine,
} from "@paperclipai/adapter-orca-local/ui";

export const orcaLocalUIAdapter: UIAdapterModule = {
  type: "orca_local",
  label: "Orca",
  parseStdoutLine: parseOrcaLocalStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildOrcaLocalConfig,
};
