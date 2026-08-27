import { CloudflareApi, CloudflareApiError } from "./cloudflare.js";
import {
  deriveManagementToken,
  deriveTunnelSecret,
  randomEnrollmentToken,
  secureTokenEquals,
  sha256,
} from "./credentials.js";
import { ProvisionerStore } from "./storage.js";
import type {
  EnvironmentRecord,
  EnrollmentTokenRecord,
  IdempotencyRecord,
  ProvisionerEnv,
} from "./types.js";

const MAX_BODY_BYTES = 1_024;
const MIN_ENROLLMENT_TTL_SECONDS = 60;
const MAX_ENROLLMENT_TTL_SECONDS = 86_400;
const environmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const idempotencyPattern = /^[\x21-\x7e]{8,128}$/u;
const enrollmentTokenPattern = /^pge_[A-Za-z0-9_-]{43}$/u;

type OperationStatus = "created" | "resumed" | "rotated";

interface Dependencies {
  cloudflareFetch?: typeof fetch;
}

export function createProvisioner(dependencies: Dependencies = {}) {
  return {
    async fetch(request: Request, env: ProvisionerEnv): Promise<Response> {
      return handleErrors(() => route(request, env, dependencies));
    },
  };
}

async function route(
  request: Request,
  env: ProvisionerEnv,
  dependencies: Dependencies,
): Promise<Response> {
  validateEnv(env);
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const store = new ProvisionerStore(env.PAGENT_ENVIRONMENTS);

  if (
    request.method === "POST" &&
    segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "admin" &&
    segments[2] === "enrollment-tokens"
  ) {
    await requireAdmin(request, env.PAGENT_PROVISIONER_ADMIN_TOKEN);
    const body = await parseEnrollmentTokenBody(request);
    return createEnrollmentToken(store, body.expiresInSeconds);
  }

  if (
    request.method === "POST" &&
    segments.length === 2 &&
    segments[0] === "v1" &&
    segments[1] === "environments"
  ) {
    const token = bearerToken(request);
    if (!token || !enrollmentTokenPattern.test(token)) {
      throw new HttpError(401, "unauthorized", "Enrollment credential is invalid.");
    }
    const tokenHash = await sha256(token);
    const id = env.PAGENT_ENROLLMENT_LOCKS.idFromName(tokenHash);
    return env.PAGENT_ENROLLMENT_LOCKS.get(id).fetch(request);
  }

  const cloudflare = cloudflareApi(env, dependencies);

  const isRotate =
    request.method === "POST" &&
    segments.length === 4 &&
    segments[0] === "v1" &&
    segments[1] === "environments" &&
    segments[3] === "rotate";
  const isRevoke =
    request.method === "DELETE" &&
    segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "environments";
  if (isRotate || isRevoke) {
    const environmentId = decodeEnvironmentId(segments[2]);
    const existing = await requireManagedEnvironment(request, store, environmentId);
    if (isRotate) {
      const body = await parseRotateBody(request);
      const idempotencyKey = requireIdempotencyKey(request);
      return rotate(
        env,
        store,
        cloudflare,
        existing,
        body.originPort,
        idempotencyKey,
      );
    }
    if (isRevoke) {
      const idempotencyKey = requireIdempotencyKey(request);
      return revoke(store, cloudflare, existing, idempotencyKey);
    }
  }

  throw new HttpError(404, "not_found", "Route not found.");
}

async function createEnrollmentToken(
  store: ProvisionerStore,
  expiresInSeconds: number,
): Promise<Response> {
  const token = randomEnrollmentToken();
  const now = new Date();
  const record: EnrollmentTokenRecord = {
    version: 1,
    tokenHash: await sha256(token),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.valueOf() + expiresInSeconds * 1_000).toISOString(),
  };
  await store.putEnrollmentToken(record);
  return jsonResponse(201, {
    version: 1,
    token,
    expiresAt: record.expiresAt,
  });
}

