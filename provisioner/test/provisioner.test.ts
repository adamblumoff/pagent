import { describe, expect, it, vi } from "vitest";

import { createProvisioner, EnrollmentTokenLock } from "../src/index.js";
import type {
  DurableObjectId,
  DurableObjectNamespace,
  KvNamespace,
  ProvisionerEnv,
} from "../src/types.js";

class MemoryKv implements KvNamespace {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

interface TestLockId extends DurableObjectId {
  name: string;
}

function fixture() {
  const kv = new MemoryKv();
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  let tokenGeneration = 1;
  let failConfiguration = false;
  const cloudflareFetch = vi.fn(async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const method = init.method ?? "GET";
    if (url.pathname.endsWith("/cfd_tunnel") && method === "POST") {
      return cfResponse({ id: "tunnel-1", name: "pagent-test" });
    }
    if (url.pathname.endsWith("/configurations") && method === "PUT") {
      if (failConfiguration) {
        failConfiguration = false;
        return cfResponse(null, 500, "configuration failed");
      }
      return cfResponse({});
    }
    if (url.pathname.endsWith("/dns_records") && method === "GET") {
      return cfResponse([]);
    }
    if (url.pathname.endsWith("/dns_records") && method === "POST") {
      return cfResponse({ id: "dns-1" });
    }
    if (url.pathname.endsWith("/token") && method === "GET") {
      return cfResponse(`cloudflare-tunnel-token-${tokenGeneration}`);
    }
    if (url.pathname.endsWith("/tunnel-1") && method === "PATCH") {
      tokenGeneration += 1;
      return cfResponse({ id: "tunnel-1" });
    }
    if (method === "DELETE") return cfResponse({});
    throw new Error(`Unexpected Cloudflare request ${method} ${url.pathname}`);
  });

  let env: ProvisionerEnv;
  const locks = new Map<string, EnrollmentTokenLock>();
  const namespace: DurableObjectNamespace = {
    idFromName(name) {
      return { name } as TestLockId;
    },
    get(id) {
      const name = (id as TestLockId).name;
      let lock = locks.get(name);
      if (!lock) {
        lock = new EnrollmentTokenLock({}, env, { cloudflareFetch });
        locks.set(name, lock);
      }
      return { fetch: (request) => lock.fetch(request) };
    },
  };
  env = {
    PAGENT_ENVIRONMENTS: kv,
    CLOUDFLARE_ACCOUNT_ID: "account-1",
    CLOUDFLARE_ZONE_ID: "zone-1",
    CLOUDFLARE_API_TOKEN: "cloudflare-secret",
    PAGENT_PUBLIC_ZONE: "dev.example.com",
    PAGENT_PROVISIONER_ADMIN_TOKEN: "a-control-plane-value-with-at-least-32-characters",
    PAGENT_CREDENTIAL_SECRET: "a-credential-secret-with-at-least-32-characters",
    PAGENT_ENROLLMENT_LOCKS: namespace,
    CLOUDFLARE_API_BASE_URL: "https://cloudflare.test/client/v4",
  };
  return {
    worker: createProvisioner({ cloudflareFetch }),
    env,
    kv,
    calls,
    failNextConfiguration: () => {
      failConfiguration = true;
    },
  };
}

