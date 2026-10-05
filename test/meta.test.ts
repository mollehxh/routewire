import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ROUTEWIRE_NAME, ROUTEWIRE_VERSION } from "../src/meta.js";

describe("Routewire package metadata", () => {
  it("keeps runtime identity in sync with package.json", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name?: string; version?: string };

    expect(ROUTEWIRE_NAME).toBe(packageJson.name);
    expect(ROUTEWIRE_VERSION).toBe(packageJson.version);
  });
});
