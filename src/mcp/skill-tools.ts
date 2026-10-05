import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import spawn from "cross-spawn";
import { z, type ZodType } from "zod";

import type { CodexBridgeEvent, CodexTurnBridge } from "../bridge.js";
import type { BridgeCallResult } from "../provider/protocol.js";

export type NativeSkillTools =
  | {
      kind: "app-server";
      command: string;
      codexHome: string;
      cwd: string;
    }
  | {
      kind: "local";
      roots: string[];
    };

export interface CodexSkillSummary {
  name: string;
  description: string;
}

export interface SidebandSkillToolDefinition {
  name: "skills" | "get_skill";
  title: string;
  description: string;
  inputSchema: ZodType;
}

export interface SidebandSkillToolOptions {
  onEvent?: (event: CodexBridgeEvent) => void;
}

const skillsInputSchema = z.object({
  force_reload: z
    .boolean()
    .optional()
    .describe(
      "Reload Codex's native skill catalog instead of using its current cache. Use only when skills or plugins may have changed.",
    ),
});

const getSkillInputSchema = z.object({
  names: z
    .array(z.string().min(1))
    .min(1)
    .max(32)
    .describe("Exact enabled skill names returned by the skills tool."),
});

export const SIDEBAND_SKILL_TOOL_DEFINITIONS: SidebandSkillToolDefinition[] = [
  {
    name: "skills",
    title: "Codex skills",
    description:
      "List the enabled Codex skills for the current workspace using Codex's native skill catalog. Returns only the exact skill names and descriptions. Use for $skills and skill discovery; call again with force_reload only when skills or plugins may have changed.",
    inputSchema: skillsInputSchema,
  },
  {
    name: "get_skill",
    title: "Read Codex skill",
    description:
      "Read the complete canonical SKILL.md instructions for one or more exact enabled skill names returned by skills. Use before applying a relevant skill. This delegates resolution and reading to Codex's native skill mechanism; it does not accept filesystem paths or infer skill names.",
    inputSchema: getSkillInputSchema,
  },
];

let skillActivityCounter = 0;

export async function discoverNativeSkillTools(
  _bridge: CodexTurnBridge,
  options: { cwd: string; codexHome?: string; codexCommand?: string },
): Promise<NativeSkillTools | undefined> {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const appServer: NativeSkillTools = {
    kind: "app-server",
    command: options.codexCommand ?? "codex",
    codexHome,
    cwd: options.cwd,
  };
  try {
    await appServerSkillsList(appServer, false);
    return appServer;
  } catch {
    // Fall back to directly installed skills when Codex app-server is unavailable.
  }

  const candidateRoots = [
    join(options.cwd, ".codex", "skills"),
    join(options.cwd, ".agents", "skills"),
    join(homedir(), ".agents", "skills"),
    join(codexHome, "skills"),
  ];
  const localRoots: string[] = [];
  for (const root of candidateRoots) {
    if (await hasLocalSkills(root)) localRoots.push(root);
  }
  if (localRoots.length > 0) return { kind: "local", roots: localRoots };
  return undefined;
}

