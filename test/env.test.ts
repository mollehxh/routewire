import { afterEach, describe, expect, it } from "vitest";

import { runwireEnv, runwireEnvFlag } from "../src/env.js";

const keys = [
  "RUNWIRE_TEST_VALUE",
  "SIDEBAND_TEST_VALUE",
  "RUNWIRE_TEST_FLAG",
  "SIDEBAND_TEST_FLAG",
] as const;
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Runwire environment compatibility", () => {
  it("prefers the Runwire variable over the legacy Sideband variable", () => {
    process.env.RUNWIRE_TEST_VALUE = "current";
    process.env.SIDEBAND_TEST_VALUE = "legacy";

    expect(runwireEnv("RUNWIRE_TEST_VALUE", "SIDEBAND_TEST_VALUE")).toBe("current");
  });

  it("falls back to the legacy Sideband variable when the Runwire variable is unset", () => {
    delete process.env.RUNWIRE_TEST_VALUE;
    process.env.SIDEBAND_TEST_VALUE = "legacy";

    expect(runwireEnv("RUNWIRE_TEST_VALUE", "SIDEBAND_TEST_VALUE")).toBe("legacy");
  });

  it("supports boolean migration flags with the same precedence", () => {
    delete process.env.RUNWIRE_TEST_FLAG;
    process.env.SIDEBAND_TEST_FLAG = "1";
    expect(runwireEnvFlag("RUNWIRE_TEST_FLAG", "SIDEBAND_TEST_FLAG")).toBe(true);

    process.env.RUNWIRE_TEST_FLAG = "0";
    expect(runwireEnvFlag("RUNWIRE_TEST_FLAG", "SIDEBAND_TEST_FLAG")).toBe(false);
  });
});
