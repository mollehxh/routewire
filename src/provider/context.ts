import { isRecord } from "./protocol.js";

export interface CodexEnvironmentContext {
  cwd?: string;
  shell?: string;
  currentDate?: string;
  timezone?: string;
  workspaceRoots: string[];
  permissionProfile?: string;
  fileSystem?: string;
}

export interface CodexProjectInstruction {
  scope: string;
  content: string;
}

export interface CodexOperationalContext {
  model: string;
  environment?: CodexEnvironmentContext;
  permissions?: string;
  projectInstructions: CodexProjectInstruction[];
}

export function extractCodexOperationalContext(
  body: unknown,
  expectedModel: string,
): CodexOperationalContext | undefined {
  if (!isRecord(body) || !Array.isArray(body.input)) return undefined;

  const model = typeof body.model === "string" ? body.model : expectedModel;
  let environment: CodexEnvironmentContext | undefined;
  let permissions: string | undefined;
  const projectInstructions: CodexProjectInstruction[] = [];

  for (const item of body.input) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    const role = typeof item.role === "string" ? item.role : undefined;
    for (const content of item.content) {
      if (!isRecord(content) || typeof content.text !== "string") continue;
      const text = content.text;

      if (role === "user" && text.includes("<environment_context>")) {
        environment = parseEnvironmentContext(text) ?? environment;
        continue;
      }

      const permissionText = role === "developer" ? extractPermissionInstructions(text) : undefined;
      if (permissionText !== undefined) {
        permissions = permissionText;
        continue;
      }

      const projectInstruction = role === "user" ? parseProjectInstruction(text) : undefined;
      if (projectInstruction) projectInstructions.push(projectInstruction);
    }
  }

  if (!environment && !permissions && projectInstructions.length === 0) return undefined;
  return { model, environment, permissions, projectInstructions };
}

function parseEnvironmentContext(text: string): CodexEnvironmentContext | undefined {
  const block = /<environment_context>([\s\S]*?)<\/environment_context>/.exec(text)?.[1];
  if (block === undefined) return undefined;

  const filesystem = /<filesystem>([\s\S]*?)<\/filesystem>/.exec(block)?.[1] ?? "";
  return {
    cwd: tagValue(block, "cwd"),
    shell: tagValue(block, "shell"),
    currentDate: tagValue(block, "current_date"),
    timezone: tagValue(block, "timezone"),
    workspaceRoots: [...filesystem.matchAll(/<root>([\s\S]*?)<\/root>/g)].map(match =>
      decodeXml(match[1].trim()),
    ),
    permissionProfile: /<permission_profile\s+type="([^"]+)"/.exec(filesystem)?.[1],
    fileSystem: /<file_system\s+type="([^"]+)"/.exec(filesystem)?.[1],
  };
}

function extractPermissionInstructions(text: string): string | undefined {
  return /<permissions instructions>\s*([\s\S]*?)\s*<\/permissions instructions>/.exec(text)?.[1].trim();
}

function parseProjectInstruction(text: string): CodexProjectInstruction | undefined {
  const match = /^# AGENTS\.md instructions for (.+?)\s*\n\s*<INSTRUCTIONS>\s*\n?([\s\S]*?)\n?\s*<\/INSTRUCTIONS>\s*$/i.exec(
    text.trim(),
  );
  if (!match) return undefined;
  return {
    scope: match[1].trim(),
    content: match[2].trimEnd(),
  };
}

function tagValue(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
  return match ? decodeXml(match[1].trim()) : undefined;
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
