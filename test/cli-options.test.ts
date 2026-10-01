import { describe, expect, it } from "vitest";

import { parseCliOptions } from "../src/cli-options.js";

describe("parseCliOptions", () => {
  it("defaults to GPT-5.6 Sol on loopback without weakening Codex permissions", () => {
    expect(parseCliOptions([])).toEqual({
      host: "127.0.0.1",
      port: 0,
      model: "gpt-5.6-sol",
      dangerFullAccess: false,
      codexHome: undefined,
      tunnelId: undefined,
      tunnelApiKeyFile: undefined,
      tunnelClient: undefined,
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
        "--codex-home",
        "/tmp/codex-home",
        "--tunnel-id",
        "tunnel_test",
        "--tunnel-api-key-file",
        "/tmp/tunnel-key",
        "--tunnel-client",
        "/tmp/tunnel-client",
        "--danger-full-access",
      ]),
    ).toEqual({
      host: "127.0.0.1",
      port: 4321,
      model: "gpt-5.6-sol",
      dangerFullAccess: true,
      codexHome: "/tmp/codex-home",
      tunnelId: "tunnel_test",
      tunnelApiKeyFile: "/tmp/tunnel-key",
      tunnelClient: "/tmp/tunnel-client",
    });
  });

  it("rejects unknown options instead of silently changing startup behavior", () => {
    expect(() => parseCliOptions(["--wat"])).toThrow(/unknown option/i);
  });
});
