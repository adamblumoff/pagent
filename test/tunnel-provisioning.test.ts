import { describe, expect, it, vi } from "vitest";

import {
  TunnelProvisioningClient,
  TunnelProvisioningError,
} from "../src/tunnel-provisioning.js";

const ENROLLMENT_TOKEN = "pgen_test-enrollment-secret";
const MANAGEMENT_TOKEN = "pgmanage_test-management-secret";
const SOURCE_TOKEN = "pgsrc_test-source-secret";

describe("TunnelProvisioningClient", () => {
  it("creates a bounded enrollment token through the admin endpoint", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      version: 1,
      token: "pge_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      expiresAt: "2026-08-27T18:00:00.000Z",
    }));
    const client = provisioningClient(fetch);

    await expect(client.createEnrollmentToken({
      adminToken: "control-plane-test-value",
      expiresInSeconds: 600,
    })).resolves.toEqual({
      token: "pge_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
      expiresAt: "2026-08-27T18:00:00.000Z",
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://provision.pagent.example.com/v1/admin/enrollment-tokens"),
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer control-plane-test-value",
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: 1, expiresInSeconds: 600 }),
      }),
    );
  });

  it.each([59, 86_401])("rejects an enrollment lifetime of %i seconds", async (expiresInSeconds) => {
    await expect(provisioningClient(vi.fn()).createEnrollmentToken({
      adminToken: "control-plane-test-value",
      expiresInSeconds,
    })).rejects.toThrow("60 to 86400");
  });

  it("creates an environment with a replay-safe request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      provisionResponse("created"),
    );
    const client = provisioningClient(fetch);

    await expect(client.createOrResume({
      environmentId: "repo-workstation-7f2a",
      enrollmentToken: ENROLLMENT_TOKEN,
      idempotencyKey: "init-018f2d2d-43f1",
      originPort: 47_321,
    })).resolves.toEqual({
      environmentId: "repo-workstation-7f2a",
      tunnelId: "2d8f665d-e480-4499-b6f0-9f43b7d1a9df",
      eventOrigin: "https://repo-workstation-7f2a.pagent.example.com",
      tunnelToken: "cloudflare-tunnel-token",
      managementToken: MANAGEMENT_TOKEN,
      status: "created",
    });

    const [url, request] = fetch.mock.calls[0]!;
    expect(url.toString()).toBe(
      "https://provision.pagent.example.com/v1/environments",
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers).toEqual({
      authorization: `Bearer ${ENROLLMENT_TOKEN}`,
      "content-type": "application/json",
      "idempotency-key": "init-018f2d2d-43f1",
    });
    expect(JSON.parse(request?.body as string)).toEqual({
      version: 1,
      environmentId: "repo-workstation-7f2a",
      originPort: 47_321,
    });
  });

  it("returns a resumed environment without changing its credentials", async () => {
    const client = provisioningClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        provisionResponse("resumed"),
      ),
    );

    await expect(client.createOrResume({
      environmentId: "repo-workstation-7f2a",
      enrollmentToken: ENROLLMENT_TOKEN,
      idempotencyKey: "same-init",
      originPort: 47_321,
    })).resolves.toMatchObject({ status: "resumed" });
  });

  it("rotates a tunnel through its scoped management credential", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      provisionResponse("rotated", {
        tunnelToken: "rotated-cloudflare-tunnel-token",
      }),
    );
    const client = provisioningClient(fetch);

    await expect(client.rotate({
      environmentId: "repo-workstation-7f2a",
      managementToken: MANAGEMENT_TOKEN,
      idempotencyKey: "reset-9fbb",
      originPort: 47_322,
    })).resolves.toMatchObject({
      status: "rotated",
      tunnelToken: "rotated-cloudflare-tunnel-token",
    });

    const [url, request] = fetch.mock.calls[0]!;
    expect(url.toString()).toBe(
      "https://provision.pagent.example.com/v1/environments/repo-workstation-7f2a/rotate",
    );
    expect(request?.headers).toEqual({
      authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      "content-type": "application/json",
      "idempotency-key": "reset-9fbb",
    });
    expect(JSON.parse(request?.body as string)).toEqual({
      version: 1,
      originPort: 47_322,
    });
  });

  it.each([204, 404])("treats tunnel deletion with HTTP %i as complete", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, { status }),
    );
    const client = provisioningClient(fetch);

    await expect(client.delete({
      environmentId: "repo-workstation-7f2a",
      managementToken: MANAGEMENT_TOKEN,
      idempotencyKey: "delete-bf88",
    })).resolves.toBeUndefined();

    const [url, request] = fetch.mock.calls[0]!;
    expect(url.toString()).toBe(
      "https://provision.pagent.example.com/v1/environments/repo-workstation-7f2a",
    );
    expect(request?.method).toBe("DELETE");
    expect(request?.headers).toEqual({
      authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      "idempotency-key": "delete-bf88",
    });
  });

  it("sends an encrypted probe to the tunnel instead of the provisioning service", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        version: 1,
        status: "ready",
        environmentId: "repo-workstation-7f2a",
      }),
    );
    const client = provisioningClient(fetch);
    const body = JSON.stringify({ version: 1, event: { context: "encrypted" } });

    await expect(client.probe({
      environmentId: "repo-workstation-7f2a",
      eventOrigin: "https://repo-workstation-7f2a.pagent.example.com",
      sourceToken: SOURCE_TOKEN,
      body,
    })).resolves.toEqual({
      environmentId: "repo-workstation-7f2a",
      status: "ready",
    });

    const [url, request] = fetch.mock.calls[0]!;
    expect(url.toString()).toBe(
      "https://repo-workstation-7f2a.pagent.example.com/v1/probe",
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers).toEqual({
      authorization: `Bearer ${SOURCE_TOKEN}`,
      "content-type": "application/json",
    });
    expect(request?.body).toBe(body);
  });

  it("classifies retryable HTTP failures without reading an error body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(MANAGEMENT_TOKEN, { status: 503 }),
    );
    const request = provisioningClient(fetch).createOrResume({
      environmentId: "repo-workstation-7f2a",
      enrollmentToken: ENROLLMENT_TOKEN,
      idempotencyKey: "init-1",
      originPort: 47_321,
    });

    await expect(request).rejects.toMatchObject({
      name: "TunnelProvisioningError",
      code: "http",
      retryable: true,
      statusCode: 503,
    });
    await expect(request).rejects.not.toThrow(MANAGEMENT_TOKEN);
  });

  it("distinguishes caller cancellation from a network failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(
      new Error(`upstream echoed ${ENROLLMENT_TOKEN}`),
    );
    const request = provisioningClient(fetch).createOrResume({
      environmentId: "repo-workstation-7f2a",
      enrollmentToken: ENROLLMENT_TOKEN,
      idempotencyKey: "init-1",
      originPort: 47_321,
      signal: controller.signal,
    });

    await expect(request).rejects.toMatchObject({
      code: "aborted",
      retryable: false,
    });
    await expect(request).rejects.not.toThrow(ENROLLMENT_TOKEN);
  });

  it("classifies network failures without leaking the enrollment token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(
      new Error(`upstream echoed ${ENROLLMENT_TOKEN}`),
    );
    const request = provisioningClient(fetch).createOrResume({
      environmentId: "repo-workstation-7f2a",
      enrollmentToken: ENROLLMENT_TOKEN,
      idempotencyKey: "init-1",
      originPort: 47_321,
    });

    await expect(request).rejects.toMatchObject({
      code: "network",
      retryable: true,
    });
    await expect(request).rejects.not.toThrow(ENROLLMENT_TOKEN);
  });

  it("reports timeouts as retryable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async (_url, request) => new Promise((_resolve, reject) => {
        request?.signal?.addEventListener("abort", () => {
          reject(request.signal?.reason);
        }, { once: true });
      }),
    );
    const client = new TunnelProvisioningClient({
      serviceUrl: "https://provision.pagent.example.com",
      fetch,
      timeoutMs: 1,
    });

    await expect(client.createOrResume({
      environmentId: "repo-workstation-7f2a",
      enrollmentToken: ENROLLMENT_TOKEN,
      idempotencyKey: "init-1",
      originPort: 47_321,
    })).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("rejects responses that change the requested environment", async () => {
    const client = provisioningClient(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        provisionResponse("created", { environmentId: "someone-elses-machine" }),
      ),
    );

    await expect(client.createOrResume({
      environmentId: "repo-workstation-7f2a",
      enrollmentToken: ENROLLMENT_TOKEN,
      idempotencyKey: "init-1",
      originPort: 47_321,
    })).rejects.toBeInstanceOf(TunnelProvisioningError);
  });

  it("refuses plaintext service and event origins", async () => {
    expect(() => new TunnelProvisioningClient({
      serviceUrl: "http://provision.pagent.example.com",
    })).toThrow("HTTPS origin");

    const client = provisioningClient(vi.fn<typeof globalThis.fetch>());
    await expect(client.probe({
      environmentId: "repo-workstation-7f2a",
      eventOrigin: "http://repo-workstation-7f2a.pagent.example.com",
      sourceToken: SOURCE_TOKEN,
      body: "{}",
    })).rejects.toThrow("HTTPS origin");
  });

  it("allows an HTTP loopback provisioner for local Worker development", () => {
    expect(() => new TunnelProvisioningClient({
      serviceUrl: "http://127.0.0.1:8787",
    })).not.toThrow();
    expect(() => new TunnelProvisioningClient({
      serviceUrl: "http://localhost:8787",
    })).not.toThrow();
  });

  it("validates the loopback port before sending credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = provisioningClient(fetch);

    await expect(client.createOrResume({
      environmentId: "repo-workstation-7f2a",
      enrollmentToken: ENROLLMENT_TOKEN,
      idempotencyKey: "init-1",
      originPort: 65_536,
    })).rejects.toThrow("from 1 to 65535");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires an encrypted envelope for the direct probe", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = provisioningClient(fetch);

    await expect(client.probe({
      environmentId: "repo-workstation-7f2a",
      eventOrigin: "https://repo-workstation-7f2a.pagent.example.com",
      sourceToken: SOURCE_TOKEN,
      body: "  ",
    })).rejects.toThrow("encrypted event envelope");
    expect(fetch).not.toHaveBeenCalled();
  });
});

function provisioningClient(fetch: typeof globalThis.fetch): TunnelProvisioningClient {
  return new TunnelProvisioningClient({
    serviceUrl: "https://provision.pagent.example.com",
    fetch,
  });
}

function provisionResponse(
  status: "created" | "resumed" | "rotated",
  overrides: Record<string, unknown> = {},
): Response {
  return Response.json({
    version: 1,
    status,
    environmentId: "repo-workstation-7f2a",
    tunnelId: "2d8f665d-e480-4499-b6f0-9f43b7d1a9df",
    hostname: "repo-workstation-7f2a.pagent.example.com",
    tunnelToken: "cloudflare-tunnel-token",
    managementToken: MANAGEMENT_TOKEN,
    ...overrides,
  });
}
