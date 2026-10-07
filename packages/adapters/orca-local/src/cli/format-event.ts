import pc from "picocolors";
import { parseOrcaLocalStdoutLine } from "../ui/parse-stdout.js";

export function printOrcaLocalEvent(raw: string, debug: boolean): void {
  const entries = parseOrcaLocalStdoutLine(raw, new Date().toISOString());
  for (const entry of entries) {
    switch (entry.kind) {
      case "init":
        console.log(pc.blue(`Orca init (${entry.model}, session ${entry.sessionId})`));
        break;
      case "system":
        console.log(pc.blue(entry.text));
        break;
      case "assistant":
        console.log(pc.green(`assistant: ${entry.text}`));
        break;
      case "tool_call":
        console.log(pc.yellow(`tool_call: ${entry.name}`));
        break;
      case "tool_result":
        if (debug || entry.isError) console.log((entry.isError ? pc.red : pc.cyan)(entry.content || "tool result"));
        break;
      case "result":
        console.log((entry.isError ? pc.red : pc.blue)(`result: ${entry.subtype}${entry.text ? ` - ${entry.text}` : ""}`));
        break;
      case "stdout":
        console.log(entry.text);
        break;
      default:
        if (debug) console.log(pc.gray(JSON.stringify(entry)));
    }
  }
}
