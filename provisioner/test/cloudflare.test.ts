import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudflareApi } from "../src/cloudflare.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CloudflareApi", () => {
  it("calls the Workers runtime fetch with its required global receiver", async () => {
    const guardedFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(new Response(JSON.stringify({
        success: true,
        result: { id: "tunnel-1" },
      }), {
        headers: { "content-type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", guardedFetch);

    const cloudflare = new CloudflareApi("account-1", "zone-1", "secret");

    await expect(cloudflare.createOrFindTunnel("pagent-test")).resolves.toEqual({
      tunnelId: "tunnel-1",
      created: true,
    });
    expect(guardedFetch).toHaveBeenCalledOnce();
  });
});
