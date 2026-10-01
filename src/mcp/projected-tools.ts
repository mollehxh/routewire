import { z, type ZodType } from "zod";

import type { CodexTurnBridge } from "../bridge.js";
import {
  cleanCodeModeResult,
  type BridgeCallResult,
} from "../provider/protocol.js";
import { wrapExecCode } from "../tool-policy.js";

export interface NativeToolMetadata {
  name: string;
  description: string;
}

export interface ProjectedNativeTool {
  name: string;
  title: string;
  nativeName: string;
  description: string;
  inputSchema: ZodType;
  mapArguments(arguments_: unknown): unknown;
}

const execCommandSchema = z.object({
  cmd: z.string().min(1).describe("Shell command to execute."),
  justification: z.string().optional(),
  login: z.boolean().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  prefix_rule: z.array(z.string()).optional(),
  sandbox_permissions: z.enum(["use_default", "require_escalated"]).optional(),
  shell: z.string().optional(),
  tty: z.boolean().optional(),
  workdir: z.string().optional(),
  yield_time_ms: z.number().int().min(250).max(30_000).optional(),
});

const writeStdinSchema = z.object({
  chars: z.string().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  session_id: z.number().int(),
  yield_time_ms: z.number().int().min(0).max(300_000).optional(),
});

const applyPatchSchema = z.object({
  patch: z.string().min(1).describe("Patch text in the Codex apply_patch grammar."),
});

const viewImageSchema = z.object({
  detail: z.enum(["high", "original"]).optional(),
  path: z.string().min(1),
});

const replSchema = z.object({
  code: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
  title: z.string().optional(),
});

const addNodeModuleDirSchema = z.object({ path: z.string().min(1) });
const emptySchema = z.object({});

interface ProjectionDefinition {
  name: string;
  title: string;
  inputSchema: ZodType;
  resolveNativeName(inventory: NativeToolMetadata[]): string | undefined;
  exposeNativeName?: boolean;
  adaptDescription?(description: string): string;
  mapArguments?(arguments_: unknown): unknown;
}

const DEFINITIONS: ProjectionDefinition[] = [
  exact("exec_command", "Codex exec command", execCommandSchema),
  exact("write_stdin", "Codex write stdin", writeStdinSchema),
  {
    ...exact("apply_patch", "Codex apply patch", applyPatchSchema),
    adaptDescription: () =>
      "Edit files using the Codex apply_patch grammar. Pass the complete patch text in the `patch` argument.",
    mapArguments: arguments_ => applyPatchSchema.parse(arguments_).patch,
  },
  exact("view_image", "Codex view image", viewImageSchema),
  exact("mcp__node_repl__js", "Codex Node REPL", replSchema),
  exact("mcp__node_repl__js_reset", "Reset Codex Node REPL", emptySchema),
  exact(
    "mcp__node_repl__js_add_node_module_dir",
    "Add Node module directory",
    addNodeModuleDirSchema,
  ),
  suffix("cua_repl", "Codex Computer Use REPL", replSchema, "cua_repl__js", true),
  suffix("cua_repl_reset", "Reset Codex Computer Use REPL", emptySchema, "cua_repl__js_reset", true),
  suffix(
    "cua_repl_add_node_module_dir",
    "Add Computer Use Node module directory",
    addNodeModuleDirSchema,
    "cua_repl__js_add_node_module_dir",
    true,
  ),
];

function exact(
  name: string,
  title: string,
  inputSchema: ZodType,
  nativeName = name,
): ProjectionDefinition {
  return {
    name,
    title,
    inputSchema,
    resolveNativeName: inventory =>
      inventory.some(tool => tool.name === nativeName) ? nativeName : undefined,
  };
}

function suffix(
  name: string,
  title: string,
  inputSchema: ZodType,
  nativeSuffix: string,
  exposeNativeName = false,
): ProjectionDefinition {
  return {
    name,
    title,
    inputSchema,
    exposeNativeName,
    resolveNativeName: inventory => chooseNativeBySuffix(inventory, nativeSuffix),
  };
}

