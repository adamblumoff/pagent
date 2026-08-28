import { CloudflareApi } from "./cloudflare.js";
import {
  deriveManagementToken,
  deriveTunnelSecret,
  randomEnrollmentToken,
  sha256,
} from "./credentials.js";
import {
  HttpError,
  jsonResponse,
  parseEnvironmentBody,
  requireEnrollmentToken,
  requireIdempotencyKey,
} from "./http.js";
import { ProvisionerStore } from "./storage.js";
import type {
  EnvironmentRecord,
  EnrollmentTokenRecord,
  IdempotencyRecord,
  ProvisionerDependencies,
  ProvisionerEnv,
} from "./types.js";

type OperationStatus = "created" | "resumed" | "rotated";

export async function createEnrollmentToken(
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

export async function processEnrollment(
  request: Request,
  env: ProvisionerEnv,
  dependencies: ProvisionerDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/v1/environments") {
    throw new HttpError(404, "not_found", "Route not found.");
  }
  const token = requireEnrollmentToken(request);
  const body = await parseEnvironmentBody(request);
  const idempotencyKey = requireIdempotencyKey(request);
  const store = new ProvisionerStore(env.PAGENT_ENVIRONMENTS);
  const tokenHash = await sha256(token);
  const enrollment = await store.getEnrollmentToken(tokenHash);
  if (enrollment === null) {
    throw new HttpError(
      401,
      "unauthorized",
      "Enrollment credential is invalid.",
    );
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
  if (
    enrollment.consumedAt === undefined &&
    Date.parse(enrollment.expiresAt) <= Date.now()
  ) {
    throw new HttpError(
      401,
      "enrollment_token_expired",
      "Enrollment credential has expired.",
    );
  }

  const response = await createOrResume(
    env,
    store,
    createCloudflareApi(env, dependencies),
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

export function createCloudflareApi(
  env: ProvisionerEnv,
  dependencies: ProvisionerDependencies,
): CloudflareApi {
  return new CloudflareApi(
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_ZONE_ID,
    env.CLOUDFLARE_API_TOKEN,
    env.CLOUDFLARE_API_BASE_URL,
    dependencies.cloudflareFetch,
  );
}

export async function rotateEnvironment(
  env: ProvisionerEnv,
  store: ProvisionerStore,
  cloudflare: CloudflareApi,
  existing: EnvironmentRecord,
  originPort: number,
  idempotencyKey: string,
): Promise<Response> {
  if (existing.lifecycleStatus !== "active") {
    throw new HttpError(
      410,
      "environment_revoked",
      "Environment is revoked.",
    );
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

export async function revokeEnvironment(
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

async function createOrResume(
  env: ProvisionerEnv,
  store: ProvisionerStore,
  cloudflare: CloudflareApi,
  environmentId: string,
  originPort: number,
  idempotencyKey: string,
): Promise<Response> {
  const requestHash = await sha256(
    JSON.stringify({ version: 1, environmentId, originPort }),
  );
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
      replay?.responseStatus === "created" ||
      replay?.responseStatus === "resumed"
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

async function checkedReplay(
  store: ProvisionerStore,
  operation: string,
  environmentId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<IdempotencyRecord | null> {
  const existing = await store.getIdempotency(
    operation,
    environmentId,
    idempotencyKey,
  );
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

async function hostnameFor(
  zone: string,
  environmentId: string,
): Promise<string> {
  const normalizedZone = zone.trim().toLowerCase().replace(/^\.+|\.+$/gu, "");
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(
      normalizedZone,
    )
  ) {
    throw new Error("PAGENT_PUBLIC_ZONE must be a valid DNS name.");
  }
  const digest = (await sha256(environmentId))
    .toLowerCase()
    .replace(/[_-]/gu, "");
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
