import { sha256 } from "./credentials.js";
import {
  createCloudflareApi,
  createEnrollmentToken,
  processEnrollment,
  revokeEnvironment,
  rotateEnvironment,
} from "./environment-operations.js";
import {
  decodeEnvironmentId,
  handleErrors,
  HttpError,
  parseEnrollmentTokenBody,
  parseRotateBody,
  requireAdmin,
  requireEnrollmentToken,
  requireIdempotencyKey,
  requireManagedEnvironment,
} from "./http.js";
import { ProvisionerStore } from "./storage.js";
import type {
  ProvisionerDependencies,
  ProvisionerEnv,
} from "./types.js";

export function createProvisioner(
  dependencies: ProvisionerDependencies = {},
) {
  return {
    async fetch(request: Request, env: ProvisionerEnv): Promise<Response> {
      return handleErrors(() => route(request, env, dependencies));
    },
  };
}

async function route(
  request: Request,
  env: ProvisionerEnv,
  dependencies: ProvisionerDependencies,
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
    const tokenHash = await sha256(requireEnrollmentToken(request));
    const id = env.PAGENT_ENROLLMENT_LOCKS.idFromName(tokenHash);
    return env.PAGENT_ENROLLMENT_LOCKS.get(id).fetch(request);
  }

  const cloudflare = createCloudflareApi(env, dependencies);
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
    const existing = await requireManagedEnvironment(
      request,
      store,
      environmentId,
    );
    if (isRotate) {
      const body = await parseRotateBody(request);
      const idempotencyKey = requireIdempotencyKey(request);
      return rotateEnvironment(
        env,
        store,
        cloudflare,
        existing,
        body.originPort,
        idempotencyKey,
      );
    }
    const idempotencyKey = requireIdempotencyKey(request);
    return revokeEnvironment(store, cloudflare, existing, idempotencyKey);
  }

  throw new HttpError(404, "not_found", "Route not found.");
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
    throw new Error(
      `Pagent provisioner bindings are incomplete: ${missing.join(", ")}.`,
    );
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

export class EnrollmentTokenLock {
  readonly #env: ProvisionerEnv;
  readonly #dependencies: ProvisionerDependencies;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    _state: unknown,
    env: ProvisionerEnv,
    dependencies: ProvisionerDependencies = {},
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
      return await handleErrors(() => {
        validateEnv(this.#env);
        return processEnrollment(request, this.#env, this.#dependencies);
      });
    } finally {
      release();
    }
  }
}

export default createProvisioner();