function chooseNativeBySuffix(
  inventory: NativeToolMetadata[],
  suffix_: string,
): string | undefined {
  const candidates = inventory
    .map(tool => tool.name)
    .filter(name => name.endsWith(suffix_))
    .filter(name => !/test_harnes/i.test(name))
    .sort((a, b) => nativePreference(a) - nativePreference(b) || a.length - b.length || a.localeCompare(b));
  return candidates[0];
}

function nativePreference(name: string): number {
  if (/^mcp__cua_repl__/i.test(name)) return 0;
  if (/__fkn_codex_mcp__/i.test(name)) return 1;
  if (!/__codex_apps__/i.test(name)) return 2;
  return 3;
}

export function selectProjectedNativeTools(
  inventory: NativeToolMetadata[],
): ProjectedNativeTool[] {
  const byName = new Map(inventory.map(tool => [tool.name, tool]));
  return DEFINITIONS.flatMap(definition => {
    const nativeName = definition.resolveNativeName(inventory);
    if (!nativeName) return [];
    const native = byName.get(nativeName);
    if (!native) return [];

    return [{
      name: definition.exposeNativeName ? nativeName : definition.name,
      title: definition.title,
      nativeName,
      description:
        definition.adaptDescription?.(stripExecToolDeclaration(native.description)) ??
        stripExecToolDeclaration(native.description),
      inputSchema: definition.inputSchema,
      mapArguments: definition.mapArguments ?? (arguments_ => definition.inputSchema.parse(arguments_)),
    }];
  });
}

const INVENTORY_START = "__SIDEBAND_NATIVE_INVENTORY_START__";
const INVENTORY_END = "__SIDEBAND_NATIVE_INVENTORY_END__";
const PROJECTED_ERROR_MARKER = "__SIDEBAND_PROJECTED_NATIVE_ERROR__";

export async function discoverProjectedNativeTools(
  bridge: CodexTurnBridge,
): Promise<ProjectedNativeTool[]> {
  let inventory = await discoverCandidateInventory(bridge);
  let projected = selectProjectedNativeTools(inventory);

  // Some MCP/plugin tools are attached after the first provider/tool cycle.
  // One targeted refresh lets those late-bound canonical tools (notably CUA)
  // join the ChatGPT-facing surface without serializing the full ALL_TOOLS list.
  if (!projected.some(tool => /cua_repl__js$/i.test(tool.nativeName))) {
    inventory = mergeInventory(inventory, await discoverCandidateInventory(bridge));
    projected = selectProjectedNativeTools(inventory);
  }

  return projected;
}

async function discoverCandidateInventory(
  bridge: CodexTurnBridge,
): Promise<NativeToolMetadata[]> {
  const code = `
const __sidebandExactNames = new Set(${JSON.stringify([
    "exec_command",
    "write_stdin",
    "apply_patch",
    "view_image",
    "mcp__node_repl__js",
    "mcp__node_repl__js_reset",
    "mcp__node_repl__js_add_node_module_dir",
  ])});
const __sidebandInventory = ALL_TOOLS
  .filter(tool => {
    const name = String(tool?.name ?? "");
    return __sidebandExactNames.has(name) || /cua_repl__(?:js|js_reset|js_add_node_module_dir)$/i.test(name);
  })
  .map(tool => ({
  name: String(tool?.name ?? ""),
  description: String(tool?.description ?? ""),
}));
text(${JSON.stringify(INVENTORY_START)} + JSON.stringify(__sidebandInventory) + ${JSON.stringify(INVENTORY_END)});
`;
  const result = await bridge.invokeExec(wrapExecCode(code));
  return parseInventory(result);
}

function mergeInventory(
  first: NativeToolMetadata[],
  second: NativeToolMetadata[],
): NativeToolMetadata[] {
  const merged = new Map<string, NativeToolMetadata>();
  for (const tool of [...first, ...second]) merged.set(tool.name, tool);
  return [...merged.values()];
}

