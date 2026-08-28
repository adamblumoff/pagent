import { CloudflareApiError } from "./cloudflare.js";
import { secureTokenEquals, sha256 } from "./credentials.js";
import { ProvisionerStore } from "./storage.js";
import type { EnvironmentRecord } from "./types.js";

const MAX_BODY_BYTES = 1_024;
const MIN_ENROLLMENT_TTL_SECONDS = 60;
const MAX_ENROLLMENT_TTL_SECONDS = 86_400;
const environmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const idempotencyPattern = /^[\x21-\x7e]{8,128}$/u;
const enrollmentTokenPattern = /^pge_[A-Za-z0-9_-]{43}$/u;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function handleErrors(
  action: () => Promise<Response>,
): Promise<Response> {
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

export async function requireAdmin(
  request: Request,
  expected: string,
): Promise<void> {
  const token = bearerToken(request);
  if (!token || !(await secureTokenEquals(token, expected))) {
    throw new HttpError(
      401,
      "unauthorized",
      "Administrator credential is invalid.",
    );
  }
}

export function requireEnrollmentToken(request: Request): string {
  const token = bearerToken(request);
  if (!token || !enrollmentTokenPattern.test(token)) {
    throw new HttpError(
      401,
      "unauthorized",
      "Enrollment credential is invalid.",
    );
  }
  return token;
}

export async function requireManagedEnvironment(
  request: Request,
  store: ProvisionerStore,
  environmentId: string,
): Promise<EnvironmentRecord> {
  const existing = await store.getEnvironment(environmentId);
  if (!existing) {
    throw new HttpError(
      404,
      "environment_not_found",
      "Environment not found.",
    );
  }
  const token = bearerToken(request);
  if (
    !token ||
    !(await secureTokenEquals(await sha256(token), existing.managementTokenHash))
  ) {
    throw new HttpError(
      401,
      "unauthorized",
      "Management credential is invalid.",
    );
  }
  return existing;
}

export async function parseEnvironmentBody(request: Request): Promise<{
  environmentId: string;
  originPort: number;
}> {
  const body = await parseJsonBody(request);
  if (body.version !== 1) {
    throw new HttpError(400, "invalid_version", "Request version must be 1.");
  }
  if (
    typeof body.environmentId !== "string" ||
    !environmentPattern.test(body.environmentId)
  ) {
    throw new HttpError(
      400,
      "invalid_environment_id",
      "Environment ID is invalid.",
    );
  }
  return {
    environmentId: body.environmentId,
    originPort: parseOriginPort(body.originPort),
  };
}

export async function parseEnrollmentTokenBody(
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

export async function parseRotateBody(
  request: Request,
): Promise<{ originPort: number }> {
  const body = await parseJsonBody(request);
  if (body.version !== 1) {
    throw new HttpError(400, "invalid_version", "Request version must be 1.");
  }
  return { originPort: parseOriginPort(body.originPort) };
}

export function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key") ?? "";
  if (!idempotencyPattern.test(key)) {
    throw new HttpError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must contain 8 to 128 visible ASCII characters.",
    );
  }
  return key;
}

export function decodeEnvironmentId(segment: string | undefined): string {
  if (!segment) throw new HttpError(404, "not_found", "Route not found.");
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    throw new HttpError(
      400,
      "invalid_environment_id",
      "Environment ID is invalid.",
    );
  }
  if (!environmentPattern.test(value)) {
    throw new HttpError(
      400,
      "invalid_environment_id",
      "Environment ID is invalid.",
    );
  }
  return value;
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function parseJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  ) {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
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
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(
      400,
      "invalid_json",
      "Request body must be a JSON object.",
    );
  }
}

function parseOriginPort(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 65_535
  ) {
    throw new HttpError(
      400,
      "invalid_origin_port",
      "Origin port must be an integer from 1 to 65535.",
    );
  }
  return value as number;
}

function bearerToken(request: Request): string | undefined {
  const match = /^Bearer ([^\s]+)$/u.exec(
    request.headers.get("authorization") ?? "",
  );
  return match?.[1];
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { version: 1, error: { code, message } });
}
