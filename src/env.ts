export function routewireEnv(name: string, legacyName?: string): string | undefined {
  return process.env[name] ?? (legacyName ? process.env[legacyName] : undefined);
}

export function routewireEnvFlag(name: string, legacyName?: string): boolean {
  return routewireEnv(name, legacyName) === "1";
}
