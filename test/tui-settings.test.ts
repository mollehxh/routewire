import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_RUNWIRE_SETTINGS,
  apiKeyPath,
  hasStoredApiKey,
  loadRunwireSettings,
  saveApiKey,
  saveRunwireSettings,
  settingsPath,
} from "../src/tui-settings.js";

const originalXdg = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

describe("Runwire settings", () => {
  it("persists product settings and an allowlist of subagent models", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runwire-settings-"));
    process.env.XDG_CONFIG_HOME = root;
    saveRunwireSettings({
      ...DEFAULT_RUNWIRE_SETTINGS,
      tunnelEnabled: true,
      tunnelId: "tunnel_test",
      sandboxMode: "read-only",
      fastMode: false,
      allowedSubagentModels: ["gpt-6-luna", "gpt-5.6-terra"],
    });

    expect(settingsPath()).toBe(path.join(root, "runwire", "settings.json"));
    expect(loadRunwireSettings()).toMatchObject({
      tunnelEnabled: true,
      tunnelId: "tunnel_test",
      sandboxMode: "read-only",
      fastMode: false,
      allowedSubagentModels: ["gpt-6-luna", "gpt-5.6-terra"],
    });
  });

  it("stores the tunnel API key outside the main settings file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runwire-key-"));
    process.env.XDG_CONFIG_HOME = root;
    saveApiKey("secret-value");

    expect(hasStoredApiKey()).toBe(true);
    expect(fs.readFileSync(apiKeyPath(), "utf8").trim()).toBe("secret-value");
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it("normalizes legacy approval settings to never", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runwire-settings-"));
    process.env.XDG_CONFIG_HOME = root;
    const file = settingsPath();
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({
      ...DEFAULT_RUNWIRE_SETTINGS,
      approvalPolicy: "on-request",
    }));

    expect(loadRunwireSettings().approvalPolicy).toBe("never");
  });
});