function parseInventory(result: BridgeCallResult): NativeToolMetadata[] {
  const text = result.content
    .filter(item => item.type === "text")
    .map(item => item.text)
    .join("\n");
  const start = text.indexOf(INVENTORY_START);
  const end = text.indexOf(INVENTORY_END, start + INVENTORY_START.length);
  if (start < 0 || end < 0) {
    throw new Error("Codex native tool discovery did not return the expected inventory marker");
  }
  const raw = text.slice(start + INVENTORY_START.length, end);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Codex native tool inventory was not an array");
  return parsed.flatMap(item => {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).name === "string" &&
      typeof (item as Record<string, unknown>).description === "string"
    ) {
      return [{
        name: (item as Record<string, string>).name,
        description: (item as Record<string, string>).description,
      }];
    }
    return [];
  });
}

export async function invokeProjectedNativeTool(
  bridge: CodexTurnBridge,
  tool: ProjectedNativeTool,
  arguments_: unknown,
): Promise<BridgeCallResult> {
  const nativeArguments = tool.mapArguments(arguments_);
  const invocation = `tools[${JSON.stringify(tool.nativeName)}](${JSON.stringify(nativeArguments)})`;

  const code = `
const __sidebandNativeResult = await ${invocation};
if (
  __sidebandNativeResult &&
  typeof __sidebandNativeResult === "object" &&
  Array.isArray(__sidebandNativeResult.content)
) {
  for (const __sidebandItem of __sidebandNativeResult.content) {
    if (__sidebandItem?.type === "text" && typeof __sidebandItem.text === "string") {
      text(__sidebandItem.text);
    } else if (__sidebandItem?.type === "image") {
      image(__sidebandItem);
    } else {
      text(__sidebandItem);
    }
  }
  if (__sidebandNativeResult.isError === true) {
    text(${JSON.stringify(PROJECTED_ERROR_MARKER)});
  }
} else if (
  __sidebandNativeResult &&
  typeof __sidebandNativeResult === "object" &&
  typeof __sidebandNativeResult.image_url === "string"
) {
  image(__sidebandNativeResult.image_url, __sidebandNativeResult.detail ?? "high");
} else {
  text(__sidebandNativeResult);
}
`;
  return cleanProjectedNativeResult(
    await bridge.invokeExec(wrapExecCode(code)),
    tool,
  );
}

function cleanProjectedNativeResult(
  result: BridgeCallResult,
  tool: ProjectedNativeTool,
): BridgeCallResult {
  result = cleanCodeModeResult(result);
  let nativeError = false;
  const content = result.content.filter(item => {
    if (item.type !== "text") return true;
    const text = item.text.trim();
    if (text === PROJECTED_ERROR_MARKER) {
      nativeError = true;
      return false;
    }
    if (/^Wall time: [0-9.]+ seconds\nOutput:$/.test(text)) return false;
    if (
      /^Script error:\nError: Projected Codex native tool reported an error(?:\n\s+at .*)*$/s.test(text)
    ) {
      nativeError = true;
      return false;
    }
    return true;
  });

  const isError = result.isError || nativeError;
  if (
    !isError &&
    tool.nativeName === "apply_patch" &&
    content.length === 1 &&
    content[0].type === "text" &&
    content[0].text.trim() === "{}"
  ) {
    return {
      content: [{ type: "text", text: "Patch applied." }],
      isError: false,
    };
  }

  return { content, isError };
}

function stripExecToolDeclaration(description: string): string {
  return description
    .replace(/\n\nexec tool declaration:\n```ts[\s\S]*?```\s*$/i, "")
    .trimEnd();
}

export function projectedToolJsonSchema(tool: ProjectedNativeTool): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
  const { $schema: _schema, ...withoutDialect } = schema;
  return withoutDialect;
}
