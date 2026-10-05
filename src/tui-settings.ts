import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "never";
export type SubagentModel = string;

export interface RunwireSettings {
  tunnelEnabled: boolean;
  tunnelId: string;
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  fastMode: boolean;
  allowedSubagentModels: SubagentModel[];
}

export const DEFAULT_RUNWIRE_SETTINGS: RunwireSettings = {
  tunnelEnabled: false,
  tunnelId: "",
  sandboxMode: "workspace-write",
  approvalPolicy: "never",
  fastMode: true,
  allowedSubagentModels: ["gpt-6-luna"],
};

export function loadRunwireSettings(): RunwireSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Partial<RunwireSettings>;
    const allowedSubagentModels = Array.isArray(parsed.allowedSubagentModels)
      ? parsed.allowedSubagentModels.filter(value => typeof value === "string" && value.length > 0)
      : ["gpt-6-luna"];
    return {
      tunnelEnabled: parsed.tunnelEnabled === true,
      tunnelId: typeof parsed.tunnelId === "string" ? parsed.tunnelId : "",
      sandboxMode:
        parsed.sandboxMode === "read-only" ||
        parsed.sandboxMode === "workspace-write" ||
        parsed.sandboxMode === "danger-full-access"
          ? parsed.sandboxMode
          : "workspace-write",
      approvalPolicy: "never",
      fastMode: parsed.fastMode !== false,
      allowedSubagentModels,
    };
  } catch {
    return structuredClone(DEFAULT_RUNWIRE_SETTINGS);
  }
}

export function saveRunwireSettings(settings: RunwireSettings): void {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export function hasStoredApiKey(): boolean {
  try {
    return fs.readFileSync(apiKeyPath(), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

export function saveApiKey(value: string): void {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("API key cannot be empty");
  const file = apiKeyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${trimmed}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows does not implement POSIX file modes; the write still succeeds.
  }
}

export function settingsPath(): string {
  return path.join(configDir(), "settings.json");
}

export function apiKeyPath(): string {
  return path.join(configDir(), "credentials", "control-plane-api-key");
}

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "runwire");
}
