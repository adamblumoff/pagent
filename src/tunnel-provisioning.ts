const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 64 * 1024;

export type TunnelProvisioningErrorCode =
  | "aborted"
  | "http"
  | "invalid_response"
  | "network"
  | "timeout";

export class TunnelProvisioningError extends Error {
  readonly code: TunnelProvisioningErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    options: {
      code: TunnelProvisioningErrorCode;
      retryable: boolean;
      statusCode?: number | undefined;
    },
  ) {
    super(message);
    this.name = "TunnelProvisioningError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.statusCode = options.statusCode;
  }
}

export interface TunnelProvisioningClientOptions {
  /** HTTPS origin for the Pagent provisioning service. */
  serviceUrl: string;
  fetch?: typeof globalThis.fetch | undefined;
  timeoutMs?: number | undefined;
}

export interface ProvisionedTunnel {
  environmentId: string;
  tunnelId: string;
  /** HTTPS origin. Append `/v1/events` when configuring the application SDK. */
  eventOrigin: string;
  tunnelToken: string;
  /** Scoped to this environment. It is not a Cloudflare account credential. */
  managementToken: string;
  status: "created" | "resumed" | "rotated";
}

export interface TunnelProbeResult {
  environmentId: string;
  status: "ready";
}

export interface EnrollmentToken {
  token: string;
  expiresAt: string;
}

