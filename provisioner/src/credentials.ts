const encoder = new TextEncoder();

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

export async function deriveManagementToken(
  secret: string,
  environmentId: string,
): Promise<string> {
  const signature = await hmac(
    secret,
    `pagent.management.v1\n${environmentId}`,
  );
  return `pgm_${encodeBase64Url(signature)}`;
}

export async function deriveTunnelSecret(
  secret: string,
  environmentId: string,
  idempotencyKey: string,
): Promise<string> {
  const signature = await hmac(
    secret,
    `pagent.tunnel-rotation.v1\n${environmentId}\n${idempotencyKey}`,
  );
  return encodeBase64(signature);
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  if (secret.length < 32) {
    throw new Error("PAGENT_CREDENTIAL_SECRET must be at least 32 characters.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );
  return new Uint8Array(signature);
}

export async function secureTokenEquals(
  candidate: string,
  expected: string,
): Promise<boolean> {
  const [candidateHash, expectedHash] = await Promise.all([
    sha256(candidate),
    sha256(expected),
  ]);
  let difference = candidateHash.length ^ expectedHash.length;
  const length = Math.max(candidateHash.length, expectedHash.length);
  for (let index = 0; index < length; index += 1) {
    difference |=
      (candidateHash.charCodeAt(index) || 0) ^
      (expectedHash.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function randomEnrollmentToken(): string {
  return `pge_${encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
