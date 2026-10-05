import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import AdmZip from "adm-zip";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureTunnelClient } from "../src/tunnel/install.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("ensureTunnelClient", () => {
  it("verifies the pinned checksum manifest and platform ZIP before caching the binary", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "runwire-tunnel-install-"));
    tempDirs.push(cacheDir);

    const zip = new AdmZip();
    zip.addFile("nested/tunnel-client", Buffer.from("#!/bin/sh\necho tunnel\n"));
    const archive = zip.toBuffer();
    const filename = "tunnel-client-v0.0.15-darwin-arm64.zip";
    const manifest = Buffer.from(`${sha256(archive)}  ${filename}\n`, "utf8");
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/SHA256SUMS.txt")) return new Response(manifest, { status: 200 });
      if (url.endsWith(`/${filename}`)) {
        return new Response(new Uint8Array(archive), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });

    const installed = await ensureTunnelClient({
      cacheDir,
      platform: "darwin",
      arch: "arm64",
      fetchImpl,
      manifestSha256: sha256(manifest),
    });

    expect(path.basename(installed)).toBe("tunnel-client");
    expect(await fs.readFile(installed, "utf8")).toContain("echo tunnel");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const cached = await ensureTunnelClient({
      cacheDir,
      platform: "darwin",
      arch: "arm64",
      fetchImpl,
      manifestSha256: sha256(manifest),
    });
    expect(cached).toBe(installed);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the checksum manifest does not match the pinned digest", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "runwire-tunnel-install-"));
    tempDirs.push(cacheDir);
    const fetchImpl = vi.fn(async () => new Response("bad manifest", { status: 200 }));

    await expect(
      ensureTunnelClient({
        cacheDir,
        platform: "win32",
        arch: "x64",
        fetchImpl,
        manifestSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/checksum manifest/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("selects the Windows amd64 archive and caches tunnel-client.exe", async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "runwire-tunnel-install-"));
    tempDirs.push(cacheDir);
    const zip = new AdmZip();
    zip.addFile("release/tunnel-client.exe", Buffer.from("windows-binary"));
    const archive = zip.toBuffer();
    const filename = "tunnel-client-v0.0.15-windows-amd64.zip";
    const manifest = Buffer.from(`${sha256(archive)}  ${filename}\r\n`, "utf8");
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/SHA256SUMS.txt")) return new Response(manifest, { status: 200 });
      if (url.endsWith(`/${filename}`)) {
        return new Response(new Uint8Array(archive), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });

    const installed = await ensureTunnelClient({
      cacheDir,
      platform: "win32",
      arch: "x64",
      fetchImpl,
      manifestSha256: sha256(manifest),
    });

    expect(path.basename(installed)).toBe("tunnel-client.exe");
    expect(await fs.readFile(installed, "utf8")).toBe("windows-binary");
  });
});