interface RequestOptions {
  token: string;
  idempotencyKey?: string | undefined;
  method: "DELETE" | "POST";
  body?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Talks only to Pagent's provisioning service. Cloudflare account credentials
 * belong in that service and are never accepted by this client.
 */
export class TunnelProvisioningClient {
  readonly #serviceOrigin: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: TunnelProvisioningClientOptions) {
    this.#serviceOrigin = provisioningOrigin(options.serviceUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Provisioning request timeout",
    );
  }

  async createEnrollmentToken(input: {
    adminToken: string;
    expiresInSeconds: number;
    signal?: AbortSignal | undefined;
  }): Promise<EnrollmentToken> {
    const expiresInSeconds = enrollmentTtl(input.expiresInSeconds);
    const response = await this.#request(
      "create an enrollment token",
      "/v1/admin/enrollment-tokens",
      {
        method: "POST",
        token: secret(input.adminToken, "Provisioner admin token"),
        body: JSON.stringify({ version: 1, expiresInSeconds }),
        signal: input.signal,
      },
    );
    return enrollmentToken(
      await responseJson(response, "create an enrollment token"),
    );
  }

  async createOrResume(input: {
    environmentId: string;
    enrollmentToken: string;
    idempotencyKey: string;
    originPort: number;
    signal?: AbortSignal | undefined;
  }): Promise<ProvisionedTunnel> {
    const environmentId = pathIdentifier(input.environmentId, "Environment ID");
    const idempotencyKey = requestId(input.idempotencyKey);
    const originPort = port(input.originPort);
    const response = await this.#request("create or resume the tunnel", "/v1/environments", {
      method: "POST",
      token: secret(input.enrollmentToken, "Enrollment token"),
      idempotencyKey,
      body: JSON.stringify({
        version: 1,
        environmentId,
        originPort,
      }),
      signal: input.signal,
    });
    return provisionedTunnel(
      await responseJson(response, "create or resume the tunnel"),
      environmentId,
      ["created", "resumed"],
    );
  }

  async rotate(input: {
    environmentId: string;
    managementToken: string;
    idempotencyKey: string;
    originPort: number;
    signal?: AbortSignal | undefined;
  }): Promise<ProvisionedTunnel> {
    const environmentId = pathIdentifier(input.environmentId, "Environment ID");
    const managementToken = secret(input.managementToken, "Management token");
    const idempotencyKey = requestId(input.idempotencyKey);
    const originPort = port(input.originPort);
    const response = await this.#request(
      "rotate the tunnel credentials",
      `/v1/environments/${encodeURIComponent(environmentId)}/rotate`,
      {
        method: "POST",
        token: managementToken,
        idempotencyKey,
        body: JSON.stringify({ version: 1, originPort }),
        signal: input.signal,
      },
    );
    return provisionedTunnel(
      await responseJson(response, "rotate the tunnel credentials"),
      environmentId,
      ["rotated"],
    );
  }

  async delete(input: {
    environmentId: string;
    managementToken: string;
    idempotencyKey: string;
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const environmentId = pathIdentifier(input.environmentId, "Environment ID");
    await this.#request(
      "delete the tunnel",
      `/v1/environments/${encodeURIComponent(environmentId)}`,
      {
        method: "DELETE",
        token: secret(input.managementToken, "Management token"),
        idempotencyKey: requestId(input.idempotencyKey),
        signal: input.signal,
      },
      true,
    );
  }

  async probe(input: {
    environmentId: string;
    eventOrigin: string;
    sourceToken: string;
    body: string;
    signal?: AbortSignal | undefined;
  }): Promise<TunnelProbeResult> {
    const environmentId = pathIdentifier(input.environmentId, "Environment ID");
    const eventOrigin = httpsOrigin(input.eventOrigin, "Tunnel event origin");
    const body = probeBody(input.body);
    const response = await this.#requestAt(
      "check the tunnel",
      new URL("/v1/probe", eventOrigin),
      {
        method: "POST",
        token: secret(input.sourceToken, "Source token"),
        body,
        signal: input.signal,
      },
    );
    return tunnelProbe(
      await responseJson(response, "check the tunnel"),
      environmentId,
    );
  }

  async #request(
    action: string,
    path: string,
    options: RequestOptions,
    allowMissing = false,
  ): Promise<Response> {
    return this.#requestAt(
      action,
      new URL(path, this.#serviceOrigin),
      options,
      allowMissing,
    );
  }

  async #requestAt(
    action: string,
    url: URL,
    options: RequestOptions,
    allowMissing = false,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal === undefined
      ? timeoutSignal
      : AbortSignal.any([options.signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: options.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(options.idempotencyKey === undefined
            ? {}
            : { "idempotency-key": options.idempotencyKey }),
        },
        ...(options.body === undefined ? {} : { body: options.body }),
        signal,
      });
    } catch {
      if (options.signal?.aborted === true) {
        throw requestError(action, "aborted", false);
      }
      if (timeoutSignal.aborted) {
        throw requestError(action, "timeout", true);
      }
      throw requestError(action, "network", true);
    }

    if (allowMissing && response.status === 404) return response;
    if (!response.ok) {
      throw new TunnelProvisioningError(
        `Pagent could not ${action}. The remote endpoint returned HTTP ${response.status}.`,
        {
          code: "http",
          retryable: retryableStatus(response.status),
          statusCode: response.status,
        },
      );
    }
    return response;
  }
}

async function responseJson(response: Response, action: string): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw invalidResponse(action, response.status);
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw invalidResponse(action, response.status);
  }
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) {
    throw invalidResponse(action, response.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse(action, response.status);
  }
}

function provisionedTunnel(
  value: unknown,
  expectedEnvironmentId: string,
  expectedStatuses: readonly ProvisionedTunnel["status"][],
): ProvisionedTunnel {
  const body = record(value);
  const environmentId = body?.environmentId;
  const tunnelId = body?.tunnelId;
  const tunnelToken = body?.tunnelToken;
  const managementToken = body?.managementToken;
  const status = body?.status;
  if (
    body?.version !== 1 ||
    environmentId !== expectedEnvironmentId ||
    !trimmedString(tunnelId, 200) ||
    !trimmedString(tunnelToken, 16_384) ||
    !trimmedString(managementToken, 16_384) ||
    /[\r\n]/u.test(tunnelToken) ||
    /[\r\n]/u.test(managementToken) ||
    typeof status !== "string" ||
    !expectedStatuses.includes(status as ProvisionedTunnel["status"])
  ) {
    throw invalidResponse("read the tunnel credentials");
  }

  let eventOrigin: string;
  try {
    eventOrigin = hostnameOrigin(body.hostname);
  } catch {
    throw invalidResponse("read the tunnel credentials");
  }
  return {
    environmentId,
    tunnelId,
    eventOrigin,
    tunnelToken,
    managementToken,
    status: status as ProvisionedTunnel["status"],
  };
}

