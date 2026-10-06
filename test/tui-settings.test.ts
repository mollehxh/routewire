import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_ROUTEWIRE_SETTINGS,
  apiKeyPath,
  hasStoredApiKey,
  loadRoutewireSettings,
  saveApiKey,
  saveRoutewireSettings,
  storedApiKeyPath,
  settingsPath,
} from "../src/tui-settings.js";

const originalXdg = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

describe("Routewire settings", () => {
  it.each([false, true])("removes legacy tunnelEnabled=%s while preserving connection settings", enabled => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "routewire-tunnel-migration-"));
    process.env.XDG_CONFIG_HOME = root;
    saveApiKey("existing-key");
    fs.writeFileSync(settingsPath(), JSON.stringify({
      ...DEFAULT_ROUTEWIRE_SETTINGS,
      tunnelEnabled: enabled,
      tunnelId: "tunnel_existing",
      sandboxMode: "read-only",
    }));

    const settings = loadRoutewireSettings();
    expect(settings).toMatchObject({tunnelId: "tunnel_existing", sandboxMode: "read-only"});
    expect(settings).not.toHaveProperty("tunnelEnabled");
    expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8"))).toEqual(settings);
    expect(fs.readFileSync(apiKeyPath(), "utf8").trim()).toBe("existing-key");
  });

  it("persists product settings and an allowlist of subagent models", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "routewire-settings-"));
    process.env.XDG_CONFIG_HOME = root;
    saveRoutewireSettings({
      ...DEFAULT_ROUTEWIRE_SETTINGS,
      tunnelId: "tunnel_test",
      sandboxMode: "read-only",
      fastMode: false,
      allowedSubagentModels: ["gpt-6-luna", "gpt-5.6-terra"],
    });

    expect(settingsPath()).toBe(path.join(root, "routewire", "settings.json"));
    expect(loadRoutewireSettings()).toMatchObject({
      tunnelId: "tunnel_test",
      sandboxMode: "read-only",
      fastMode: false,
      allowedSubagentModels: ["gpt-6-luna", "gpt-5.6-terra"],
    });
  });

  it("stores the tunnel API key outside the main settings file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "routewire-key-"));
    process.env.XDG_CONFIG_HOME = root;
    saveApiKey("secret-value");

    expect(hasStoredApiKey()).toBe(true);
    expect(fs.readFileSync(apiKeyPath(), "utf8").trim()).toBe("secret-value");
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it("reads settings and credentials from the previous Runwire config directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "routewire-legacy-config-"));
    process.env.XDG_CONFIG_HOME = root;
    const legacyDir = path.join(root, "runwire");
    const legacyKey = path.join(legacyDir, "credentials", "control-plane-api-key");
    fs.mkdirSync(path.dirname(legacyKey), {recursive: true});
    fs.writeFileSync(path.join(legacyDir, "settings.json"), JSON.stringify({
      ...DEFAULT_ROUTEWIRE_SETTINGS,
      tunnelId: "tunnel_legacy",
    }));
    fs.writeFileSync(legacyKey, "legacy-secret\n");

    expect(loadRoutewireSettings()).toMatchObject({tunnelId: "tunnel_legacy"});
    expect(hasStoredApiKey()).toBe(true);
    expect(storedApiKeyPath()).toBe(legacyKey);
    expect(settingsPath()).toBe(path.join(root, "routewire", "settings.json"));
  });

  it("normalizes legacy approval settings to never", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "routewire-settings-"));
    process.env.XDG_CONFIG_HOME = root;
    const file = settingsPath();
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({
      ...DEFAULT_ROUTEWIRE_SETTINGS,
      approvalPolicy: "on-request",
    }));

    expect(loadRoutewireSettings().approvalPolicy).toBe("never");
  });
});
