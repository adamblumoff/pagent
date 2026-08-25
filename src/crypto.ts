import {
  decodeBase64Url,
  encodeBase64Url,
  parseJsonContext,
  serializeJsonContext,
} from "./encoding.js";
import type {
  EncryptedContext,
  JsonValue,
  PagentEncryptionOptions,
  PagentEventMetadata,
} from "./types.js";

const AES_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

export type EventContextEncryptor = (
  metadata: PagentEventMetadata,
  payload: unknown,
) => Promise<EncryptedContext>;

export type EventContextDecryptor = <
  TPayload extends JsonValue = JsonValue,
>(
  metadata: PagentEventMetadata,
  context: EncryptedContext,
) => Promise<TPayload>;

export function createEventContextEncryptor(
  options: PagentEncryptionOptions,
): EventContextEncryptor {
  const keyId = encryptionKeyId(options.keyId);
  const rawKey = decodeEncryptionKey(options.key);
  let key: Promise<CryptoKey> | undefined;

  return async (metadata, payload) => {
    key ??= importEncryptionKey(rawKey);
    return encryptWithKey(metadata, payload, keyId, await key);
  };
}

export function createEventContextDecryptor(
  base64UrlKey: string,
): EventContextDecryptor {
  const rawKey = decodeEncryptionKey(base64UrlKey);
  let key: Promise<CryptoKey> | undefined;

  return async <TPayload extends JsonValue = JsonValue>(
    metadata: PagentEventMetadata,
    context: EncryptedContext,
  ): Promise<TPayload> => {
    key ??= importEncryptionKey(rawKey);
    return decryptWithKey<TPayload>(metadata, context, await key);
  };
}

export async function encryptEventContext(
  metadata: PagentEventMetadata,
  payload: unknown,
  options: PagentEncryptionOptions,
): Promise<EncryptedContext> {
  const keyId = encryptionKeyId(options.keyId);
  const key = await importEncryptionKey(decodeEncryptionKey(options.key));
  return encryptWithKey(metadata, payload, keyId, key);
}

async function encryptWithKey(
  metadata: PagentEventMetadata,
  payload: unknown,
  keyId: string,
  key: CryptoKey,
): Promise<EncryptedContext> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const plaintext = textEncoder.encode(serializeJsonContext(payload));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: eventAdditionalData(metadata, keyId),
    },
    key,
    plaintext,
  );

  return {
    algorithm: "A256GCM",
    keyId,
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptEventContext<
  TPayload extends JsonValue = JsonValue,
>(
  metadata: PagentEventMetadata,
  context: EncryptedContext,
  base64UrlKey: string,
): Promise<TPayload> {
  const key = await importEncryptionKey(decodeEncryptionKey(base64UrlKey));
  return decryptWithKey<TPayload>(metadata, context, key);
}

async function decryptWithKey<TPayload extends JsonValue>(
  metadata: PagentEventMetadata,
  context: EncryptedContext,
  key: CryptoKey,
): Promise<TPayload> {
  if (context.algorithm !== "A256GCM") {
    throw new Error(`Unsupported Pagent context algorithm ${context.algorithm}.`);
  }
  const keyId = encryptionKeyId(context.keyId);
  const iv = decodeBase64Url(context.iv, "Pagent context IV");
  if (iv.byteLength !== AES_GCM_IV_BYTES) {
    throw new Error(`Pagent context IV must be ${AES_GCM_IV_BYTES} bytes.`);
  }
  const ciphertext = decodeBase64Url(
    context.ciphertext,
    "Pagent context ciphertext",
  );
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: eventAdditionalData(metadata, keyId),
      },
      key,
      ciphertext,
    );
  } catch (error) {
    throw new Error(
      `Pagent could not decrypt context encrypted with key ${keyId}.`,
      { cause: error },
    );
  }

  let decoded: string;
  try {
    decoded = textDecoder.decode(plaintext);
  } catch (error) {
    throw new Error("Decrypted Pagent context is not valid UTF-8.", {
      cause: error,
    });
  }
  return parseJsonContext(decoded) as TPayload;
}

function eventAdditionalData(
  metadata: PagentEventMetadata,
  keyId: string,
): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(
    JSON.stringify([
      "pagent.event",
      2,
      keyId,
      metadata.id,
      metadata.type,
      metadata.environment,
      metadata.occurredAt,
      metadata.investigation.cooldownMs,
      metadata.investigation.group ?? null,
    ]),
  );
}

function decodeEncryptionKey(
  base64UrlKey: string,
): Uint8Array<ArrayBuffer> {
  const rawKey = decodeBase64Url(base64UrlKey, "Pagent encryption key");
  if (rawKey.byteLength !== AES_KEY_BYTES) {
    throw new Error(
      `Pagent encryption key must decode to ${AES_KEY_BYTES} bytes.`,
    );
  }
  return rawKey;
}

async function importEncryptionKey(
  rawKey: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function encryptionKeyId(value: string): string {
  const keyId = value.trim();
  if (keyId === "" || keyId !== value || keyId.length > 200) {
    throw new Error(
      "Pagent encryption keyId must be a trimmed, non-empty string up to 200 characters.",
    );
  }
  return keyId;
}