function tunnelProbe(
  value: unknown,
  expectedEnvironmentId: string,
): TunnelProbeResult {
  const body = record(value);
  if (
    body?.version !== 1 ||
    body.environmentId !== expectedEnvironmentId ||
    body.status !== "ready"
  ) {
    throw invalidResponse("read the tunnel probe");
  }
  return {
    environmentId: body.environmentId,
    status: "ready",
  };
}

function enrollmentToken(value: unknown): EnrollmentToken {
  const body = record(value);
  if (
    body?.version !== 1 ||
    !trimmedString(body.token, 16_384) ||
    /[\r\n]/u.test(body.token) ||
    !trimmedString(body.expiresAt, 100) ||
    !Number.isFinite(Date.parse(body.expiresAt))
  ) {
    throw invalidResponse("read the enrollment token");
  }
  return { token: body.token, expiresAt: body.expiresAt };
}

function requestError(
  action: string,
  code: "aborted" | "network" | "timeout",
  retryable: boolean,
): TunnelProvisioningError {
  const reason = code === "timeout"
      ? "The request timed out."
      : code === "aborted"
        ? "The request was cancelled."
      : "Check the network connection and configured URL.";
  return new TunnelProvisioningError(
    `Pagent could not ${action}. ${reason}`,
    { code, retryable },
  );
}

function invalidResponse(action: string, statusCode?: number): TunnelProvisioningError {
  return new TunnelProvisioningError(
    `Pagent could not ${action}. The remote endpoint returned an invalid response.`,
    {
      code: "invalid_response",
      retryable: true,
      ...(statusCode === undefined ? {} : { statusCode }),
    },
  );
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function httpsOrigin(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be an HTTPS origin.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS origin.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${name} must be an HTTPS origin.`);
  }
  return url.origin;
}

function provisioningOrigin(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Provisioning service URL must be an HTTPS origin.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Provisioning service URL must be an HTTPS origin.");
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "localhost";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Provisioning service URL must be an HTTPS origin.");
  }
  return url.origin;
}

function hostnameOrigin(value: unknown): string {
  if (!trimmedString(value, 253) || value.includes(":")) {
    throw new Error("Tunnel hostname is invalid.");
  }
  const origin = httpsOrigin(`https://${value}`, "Tunnel hostname");
  if (new URL(origin).hostname !== value.toLowerCase()) {
    throw new Error("Tunnel hostname is invalid.");
  }
  return origin;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function enrollmentTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < 60 || value > 86_400) {
    throw new Error("Enrollment token lifetime must be an integer from 60 to 86400 seconds.");
  }
  return value;
}

function port(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("Tunnel origin port must be an integer from 1 to 65535.");
  }
  return value;
}

function probeBody(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Tunnel probe body must contain an encrypted event envelope.");
  }
  if (Buffer.byteLength(value) > MAX_JSON_BYTES) {
    throw new Error("Tunnel probe body must not exceed 64 KB.");
  }
  return value;
}

function pathIdentifier(value: string, name: string): string {
  if (!trimmedString(value, 200) || value.includes("/")) {
    throw new Error(`${name} must be a non-empty path-safe value.`);
  }
  return value;
}

function requestId(value: string): string {
  if (!trimmedString(value, 200) || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new Error(
      "Provisioning idempotency key must be a path-safe value up to 200 characters.",
    );
  }
  return value;
}

function secret(value: string, name: string): string {
  if (!trimmedString(value, 16_384) || /[\r\n]/u.test(value)) {
    throw new Error(`${name} must be a non-empty value without surrounding whitespace.`);
  }
  return value;
}

function trimmedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <= maxLength;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
