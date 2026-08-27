import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { resolveCloudflaredBinary } from "./tunnel-process.js";

const execFileAsync = promisify(execFile);
export const CLOUDFLARED_VERSION = "2026.7.2";

interface ReleaseAsset {
  name: string;
  sha256: string;
  archive: boolean;
}

const RELEASE_ASSETS: Record<string, ReleaseAsset> = {
  "linux-x64": {
    name: "cloudflared-linux-amd64",
    sha256: "ec905ea7b7e327ff8abdde8cb64697a2152de74dbcdbf6aec9db8364eb3886cd",
    archive: false,
  },
  "linux-arm64": {
    name: "cloudflared-linux-arm64",
    sha256: "405df476437e027fc6d18729a5a77155c0a33a6082aeee60a799a688f3052e66",
    archive: false,
  },
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "4ee0d3b48a990a2f9b5faec5838f73ec1f400aa8e0a4864be576adfafec406cb",
    archive: true,
  },
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "2086e51c61d6565781d84117a5007d0c826d03ffdc74acb91c08c167f9f8cd7c",
    archive: true,
  },
  "win32-x64": {
    name: "cloudflared-windows-amd64.exe",
    sha256: "cdb5d4432f6ae1595654a692a51308b69d2bf7af961f5578d9391837cf072df9",
    archive: false,
  },
};

export interface EnsureCloudflaredOptions {
  platform?: NodeJS.Platform | undefined;
  architecture?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  homeDirectory?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}

export async function ensureCloudflared(
  options: EnsureCloudflaredOptions = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  try {
    const existing = await resolveCloudflaredBinary({
      dependencies: { env: options.environment, platform },
    });
    if (await compatibleVersion(existing)) return existing;
  } catch {
    // Install the pinned build below.
  }

  const asset = releaseAsset(platform, architecture);
  const root = installRoot(
    platform,
    options.environment ?? process.env,
    options.homeDirectory ?? homedir(),
  );
  const executable = join(
    root,
    CLOUDFLARED_VERSION,
    platform === "win32" ? "cloudflared.exe" : "cloudflared",
  );
  try {
    if (await compatibleVersion(executable)) return executable;
  } catch {
    // Download or replace an incomplete cached copy.
  }

  const fetchRelease = options.fetch ?? globalThis.fetch;
  if (typeof fetchRelease !== "function") {
    throw new Error("Pagent cannot download cloudflared because fetch is unavailable.");
  }
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`;
  let response: Response;
  try {
    response = await fetchRelease(url, { signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new Error("Pagent could not download cloudflared. Check the network connection.");
  }
  if (!response.ok) {
    throw new Error(`Pagent could not download cloudflared. GitHub returned HTTP ${response.status}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error("Pagent rejected the cloudflared download because its checksum did not match.");
  }

  await mkdir(dirname(executable), { recursive: true, mode: 0o700 });
  const temporary = `${executable}.${randomUUID()}.tmp`;
  try {
    if (asset.archive) {
      const archive = `${temporary}.tgz`;
      const extraction = `${temporary}.dir`;
      await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
      await mkdir(extraction, { mode: 0o700 });
      await execFileAsync("tar", ["-xzf", archive, "-C", extraction]);
      await rename(join(extraction, "cloudflared"), temporary);
      await rm(archive, { force: true });
      await rm(extraction, { recursive: true, force: true });
    } else {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o700 });
    }
    if (platform !== "win32") await chmod(temporary, 0o700);
    await rename(temporary, executable);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    await rm(`${temporary}.tgz`, { force: true });
    await rm(`${temporary}.dir`, { recursive: true, force: true });
    throw new Error("Pagent could not install cloudflared in its local cache.", {
      cause: error,
    });
  }
  if (!(await compatibleVersion(executable))) {
    await rm(executable, { force: true });
    throw new Error("The installed cloudflared binary did not report the pinned version.");
  }
  return executable;
}

export function cloudflaredReleaseAsset(
  platform: NodeJS.Platform,
  architecture: string,
): Readonly<ReleaseAsset> {
  return { ...releaseAsset(platform, architecture) };
}

function releaseAsset(
  platform: NodeJS.Platform,
  architecture: string,
): ReleaseAsset {
  const asset = RELEASE_ASSETS[`${platform}-${architecture}`];
  if (asset === undefined) {
    throw new Error(
      `Pagent does not provide cloudflared ${CLOUDFLARED_VERSION} for ${platform} ${architecture}. Install cloudflared on PATH before running init.`,
    );
  }
  return asset;
}

async function compatibleVersion(path: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(path, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const match = /cloudflared version (\d{4})\.(\d+)\.(\d+)/iu.exec(
      `${stdout}${stderr}`,
    );
    if (match === null) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return year > 2025 || (year === 2025 && month >= 4);
  } catch {
    return false;
  }
}

function installRoot(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === "win32") {
    return join(environment.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Pagent", "bin");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "Pagent", "bin");
  }
  return join(environment.XDG_CACHE_HOME ?? join(home, ".cache"), "pagent", "bin");
}