describe("Pagent provisioner", () => {
  it("mints short-lived enrollment tokens with administrator authorization", async () => {
    const test = fixture();
    const response = await test.worker.fetch(adminTokenRequest(), test.env);
    expect(response.status).toBe(201);
    const body = await response.json() as { token: string; expiresAt: string };
    expect(body.token).toMatch(/^pge_[A-Za-z0-9_-]{43}$/u);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());

    const stored = [...test.kv.values.entries()].find(([key]) =>
      key.startsWith("enrollment-token:v1:"));
    expect(stored?.[0]).not.toContain(body.token);
    expect(stored?.[1]).not.toContain(body.token);
    expect(JSON.parse(stored?.[1] ?? "{}")).toMatchObject({
      version: 1,
      expiresAt: body.expiresAt,
    });
    expect(JSON.parse(stored?.[1] ?? "{}")).not.toHaveProperty("consumedAt");
  });

  it("protects token minting and bounds token lifetime", async () => {
    const test = fixture();
    expect((await test.worker.fetch(adminTokenRequest({
      authorization: "Bearer wrong",
    }), test.env)).status).toBe(401);
    const tooShort = await test.worker.fetch(adminTokenRequest(undefined, 59), test.env);
    expect(tooShort.status).toBe(400);
    expect(await tooShort.json()).toMatchObject({ error: { code: "invalid_expiry" } });
    const tooLong = await test.worker.fetch(adminTokenRequest(undefined, 86_401), test.env);
    expect(tooLong.status).toBe(400);
  });

  it("creates a remote tunnel, restricted ingress, and DNS route", async () => {
    const test = fixture();
    const token = await issueEnrollmentToken(test);
    const response = await test.worker.fetch(enrollRequest(token), test.env);
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      version: 1,
      status: "created",
      environmentId: "dev-machine",
      tunnelId: "tunnel-1",
      tunnelToken: "cloudflare-tunnel-token-1",
    });
    expect(body.hostname).toMatch(/^env-[a-z0-9]{24}\.dev\.example\.com$/u);
    expect(body.managementToken).toMatch(/^pgm_[A-Za-z0-9_-]{43}$/u);

    const configure = test.calls.find(({ url }) =>
      url.pathname.endsWith("/configurations"));
    expect(JSON.parse(String(configure?.init.body))).toEqual({
      config: {
        ingress: [
          {
            hostname: body.hostname,
            path: "^/v1/(events|probe)$",
            service: "http://127.0.0.1:43121",
          },
          { service: "http_status:404" },
        ],
      },
    });

    const environment = storedRecord(test.kv, "environment:v1:");
    expect(JSON.stringify(environment)).not.toContain("cloudflare-tunnel-token-1");
    expect(JSON.stringify(environment)).not.toContain(String(body.managementToken));
    expect(storedRecord(test.kv, "enrollment-token:v1:")).toMatchObject({
      consumedEnvironmentId: "dev-machine",
      consumedIdempotencyKey: "enroll-key-0001",
      consumedAt: expect.any(String),
    });
  });

  it("allows only an exact idempotent replay of a consumed token", async () => {
    const test = fixture();
    const token = await issueEnrollmentToken(test);
    const first = await test.worker.fetch(enrollRequest(token), test.env);
    const firstBody = await first.json() as Record<string, unknown>;
    const replay = await test.worker.fetch(enrollRequest(token), test.env);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({
      status: "created",
      managementToken: firstBody.managementToken,
    });
    expect(test.calls.filter(({ url, init }) =>
      url.pathname.endsWith("/cfd_tunnel") && init.method === "POST")).toHaveLength(1);

    const reused = await test.worker.fetch(enrollRequest(
      token,
      { "idempotency-key": "enroll-key-0002" },
      43121,
      "other-machine",
    ), test.env);
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({
      error: { code: "enrollment_token_consumed" },
    });
  });

  it("serializes concurrent attempts to spend the same token", async () => {
    const test = fixture();
    const token = await issueEnrollmentToken(test);
    const [first, second] = await Promise.all([
      test.worker.fetch(enrollRequest(token), test.env),
      test.worker.fetch(enrollRequest(
        token,
        { "idempotency-key": "enroll-key-0002" },
        43121,
        "other-machine",
      ), test.env),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(test.calls.filter(({ url, init }) =>
      url.pathname.endsWith("/cfd_tunnel") && init.method === "POST")).toHaveLength(1);
  });

  it("does not consume a token when provisioning fails", async () => {
    const test = fixture();
    const token = await issueEnrollmentToken(test);
    test.failNextConfiguration();
    const failed = await test.worker.fetch(enrollRequest(token), test.env);
    expect(failed.status).toBe(502);
    expect(storedRecord(test.kv, "enrollment-token:v1:")).not.toHaveProperty("consumedAt");

    const retry = await test.worker.fetch(enrollRequest(token), test.env);
    expect(retry.status).toBe(201);
    expect(storedRecord(test.kv, "enrollment-token:v1:")).toHaveProperty("consumedAt");
  });

  it("rejects expired enrollment tokens", async () => {
    const test = fixture();
    const token = await issueEnrollmentToken(test);
    const entry = [...test.kv.values.entries()].find(([key]) =>
      key.startsWith("enrollment-token:v1:"));
    if (!entry) throw new Error("Enrollment token record was not stored.");
    test.kv.values.set(entry[0], JSON.stringify({
      ...JSON.parse(entry[1]),
      expiresAt: "2020-01-01T00:00:00.000Z",
    }));

    const response = await test.worker.fetch(enrollRequest(token), test.env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "enrollment_token_expired" },
    });
    expect(test.calls).toHaveLength(0);
  });

  it("resumes an active environment with a fresh enrollment token", async () => {
    const test = fixture();
    const firstToken = await issueEnrollmentToken(test);
    await test.worker.fetch(enrollRequest(firstToken), test.env);
    const secondToken = await issueEnrollmentToken(test);
    const resumed = await test.worker.fetch(enrollRequest(
      secondToken,
      { "idempotency-key": "enroll-key-0002" },
      43123,
    ), test.env);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ status: "resumed" });
    expect(test.calls.filter(({ url, init }) =>
      url.pathname.endsWith("/cfd_tunnel") && init.method === "POST")).toHaveLength(1);
  });

  it("rotates and revokes with the environment management credential", async () => {
    const test = fixture();
    const token = await issueEnrollmentToken(test);
    const enrollment = await test.worker.fetch(enrollRequest(token), test.env);
    const enrolled = await enrollment.json() as Record<string, unknown>;
    const managementToken = String(enrolled.managementToken);
    const rotateRequest = () => new Request(
      "https://provisioner.test/v1/environments/dev-machine/rotate",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${managementToken}`,
          "content-type": "application/json",
          "idempotency-key": "rotate-key-0001",
        },
        body: JSON.stringify({ version: 1, originPort: 43122 }),
      },
    );
    expect((await test.worker.fetch(rotateRequest(), test.env)).status).toBe(200);
    await test.worker.fetch(rotateRequest(), test.env);
    expect(test.calls.filter(({ init }) => init.method === "PATCH")).toHaveLength(1);

    const revokeRequest = () => new Request(
      "https://provisioner.test/v1/environments/dev-machine",
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${managementToken}`,
          "idempotency-key": "revoke-key-0001",
        },
      },
    );
    expect((await test.worker.fetch(revokeRequest(), test.env)).status).toBe(200);
    expect((await test.worker.fetch(revokeRequest(), test.env)).status).toBe(200);
  });

  it("never accepts event traffic", async () => {
    const test = fixture();
    const event = await test.worker.fetch(new Request(
      "https://provisioner.test/v1/events",
      { method: "POST", body: "secret-event-body" },
    ), test.env);
    expect(event.status).toBe(404);
  });
});

