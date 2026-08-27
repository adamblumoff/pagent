import { describe, expect, it, vi } from "vitest";

import {
  CLOUDFLARED_VERSION,
  cloudflaredReleaseAsset,
  ensureCloudflared,
} from "../src/cloudflared-install.js";

describe("cloudflared installer", () => {
  it("pins supported Cloudflare release assets and checksums", () => {
    expect(CLOUDFLARED_VERSION).toBe("2026.7.2");
    expect(cloudflaredReleaseAsset("linux", "x64")).toMatchObject({
      name: "cloudflared-linux-amd64",
      sha256: "ec905ea7b7e327ff8abdde8cb64697a2152de74dbcdbf6aec9db8364eb3886cd",
      archive: false,
    });
    expect(() => cloudflaredReleaseAsset("freebsd", "x64")).toThrow(
      "does not provide cloudflared",
    );
  });

  it("rejects a download before writing when its checksum is wrong", async () => {
    const fetchRelease = vi.fn(async () => new Response("wrong binary"));
    await expect(
      ensureCloudflared({
        platform: "linux",
        architecture: "x64",
        environment: { PATH: "" },
        homeDirectory: "/tmp/pagent-cloudflared-install-test",
        fetch: fetchRelease,
      }),
    ).rejects.toThrow("checksum did not match");
    expect(fetchRelease).toHaveBeenCalledWith(
      expect.stringContaining("/2026.7.2/cloudflared-linux-amd64"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
