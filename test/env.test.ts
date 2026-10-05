import { afterEach, describe, expect, it } from "vitest";

import { routewireEnv, routewireEnvFlag } from "../src/env.js";

const keys = [
  "ROUTEWIRE_TEST_VALUE",
  "SIDEBAND_TEST_VALUE",
  "ROUTEWIRE_TEST_FLAG",
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

describe("Routewire environment compatibility", () => {
  it("prefers the Routewire variable over the legacy Sideband variable", () => {
    process.env.ROUTEWIRE_TEST_VALUE = "current";
    process.env.SIDEBAND_TEST_VALUE = "legacy";

    expect(routewireEnv("ROUTEWIRE_TEST_VALUE", "SIDEBAND_TEST_VALUE")).toBe("current");
  });

  it("falls back to the legacy Sideband variable when the Routewire variable is unset", () => {
    delete process.env.ROUTEWIRE_TEST_VALUE;
    process.env.SIDEBAND_TEST_VALUE = "legacy";

    expect(routewireEnv("ROUTEWIRE_TEST_VALUE", "SIDEBAND_TEST_VALUE")).toBe("legacy");
  });

  it("supports boolean migration flags with the same precedence", () => {
    delete process.env.ROUTEWIRE_TEST_FLAG;
    process.env.SIDEBAND_TEST_FLAG = "1";
    expect(routewireEnvFlag("ROUTEWIRE_TEST_FLAG", "SIDEBAND_TEST_FLAG")).toBe(true);

    process.env.ROUTEWIRE_TEST_FLAG = "0";
    expect(routewireEnvFlag("ROUTEWIRE_TEST_FLAG", "SIDEBAND_TEST_FLAG")).toBe(false);
  });
});