async function processEnrollment(
  request: Request,
  env: ProvisionerEnv,
  dependencies: Dependencies,
): Promise<Response> {
  validateEnv(env);
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/v1/environments") {
    throw new HttpError(404, "not_found", "Route not found.");
  }
  const token = bearerToken(request);
  if (!token || !enrollmentTokenPattern.test(token)) {
    throw new HttpError(401, "unauthorized", "Enrollment credential is invalid.");
  }
  const body = await parseEnvironmentBody(request);
  const idempotencyKey = requireIdempotencyKey(request);
  const store = new ProvisionerStore(env.PAGENT_ENVIRONMENTS);
  const tokenHash = await sha256(token);
  const enrollment = await store.getEnrollmentToken(tokenHash);
  if (enrollment === null) {
    throw new HttpError(401, "unauthorized", "Enrollment credential is invalid.");
  }

  const isReplay =
    enrollment.consumedAt !== undefined &&
    enrollment.consumedEnvironmentId === body.environmentId &&
    enrollment.consumedIdempotencyKey === idempotencyKey;
  if (enrollment.consumedAt !== undefined && !isReplay) {
    throw new HttpError(
      409,
      "enrollment_token_consumed",
      "Enrollment credential has already been used.",
    );
  }
  if (enrollment.consumedAt === undefined && Date.parse(enrollment.expiresAt) <= Date.now()) {
    throw new HttpError(401, "enrollment_token_expired", "Enrollment credential has expired.");
  }

  const response = await createOrResume(
    env,
    store,
    cloudflareApi(env, dependencies),
    body.environmentId,
    body.originPort,
    idempotencyKey,
  );
  if (!isReplay) {
    const consumedAt = new Date().toISOString();
    await store.putEnrollmentToken({
      ...enrollment,
      consumedAt,
      consumedEnvironmentId: body.environmentId,
      consumedIdempotencyKey: idempotencyKey,
    });
  }
  return response;
}

function cloudflareApi(
  env: ProvisionerEnv,
  dependencies: Dependencies,
): CloudflareApi {
  return new CloudflareApi(
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_ZONE_ID,
    env.CLOUDFLARE_API_TOKEN,
    env.CLOUDFLARE_API_BASE_URL,
    dependencies.cloudflareFetch,
  );
}

async function createOrResume(
  env: ProvisionerEnv,
  store: ProvisionerStore,
  cloudflare: CloudflareApi,
  environmentId: string,
  originPort: number,
  idempotencyKey: string,
): Promise<Response> {
  const requestHash = await sha256(JSON.stringify({ version: 1, environmentId, originPort }));
  const replay = await checkedReplay(
    store,
    "enroll",
    environmentId,
    idempotencyKey,
    requestHash,
  );
  const existing = await store.getEnvironment(environmentId);
  const wasActive = existing?.lifecycleStatus === "active";
  const hostname = wasActive
    ? existing.hostname
    : await hostnameFor(env.PAGENT_PUBLIC_ZONE, environmentId);
  const tunnelName = `pagent-${(await sha256(environmentId)).slice(0, 32)}`;
  const tunnel = wasActive
    ? { tunnelId: existing.tunnelId, created: false }
    : await cloudflare.createOrFindTunnel(tunnelName);

  let provisionedDnsRecordId: string | undefined;
  try {
    await cloudflare.configureTunnel(tunnel.tunnelId, hostname, originPort);
    const dnsRecordId = await cloudflare.upsertDns(hostname, tunnel.tunnelId);
    provisionedDnsRecordId = dnsRecordId;
    const tunnelToken = await cloudflare.getTunnelToken(tunnel.tunnelId);
    const managementToken = await deriveManagementToken(
      env.PAGENT_CREDENTIAL_SECRET,
      environmentId,
    );
    const now = new Date().toISOString();
    const record: EnvironmentRecord = {
      version: 1,
      environmentId,
      tunnelId: tunnel.tunnelId,
      hostname,
      dnsRecordId,
      originPort,
      managementTokenHash: await sha256(managementToken),
      tunnelTokenHash: await sha256(tunnelToken),
      lifecycleStatus: "active",
      createdAt: wasActive ? existing.createdAt : now,
      updatedAt: now,
    };
    await store.putEnvironment(record);
    const status: OperationStatus =
      replay?.responseStatus === "created" || replay?.responseStatus === "resumed"
        ? replay.responseStatus
        : wasActive || !tunnel.created
          ? "resumed"
          : "created";
    await completeIdempotency(
      store,
      "enroll",
      environmentId,
      idempotencyKey,
      requestHash,
      status,
    );
    return credentialResponse(status, record, tunnelToken, managementToken);
  } catch (error) {
    if (tunnel.created && !wasActive) {
      if (provisionedDnsRecordId) {
        await cloudflare.deleteDns(provisionedDnsRecordId).catch(() => undefined);
      }
      await cloudflare.deleteTunnel(tunnel.tunnelId).catch(() => undefined);
    }
    throw error;
  }
}