export async function invokeSidebandSkillTool(
  bridge: CodexTurnBridge,
  nativeTools: NativeSkillTools,
  name: "skills" | "get_skill",
  arguments_: unknown,
  options: SidebandSkillToolOptions = {},
): Promise<BridgeCallResult> {
  if (name === "skills") {
    return invokeSkills(bridge, nativeTools, skillsInputSchema.parse(arguments_));
  }

  const args = getSkillInputSchema.parse(arguments_);
  const startedAt = Date.now();
  const callId = `sideband-skill-${++skillActivityCounter}`;
  options.onEvent?.({
    type: "call_started",
    callId,
    namespace: "runwire",
    name: "get_skill",
    arguments: { names: [...new Set(args.names)] },
    startedAt,
  });

  try {
    const result = await invokeGetSkill(bridge, nativeTools, args);
    options.onEvent?.({
      type: "call_finished",
      callId,
      namespace: "runwire",
      name: "get_skill",
      isError: result.isError,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    options.onEvent?.({
      type: "call_finished",
      callId,
      namespace: "runwire",
      name: "get_skill",
      isError: true,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

async function invokeSkills(
  bridge: CodexTurnBridge,
  nativeTools: NativeSkillTools,
  args: z.infer<typeof skillsInputSchema>,
): Promise<BridgeCallResult> {
  const skills = await loadNativeSkillCatalog(bridge, nativeTools, args.force_reload === true);
  return textResult({ skills });
}

export async function loadNativeSkillCatalog(
  _bridge: CodexTurnBridge,
  nativeTools: NativeSkillTools,
  forceReload = false,
): Promise<CodexSkillSummary[]> {
  if (nativeTools.kind === "app-server") {
    return compactAppServerSkillCatalog(await appServerSkillsList(nativeTools, forceReload));
  }
  return loadLocalSkillCatalog(nativeTools.roots);
}

async function invokeGetSkill(
  _bridge: CodexTurnBridge,
  nativeTools: NativeSkillTools,
  args: z.infer<typeof getSkillInputSchema>,
): Promise<BridgeCallResult> {
  if (nativeTools.kind === "app-server") return invokeGetAppServerSkill(nativeTools, args);
  return invokeGetLocalSkill(nativeTools.roots, args);
}

interface AppServerSkillEntry extends LocalSkillEntry {
  enabled: boolean;
}

async function invokeGetAppServerSkill(
  tools: Extract<NativeSkillTools, { kind: "app-server" }>,
  args: z.infer<typeof getSkillInputSchema>,
): Promise<BridgeCallResult> {
  const catalog = await appServerSkillsList(tools, false);
  const entries = canonicalAppServerSkills(catalog);
  const results: Array<{ name: string; content: string }> = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const skillName of [...new Set(args.names)]) {
    const entry = entries.find(entry => entry.name === skillName);
    if (!entry) {
      errors.push({ name: skillName, error: `Enabled Codex skill not found: ${skillName}` });
      continue;
    }
    try {
      results.push({ name: skillName, content: await readFile(entry.path, "utf8") });
    } catch (error) {
      errors.push({
        name: skillName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify(errors.length > 0 ? { skills: results, errors } : { skills: results }),
    }],
    isError: errors.length > 0,
  };
}

async function appServerSkillsList(
  tools: Extract<NativeSkillTools, { kind: "app-server" }>,
  forceReload: boolean,
): Promise<unknown> {
  const child = spawn(tools.command, ["app-server", "--stdio"], {
    cwd: tools.cwd,
    env: { ...process.env, CODEX_HOME: tools.codexHome },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const stdin = child.stdin;
  const stdout = child.stdout;
  if (!stdin || !stdout) {
    child.kill();
    throw new Error("Could not open Codex app-server stdio");
  }

  stdout.setEncoding("utf8");
  let buffer = "";
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  stdout.on("data", chunk => {
    buffer += String(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(message) || typeof message.id !== "number") continue;
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error !== undefined) {
        request.reject(new Error(`Codex app-server request ${message.id} failed: ${JSON.stringify(message.error)}`));
      } else if (message.result === undefined) {
        request.reject(new Error(`Codex app-server response ${message.id} did not include result`));
      } else {
        request.resolve(message.result);
      }
    }
  });
  child.once("error", error => rejectPending(error));
  child.once("exit", (code, signal) => {
    if (pending.size > 0) {
      rejectPending(new Error(`Codex app-server exited before responding (code=${String(code)}, signal=${String(signal)})`));
    }
  });

  const request = (id: number, method: string, params?: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for Codex app-server response ${id}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    stdin.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`, error => {
      if (!error) return;
      const pendingRequest = pending.get(id);
      if (!pendingRequest) return;
      pending.delete(id);
      clearTimeout(pendingRequest.timer);
      reject(error);
    });
  });

  try {
    await request(1, "initialize", {
      clientInfo: { name: "sideband", title: "Runwire", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return await request(2, "skills/list", {
      cwds: [tools.cwd],
      forceReload,
    });
  } finally {
    stdin.end();
    child.kill();
  }
}

// Codex's catalog is ordered by scope/precedence. Resolve duplicates once,
// using the same first enabled entry for discovery and reading.
function canonicalAppServerSkills(catalog: unknown): AppServerSkillEntry[] {
  const byName = new Map<string, AppServerSkillEntry>();
  for (const entry of appServerSkillEntries(catalog)) {
    if (entry.enabled && !byName.has(entry.name)) byName.set(entry.name, entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function compactAppServerSkillCatalog(catalog: unknown): CodexSkillSummary[] {
  return canonicalAppServerSkills(catalog).map(({name, description}) => ({name, description}));
}

function appServerSkillEntries(catalog: unknown): AppServerSkillEntry[] {
  if (!isRecord(catalog) || !Array.isArray(catalog.data)) return [];
  const entries: AppServerSkillEntry[] = [];
  for (const cwdEntry of catalog.data) {
    if (!isRecord(cwdEntry) || !Array.isArray(cwdEntry.skills)) continue;
    for (const skill of cwdEntry.skills) {
      if (
        !isRecord(skill) ||
        typeof skill.name !== "string" ||
        typeof skill.description !== "string" ||
        typeof skill.path !== "string"
      ) continue;
      entries.push({
        name: skill.name,
        description: skill.description,
        path: skill.path,
        enabled: skill.enabled === true,
      });
    }
  }
  return entries;
}

interface LocalSkillEntry extends CodexSkillSummary {
  path: string;
}

async function invokeGetLocalSkill(
  roots: readonly string[],
  args: z.infer<typeof getSkillInputSchema>,
): Promise<BridgeCallResult> {
  const catalog = await loadLocalSkillEntries(roots);
  const byName = new Map(catalog.map(entry => [entry.name, entry]));
  const results: Array<{ name: string; content: string }> = [];
  const errors: Array<{ name: string; error: string }> = [];

  for (const skillName of [...new Set(args.names)]) {
    const entry = byName.get(skillName);
    if (!entry) {
      errors.push({ name: skillName, error: `Unknown Codex skill: ${skillName}` });
      continue;
    }
    try {
      results.push({ name: skillName, content: await readFile(entry.path, "utf8") });
    } catch (error) {
      errors.push({
        name: skillName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify(errors.length > 0 ? { skills: results, errors } : { skills: results }),
    }],
    isError: errors.length > 0,
  };
}

async function loadLocalSkillCatalog(roots: readonly string[]): Promise<CodexSkillSummary[]> {
  return (await loadLocalSkillEntries(roots)).map(({ name, description }) => ({ name, description }));
}

async function loadLocalSkillEntries(roots: readonly string[]): Promise<LocalSkillEntry[]> {
  const byName = new Map<string, LocalSkillEntry>();
  for (const root of roots) {
    for (const path of await findSkillFiles(root)) {
      const content = await readFile(path, "utf8");
      const metadata = parseSkillFrontmatter(content, basename(dirname(path)));
      if (!metadata.name || byName.has(metadata.name)) continue;
      byName.set(metadata.name, { ...metadata, path });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function hasLocalSkills(root: string): Promise<boolean> {
  try {
    await access(root);
    return (await findSkillFiles(root)).length > 0;
  } catch {
    return false;
  }
}

async function findSkillFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  await collectSkillFiles(root, 0, paths);
  return paths;
}

async function collectSkillFiles(directory: string, depth: number, paths: string[]): Promise<void> {
  if (depth > 2) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name === "SKILL.md") {
      paths.push(join(directory, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") && entry.name !== ".system") continue;
    await collectSkillFiles(join(directory, entry.name), depth + 1, paths);
  }
}

function parseSkillFrontmatter(content: string, fallbackName: string): CodexSkillSummary {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) return { name: fallbackName, description: "" };
  const block = match[1];
  return {
    name: frontmatterValue(block, "name") || fallbackName,
    description: frontmatterValue(block, "description"),
  };
}

function frontmatterValue(block: string, key: string): string {
  const lines = block.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(new RegExp(`^${key}:\\s*(.*)$`));
    if (!match) continue;
    const raw = (match[1] ?? "").trim();
    if (raw === "|" || raw === ">") {
      const chunks: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next] ?? "";
        if (candidate.length > 0 && !/^\s+/.test(candidate)) break;
        chunks.push(candidate.trim());
      }
      return raw === ">" ? chunks.filter(Boolean).join(" ") : chunks.join("\n").trim();
    }
    return unquoteYamlScalar(raw);
  }
  return "";
}

function unquoteYamlScalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function textResult(value: unknown): BridgeCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function skillToolJsonSchema(
  definition: SidebandSkillToolDefinition,
): Record<string, unknown> {
  const schema = z.toJSONSchema(definition.inputSchema) as Record<string, unknown>;
  const { $schema: _schema, ...withoutDialect } = schema;
  return withoutDialect;
}
