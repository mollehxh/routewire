import {z} from "zod";
import type {ExecToolSpec} from "../provider/protocol.js";
import {compactExecDescription, SIDEBAND_EXEC_GUIDANCE} from "../tool-policy.js";

export function execToolDefinition(spec: ExecToolSpec) {
  return {
    name: "exec",
    title: "Codex exec",
    description: `${compactExecDescription(spec.description)}\n\n${SIDEBAND_EXEC_GUIDANCE}`,
    inputSchema: z.object({code: z.string().min(1).describe(
      "Raw JavaScript source for Codex functions.exec. Do not wrap it in JSON or markdown fences.",
    )}),
  };
}
