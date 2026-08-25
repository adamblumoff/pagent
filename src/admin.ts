import { normalizeRelayUrl } from "./init.js";

const REQUEST_TIMEOUT_MS = 10_000;

interface EnrollmentCode {
  code: string;
  expiresAt: string;
}

interface AdminRequestOptions {
  relayUrl: string;
  adminToken: string;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

export async function createEnrollmentCode(
  options: AdminRequestOptions & {
    ttlMinutes: number;
    connectorId?: string | undefined;
  },
): Promise<EnrollmentCode> {
  if (
    !Number.isSafeInteger(options.ttlMinutes) ||
    options.ttlMinutes < 1 ||
    options.ttlMinutes > 1_440
  ) {
    throw new Error("Enrollment code lifetime must be from 1 to 1440 minutes.");
  }
  if (
    options.connectorId !== undefined &&
    (options.connectorId === "" ||
      options.connectorId !== options.connectorId.trim())
  ) {
    throw new Error("Connector ID must be a non-empty value without surrounding whitespace.");
  }
  const response = await adminFetch(
    options,
    "/v1/admin/enrollment-codes",
    {
      method: "POST",
      body: JSON.stringify({
        version: 1,
        expiresInSeconds: options.ttlMinutes * 60,
        ...(options.connectorId === undefined
          ? {}
          : { connectorId: options.connectorId }),
      }),
    },
  );
  const body = record(
    await responseJson(response, "create an enrollment code"),
  );
  if (
    body?.version !== 1 ||
    typeof body.code !== "string" ||
    !/^pge_[A-Za-z0-9_-]{43}$/u.test(body.code) ||
    typeof body.expiresAt !== "string" ||
    Number.isNaN(Date.parse(body.expiresAt))
  ) {
    throw new Error(
      "The relay returned an invalid enrollment-code response. Check that the relay is up to date.",
    );
  }
  return { code: body.code, expiresAt: body.expiresAt };
}

export async function revokeConnector(
  options: AdminRequestOptions & { connectorId: string },
): Promise<void> {
  if (
    options.connectorId === "" ||
    options.connectorId !== options.connectorId.trim() ||
    options.connectorId.includes("/")
  ) {
    throw new Error("Connector ID must be a non-empty path-safe value.");
  }
  const response = await adminFetch(
    options,
    `/v1/admin/connectors/${encodeURIComponent(options.connectorId)}`,
    { method: "DELETE" },
  );
  const body = record(await responseJson(response, "revoke the connector"));
  if (
    body?.status !== "revoked" ||
    body.connectorId !== options.connectorId
  ) {
    throw new Error(
      "The relay returned an invalid revocation response. Check that the relay is up to date.",
    );
  }
}

async function adminFetch(
  options: AdminRequestOptions,
  path: string,
  request: RequestInit,
): Promise<Response> {
  const relayUrl = normalizeRelayUrl(options.relayUrl);
  const adminToken = options.adminToken.trim();
  if (adminToken === "" || /[\r\n]/u.test(adminToken)) {
    throw new Error("Relay administrator token is required.");
  }
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Relay request timeout must be a positive integer.");
  }

  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(
      new URL(path, relayUrl),
      {
        ...request,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch {
    throw new Error(
      "Pagent could not reach the relay administrator endpoint. Check the relay URL and network connection.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `Relay administrator request failed with HTTP ${response.status}. Check the administrator token and relay configuration.`,
    );
  }
  return response;
}

async function responseJson(response: Response, action: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(
      `The relay did not return JSON when Pagent tried to ${action}.`,
    );
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
