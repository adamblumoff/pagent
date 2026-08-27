export interface KvNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

export interface DurableObjectId {}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface ProvisionerEnv {
  PAGENT_ENVIRONMENTS: KvNamespace;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_ZONE_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  PAGENT_PUBLIC_ZONE: string;
  PAGENT_PROVISIONER_ADMIN_TOKEN: string;
  PAGENT_CREDENTIAL_SECRET: string;
  PAGENT_ENROLLMENT_LOCKS: DurableObjectNamespace;
  CLOUDFLARE_API_BASE_URL?: string;
}

export type LifecycleStatus = "active" | "revoked";

export interface EnvironmentRecord {
  version: 1;
  environmentId: string;
  tunnelId: string;
  hostname: string;
  dnsRecordId: string;
  originPort: number;
  managementTokenHash: string;
  tunnelTokenHash: string;
  lifecycleStatus: LifecycleStatus;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export interface IdempotencyRecord {
  version: 1;
  requestHash: string;
  responseStatus: "created" | "resumed" | "rotated" | "revoked";
  completedAt: string;
}

export interface EnrollmentTokenRecord {
  version: 1;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  consumedEnvironmentId?: string;
  consumedIdempotencyKey?: string;
}
