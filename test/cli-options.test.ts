import { describe, expect, it } from "vitest";

import { parseCliOptions } from "../src/cli-options.js";

describe("parseCliOptions", () => {
  it("defaults to GPT-5.6 Sol on loopback without weakening Codex permissions", () => {
    expect(parseCliOptions([])).toEqual({
      host: "127.0.0.1",
      port: 0,
      model: "gpt-5.6-sol",
      dangerFullAccess: false,
    });
  });

  it("accepts explicit bind/model/full-access overrides", () => {
    expect(
      parseCliOptions([
        "--host",
        "127.0.0.1",
        "--port",
        "4321",
        "--model",
        "gpt-5.6-sol",
        "--danger-full-access",
      ]),
    ).toEqual({
      host: "127.0.0.1",
      port: 4321,
      model: "gpt-5.6-sol",
      dangerFullAccess: true,
    });
  });

  it("rejects unknown options instead of silently changing startup behavior", () => {
    expect(() => parseCliOptions(["--wat"])).toThrow(/unknown option/i);
  });
});