type Fixture = ReturnType<typeof fixture>;

async function issueEnrollmentToken(test: Fixture): Promise<string> {
  const response = await test.worker.fetch(adminTokenRequest(), test.env);
  expect(response.status).toBe(201);
  return String((await response.json() as { token: string }).token);
}

function adminTokenRequest(
  headers?: Record<string, string>,
  expiresInSeconds = 300,
): Request {
  return new Request("https://provisioner.test/v1/admin/enrollment-tokens", {
    method: "POST",
    headers: {
      authorization: "Bearer a-control-plane-value-with-at-least-32-characters",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ version: 1, expiresInSeconds }),
  });
}

function enrollRequest(
  token: string,
  headers?: Record<string, string>,
  originPort = 43121,
  environmentId = "dev-machine",
): Request {
  return new Request("https://provisioner.test/v1/environments", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "enroll-key-0001",
      ...headers,
    },
    body: JSON.stringify({ version: 1, environmentId, originPort }),
  });
}

function storedRecord(kv: MemoryKv, prefix: string): Record<string, unknown> {
  const value = [...kv.values.entries()].find(([key]) => key.startsWith(prefix))?.[1];
  if (!value) throw new Error(`Stored record ${prefix} was not found.`);
  return JSON.parse(value) as Record<string, unknown>;
}

function cfResponse(result: unknown, status = 200, message?: string): Response {
  return new Response(JSON.stringify({
    success: status < 400,
    result,
    errors: message ? [{ message }] : [],
  }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
