import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import AdmZip from "adm-zip";

export const TUNNEL_CLIENT_VERSION = "v0.0.15";
export const TUNNEL_CLIENT_RELEASE_BASE =
  `https://persistent.oaistatic.com/tunnel-client/${TUNNEL_CLIENT_VERSION}`;

// GitHub release asset digest for v0.0.15/SHA256SUMS.txt.
export const TUNNEL_CLIENT_MANIFEST_SHA256 =
  "8a32bbcd724468f1874f12d5b0dedb6e6b07dfe5aa323cf5b4c070a5a81b0b4e";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface EnsureTunnelClientOptions {
  cacheDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: FetchLike;
  releaseBaseUrl?: string;
  manifestSha256?: string;
}

export async function ensureTunnelClient(
  options: EnsureTunnelClientOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = releaseTarget(platform, arch);
  const cacheRoot = options.cacheDir ?? defaultCacheDir(platform);
  const installDir = path.join(
    cacheRoot,
    "tunnel-client",
    TUNNEL_CLIENT_VERSION,
    `${target.os}-${target.arch}`,
  );
  const binaryPath = path.join(installDir, target.binaryName);

  if (await fileExists(binaryPath)) return binaryPath;

  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const releaseBaseUrl = options.releaseBaseUrl ?? TUNNEL_CLIENT_RELEASE_BASE;
  const expectedManifestSha =
    options.manifestSha256 ?? TUNNEL_CLIENT_MANIFEST_SHA256;
  const archiveName =
    `tunnel-client-${TUNNEL_CLIENT_VERSION}-${target.os}-${target.arch}.zip`;

  const manifest = await fetchBytes(
    fetchImpl,
    `${releaseBaseUrl}/SHA256SUMS.txt`,
    1024 * 1024,
  );
  const actualManifestSha = sha256(manifest);
  if (actualManifestSha !== expectedManifestSha) {
    throw new Error(
      `OpenAI tunnel-client checksum manifest verification failed: expected ${expectedManifestSha}, received ${actualManifestSha}`,
    );
  }

  const expectedArchiveSha = checksumForArchive(manifest.toString("utf8"), archiveName);
  if (!expectedArchiveSha) {
    throw new Error(`OpenAI tunnel-client checksum manifest does not contain ${archiveName}`);
  }

  const archive = await fetchBytes(
    fetchImpl,
    `${releaseBaseUrl}/${archiveName}`,
    128 * 1024 * 1024,
  );
  const actualArchiveSha = sha256(archive);
  if (actualArchiveSha !== expectedArchiveSha) {
    throw new Error(
      `OpenAI tunnel-client archive verification failed for ${archiveName}: expected ${expectedArchiveSha}, received ${actualArchiveSha}`,
    );
  }

  const zip = new AdmZip(archive);
  const binaryEntries = zip
    .getEntries()
    .filter(
      entry =>
        !entry.isDirectory && path.posix.basename(entry.entryName) === target.binaryName,
    );
  if (binaryEntries.length !== 1) {
    throw new Error(
      `Expected exactly one ${target.binaryName} in ${archiveName}, found ${binaryEntries.length}`,
    );
  }

  const binary = binaryEntries[0].getData();
  if (binary.length === 0 || binary.length > 100 * 1024 * 1024) {
    throw new Error(`Unexpected tunnel-client binary size: ${binary.length} bytes`);
  }

  await fs.mkdir(installDir, { recursive: true });
  const tempPath = `${binaryPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tempPath, binary, { mode: 0o755 });
    if (platform !== "win32") await fs.chmod(tempPath, 0o755);
    await fs.rename(tempPath, binaryPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    if (!(await fileExists(binaryPath))) throw error;
  }

  return binaryPath;
}

function releaseTarget(
  platform: NodeJS.Platform,
  arch: string,
): { os: string; arch: string; binaryName: string } {
  const osName =
    platform === "darwin"
      ? "darwin"
      : platform === "win32"
        ? "windows"
        : platform === "linux"
          ? "linux"
          : undefined;
  const archName = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  if (!osName || !archName) {
    throw new Error(`Unsupported tunnel-client platform: ${platform}/${arch}`);
  }
  return {
    os: osName,
    arch: archName,
    binaryName: platform === "win32" ? "tunnel-client.exe" : "tunnel-client",
  };
}

function defaultCacheDir(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "routewire",
      "cache",
    );
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "routewire");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "routewire");
}

function checksumForArchive(manifest: string, filename: string): string | undefined {
  for (const line of manifest.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[2] === filename) return match[1].toLowerCase();
  }
  return undefined;
}

async function fetchBytes(
  fetchImpl: FetchLike,
  url: string,
  maxBytes: number,
): Promise<Buffer> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Download exceeds size limit for ${url}: ${contentLength} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error(`Download exceeds size limit for ${url}`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
