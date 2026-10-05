export function runwireEnv(name: string, legacyName?: string): string | undefined {
  return process.env[name] ?? (legacyName ? process.env[legacyName] : undefined);
}

export function runwireEnvFlag(name: string, legacyName?: string): boolean {
  return runwireEnv(name, legacyName) === "1";
}
