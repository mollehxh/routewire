import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { RUNWIRE_NAME, RUNWIRE_VERSION } from "../src/meta.js";

describe("Runwire package metadata", () => {
  it("keeps runtime identity in sync with package.json", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name?: string; version?: string };

    expect(RUNWIRE_NAME).toBe(packageJson.name);
    expect(RUNWIRE_VERSION).toBe(packageJson.version);
  });
});
