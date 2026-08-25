import type { JsonValue } from "./types.js";

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encodeBase64Url(bytes: Uint8Array<ArrayBufferLike>): string {
  let result = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value =
      (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    result += BASE64URL_ALPHABET[(value >>> 18) & 63];
    result += BASE64URL_ALPHABET[(value >>> 12) & 63];
    if (second !== undefined) {
      result += BASE64URL_ALPHABET[(value >>> 6) & 63];
    }
    if (third !== undefined) {
      result += BASE64URL_ALPHABET[value & 63];
    }
  }

  return result;
}

export function decodeBase64Url(
  value: string,
  name: string,
): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new Error(`${name} must be unpadded base64url.`);
  }

  const bytes = new Uint8Array(Math.floor((value.length * 6) / 8));
  let offset = 0;
  let accumulator = 0;
  let bits = 0;

  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset] = (accumulator >>> bits) & 0xff;
      offset += 1;
    }
  }

  if (encodeBase64Url(bytes) !== value) {
    throw new Error(`${name} must be canonical unpadded base64url.`);
  }
  return bytes;
}

export function serializeJsonContext(value: unknown): string {
  assertJsonValue(value);
  return JSON.stringify(value);
}

export function parseJsonContext(value: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Decrypted Pagent context is not valid JSON.", { cause: error });
  }
  assertJsonValue(parsed);
  return parsed;
}

function assertJsonValue(
  value: unknown,
  path = "context",
  ancestors = new WeakSet<object>(),
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} contains a non-finite number.`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${path} contains a value JSON cannot preserve.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${path} contains a circular reference.`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain only plain objects and arrays.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new Error(`${path}[${index}] is an array hole.`);
        }
        assertJsonValue(value[index], `${path}[${index}]`, ancestors);
      }
      return;
    }

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        throw new Error(`${path} contains a symbol property.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor?.enumerable !== true) {
        continue;
      }
      assertJsonValue(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        ancestors,
      );
    }
  } finally {
    ancestors.delete(value);
  }
}