async function rotate(
  env: ProvisionerEnv,
  store: ProvisionerStore,
  cloudflare: CloudflareApi,
  existing: EnvironmentRecord,
  originPort: number,
  idempotencyKey: string,
): Promise<Response> {
  if (existing.lifecycleStatus !== "active") {
    throw new HttpError(410, "environment_revoked", "Environment is revoked.");
  }
  const requestHash = await sha256(JSON.stringify({ version: 1, originPort }));
  const replay = await checkedReplay(
    store,
    "rotate",
    existing.environmentId,
    idempotencyKey,
    requestHash,
  );
  await cloudflare.configureTunnel(
    existing.tunnelId,
    existing.hostname,
    originPort,
  );
  const tunnelToken = replay
    ? await cloudflare.getTunnelToken(existing.tunnelId)
    : await cloudflare.rotateTunnelToken(
        existing.tunnelId,
        await deriveTunnelSecret(
          env.PAGENT_CREDENTIAL_SECRET,
          existing.environmentId,
          idempotencyKey,
        ),
      );
  const managementToken = await deriveManagementToken(
    env.PAGENT_CREDENTIAL_SECRET,
    existing.environmentId,
  );
  const record: EnvironmentRecord = {
    ...existing,
    originPort,
    managementTokenHash: await sha256(managementToken),
    tunnelTokenHash: await sha256(tunnelToken),
    updatedAt: new Date().toISOString(),
  };
  await store.putEnvironment(record);
  await completeIdempotency(
    store,
    "rotate",
    existing.environmentId,
    idempotencyKey,
    requestHash,
    "rotated",
  );
  return credentialResponse("rotated", record, tunnelToken, managementToken);
}

async function revoke(
  store: ProvisionerStore,
  cloudflare: CloudflareApi,
  existing: EnvironmentRecord,
  idempotencyKey: string,
): Promise<Response> {
  const requestHash = await sha256(JSON.stringify({ version: 1 }));
  await checkedReplay(
    store,
    "revoke",
    existing.environmentId,
    idempotencyKey,
    requestHash,
  );
  if (existing.lifecycleStatus === "active") {
    await cloudflare.deleteDns(existing.dnsRecordId);
    await cloudflare.deleteTunnel(existing.tunnelId);
    const now = new Date().toISOString();
    await store.putEnvironment({
      ...existing,
      lifecycleStatus: "revoked",
      updatedAt: now,
      revokedAt: now,
    });
  }
  await completeIdempotency(
    store,
    "revoke",
    existing.environmentId,
    idempotencyKey,
    requestHash,
    "revoked",
  );
  return jsonResponse(200, {
    version: 1,
    status: "revoked",
    environmentId: existing.environmentId,
  });
}

async function requireAdmin(request: Request, expected: string): Promise<void> {
  const token = bearerToken(request);
  if (!token || !(await secureTokenEquals(token, expected))) {
    throw new HttpError(401, "unauthorized", "Administrator credential is invalid.");
  }
}

async function requireManagedEnvironment(
  request: Request,
  store: ProvisionerStore,
  environmentId: string,
): Promise<EnvironmentRecord> {
  const existing = await store.getEnvironment(environmentId);
  if (!existing) throw new HttpError(404, "environment_not_found", "Environment not found.");
  const token = bearerToken(request);
  if (
    !token ||
    !(await secureTokenEquals(await sha256(token), existing.managementTokenHash))
  ) {
    throw new HttpError(401, "unauthorized", "Management credential is invalid.");
  }
  return existing;
}

async function checkedReplay(
  store: ProvisionerStore,
  operation: string,
  environmentId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<IdempotencyRecord | null> {
  const existing = await store.getIdempotency(operation, environmentId, idempotencyKey);
  if (existing && existing.requestHash !== requestHash) {
    throw new HttpError(
      409,
      "idempotency_conflict",
      "Idempotency key was already used with a different request.",
    );
  }
  return existing;
}

async function completeIdempotency(
  store: ProvisionerStore,
  operation: string,
  environmentId: string,
  idempotencyKey: string,
  requestHash: string,
  responseStatus: IdempotencyRecord["responseStatus"],
): Promise<void> {
  await store.putIdempotency(operation, environmentId, idempotencyKey, {
    version: 1,
    requestHash,
    responseStatus,
    completedAt: new Date().toISOString(),
  });
}

async function parseEnvironmentBody(request: Request): Promise<{
  environmentId: string;
  originPort: number;
}> {
  const body = await parseJsonBody(request);
  if (body.version !== 1) {
    throw new HttpError(400, "invalid_version", "Request version must be 1.");
  }
  if (typeof body.environmentId !== "string" || !environmentPattern.test(body.environmentId)) {
    throw new HttpError(400, "invalid_environment_id", "Environment ID is invalid.");
  }
  return { environmentId: body.environmentId, originPort: parseOriginPort(body.originPort) };
}

async function parseEnrollmentTokenBody(
  request: Request,
): Promise<{ expiresInSeconds: number }> {
  const body = await parseJsonBody(request);
  if (body.version !== 1) {
    throw new HttpError(400, "invalid_version", "Request version must be 1.");
  }
  if (
    !Number.isSafeInteger(body.expiresInSeconds) ||
    (body.expiresInSeconds as number) < MIN_ENROLLMENT_TTL_SECONDS ||
    (body.expiresInSeconds as number) > MAX_ENROLLMENT_TTL_SECONDS
  ) {
    throw new HttpError(
      400,
      "invalid_expiry",
      `expiresInSeconds must be an integer from ${MIN_ENROLLMENT_TTL_SECONDS} to ${MAX_ENROLLMENT_TTL_SECONDS}.`,
    );
  }
  return { expiresInSeconds: body.expiresInSeconds as number };
}

async function parseRotateBody(request: Request): Promise<{ originPort: number }> {
  const body = await parseJsonBody(request);
  if (body.version !== 1) {
    throw new HttpError(400, "invalid_version", "Request version must be 1.");
  }
  return { originPort: parseOriginPort(body.originPort) };
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "body_too_large", "Request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "body_too_large", "Request body is too large.");
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
  }
}

function parseOriginPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new HttpError(400, "invalid_origin_port", "Origin port must be an integer from 1 to 65535.");
  }
  return value as number;
}

function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key") ?? "";
  if (!idempotencyPattern.test(key)) {
    throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must contain 8 to 128 visible ASCII characters.");
  }
  return key;
}

function bearerToken(request: Request): string | undefined {
  const match = /^Bearer ([^\s]+)$/u.exec(request.headers.get("authorization") ?? "");
  return match?.[1];
}

function decodeEnvironmentId(segment: string | undefined): string {
  if (!segment) throw new HttpError(404, "not_found", "Route not found.");
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, "invalid_environment_id", "Environment ID is invalid.");
  }
  if (!environmentPattern.test(value)) {
    throw new HttpError(400, "invalid_environment_id", "Environment ID is invalid.");
  }
  return value;
}

async function hostnameFor(zone: string, environmentId: string): Promise<string> {
  const normalizedZone = zone.trim().toLowerCase().replace(/^\.+|\.+$/gu, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(normalizedZone)) {
    throw new Error("PAGENT_PUBLIC_ZONE must be a valid DNS name.");
  }
  const digest = (await sha256(environmentId)).toLowerCase().replace(/[_-]/gu, "");
  return `env-${digest.slice(0, 24)}.${normalizedZone}`;
}

function credentialResponse(
  status: OperationStatus,
  record: EnvironmentRecord,
  tunnelToken: string,
  managementToken: string,
): Response {
  return jsonResponse(status === "created" ? 201 : 200, {
    version: 1,
    status,
    environmentId: record.environmentId,
    tunnelId: record.tunnelId,
    hostname: record.hostname,
    tunnelToken,
    managementToken,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { version: 1, error: { code, message } });
}

async function handleErrors(action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (error instanceof CloudflareApiError) {
      console.error("Cloudflare provisioning request failed", {
        status: error.status,
        message: error.message,
      });
      return errorResponse(502, "cloudflare_error", "Cloudflare provisioning failed.");
    }
    console.error("Unhandled Pagent provisioner error", error);
    return errorResponse(500, "internal_error", "Provisioning failed.");
  }
}

function validateEnv(env: ProvisionerEnv): void {
  const required = {
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_ZONE_ID: env.CLOUDFLARE_ZONE_ID,
    CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    PAGENT_PUBLIC_ZONE: env.PAGENT_PUBLIC_ZONE,
    PAGENT_PROVISIONER_ADMIN_TOKEN: env.PAGENT_PROVISIONER_ADMIN_TOKEN,
    PAGENT_CREDENTIAL_SECRET: env.PAGENT_CREDENTIAL_SECRET,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => typeof value !== "string" || value.trim() === "")
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Pagent provisioner bindings are incomplete: ${missing.join(", ")}.`);
  }
  if (env.PAGENT_CREDENTIAL_SECRET.length < 32) {
    throw new Error("PAGENT_CREDENTIAL_SECRET is too short.");
  }
  if (env.PAGENT_PROVISIONER_ADMIN_TOKEN.length < 32) {
    throw new Error("PAGENT_PROVISIONER_ADMIN_TOKEN is too short.");
  }
  if (!env.PAGENT_ENROLLMENT_LOCKS) {
    throw new Error("PAGENT_ENROLLMENT_LOCKS binding is required.");
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class EnrollmentTokenLock {
  readonly #env: ProvisionerEnv;
  readonly #dependencies: Dependencies;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    _state: unknown,
    env: ProvisionerEnv,
    dependencies: Dependencies = {},
  ) {
    this.#env = env;
    this.#dependencies = dependencies;
  }

  async fetch(request: Request): Promise<Response> {
    const previous = this.#tail;
    let release = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await handleErrors(() =>
        processEnrollment(request, this.#env, this.#dependencies),
      );
    } finally {
      release();
    }
  }
}

export default createProvisioner();
