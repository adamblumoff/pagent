import { describe, expect, it, vi } from "vitest";

import {
  createEnrollmentCode,
  revokeConnector,
} from "../src/admin.js";

const ADMIN_TOKEN = "admin-test-secret";

describe("relay administration", () => {
  it("creates a short-lived enrollment code", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        {
          version: 1,
          code: `pge_${"A".repeat(43)}`,
          expiresAt: "2026-08-25T23:00:00.000Z",
        },
        { status: 201 },
      ),
    );

    await expect(
      createEnrollmentCode({
        relayUrl: "https://relay.example.test",
        adminToken: ADMIN_TOKEN,
        ttlMinutes: 30,
        connectorId: "api.connector",
        fetch,
      }),
    ).resolves.toEqual({
      code: `pge_${"A".repeat(43)}`,
      expiresAt: "2026-08-25T23:00:00.000Z",
    });

    const [url, request] = fetch.mock.calls[0]!;
    expect(url.toString()).toBe(
      "https://relay.example.test/v1/admin/enrollment-codes",
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers).toEqual({
      authorization: `Bearer ${ADMIN_TOKEN}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(request?.body as string)).toEqual({
      version: 1,
      expiresInSeconds: 1_800,
      connectorId: "api.connector",
    });
  });

  it("revokes an encoded connector ID", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({ status: "revoked", connectorId: "api.connector" }),
    );

    await revokeConnector({
      relayUrl: "https://relay.example.test",
      adminToken: ADMIN_TOKEN,
      connectorId: "api.connector",
      fetch,
    });

    const [url, request] = fetch.mock.calls[0]!;
    expect(url.toString()).toBe(
      "https://relay.example.test/v1/admin/connectors/api.connector",
    );
    expect(request?.method).toBe("DELETE");
  });

  it("keeps administrator credentials out of failures", async () => {
    const request = createEnrollmentCode({
      relayUrl: "https://relay.example.test",
      adminToken: ADMIN_TOKEN,
      ttlMinutes: 15,
      fetch: vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new Error(`upstream echoed ${ADMIN_TOKEN}`)),
    });

    await expect(request).rejects.toThrow("could not reach the relay");
    await expect(request).rejects.not.toThrow(ADMIN_TOKEN);
  });
});
