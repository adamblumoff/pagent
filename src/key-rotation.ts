import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

import { parseConnectorKeyring } from "./config.js";

type RotationFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Pick<Response, "json" | "ok" | "status">>;

export async function readExistingContextKeys(
  path: string,
): Promise<Record<string, string>> {
  const invalid = () =>
    new Error(
      `Pagent cannot rotate credentials because ${path} does not contain a valid PAGENT_CONTEXT_KEYS keyring. Restore that file or revoke the connector before initializing again.`,
    );
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw invalid();
  }

  let serialized: string | undefined;
  try {
    serialized = parseEnv(contents).PAGENT_CONTEXT_KEYS;
  } catch {
    throw invalid();
  }
  if (serialized === undefined) throw invalid();

  try {
    return { ...parseConnectorKeyring(JSON.parse(serialized)) };
  } catch {
    throw invalid();
  }
}

export async function retireUnusedContextKeys(
  input: {
    relayUrl: string;
    connectorId: string;
    connectorToken: string;
    keys: Readonly<Record<string, string>>;
  },
  fetchRetirement: RotationFetch,
  timeoutMs: number,
): Promise<Record<string, string>> {
  const retained: Record<string, string> = {};
  for (const [keyId, key] of Object.entries(input.keys)) {
    let response: Pick<Response, "json" | "ok" | "status">;
    try {
      response = await fetchRetirement(
        new URL(
          `/v1/connectors/${encodeURIComponent(input.connectorId)}/context-keys/${encodeURIComponent(keyId)}`,
          input.relayUrl,
        ),
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${input.connectorToken}` },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch {
      throw new Error(
        "Pagent could not confirm which old encryption keys are safe to remove. Check the relay connection, then retry the same `pagent init --reset` command and enrollment code.",
      );
    }

    if (response.status === 404 || response.status === 409) {
      retained[keyId] = key;
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Relay key retirement failed with HTTP ${response.status}. Retry the same \`pagent init --reset\` command and enrollment code.`,
      );
    }

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw invalidRetirementResponse(response.status);
    }
    const value = record(result);
    if (value?.status !== "retired" || value.keyId !== keyId) {
      throw invalidRetirementResponse(response.status);
    }
  }
  return retained;
}

function invalidRetirementResponse(status: number): Error {
  return new Error(
    `Relay key retirement returned an invalid response with HTTP ${status}. Retry the same \`pagent init --reset\` command and enrollment code.`,
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
