import type {
  ConnectorCredential,
  RelayConfig,
  SourceRoute,
} from "./types.js";

function required(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) {
    throw new Error(`${name} is required`);
  }
  return result;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return result;
}

function stringArray(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.trim() === "")
  ) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return value.map((item) => (item as string).trim());
}

function parseJsonArray(value: string, name: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${name} must be a non-empty JSON array`);
  }
  return parsed;
}

function sourcesFromEnvironment(env: NodeJS.ProcessEnv): SourceRoute[] {
  if (env.PAGENT_SOURCES_JSON) {
    return parseJsonArray(env.PAGENT_SOURCES_JSON, "PAGENT_SOURCES_JSON").map(
      (value, index) => {
        if (typeof value !== "object" || value === null) {
          throw new Error(`PAGENT_SOURCES_JSON[${index}] must be an object`);
        }
        const item = value as Record<string, unknown>;
        return {
          token: requiredString(item.token, `PAGENT_SOURCES_JSON[${index}].token`),
          repositoryKey: requiredString(
            item.repositoryKey,
            `PAGENT_SOURCES_JSON[${index}].repositoryKey`,
          ),
          connectorId: requiredString(
            item.connectorId,
            `PAGENT_SOURCES_JSON[${index}].connectorId`,
          ),
          allowedEnvironments: stringArray(
            item.allowedEnvironments,
            `PAGENT_SOURCES_JSON[${index}].allowedEnvironments`,
          ),
        };
      },
    );
  }

  return [
    {
      token: required(env.PAGENT_SOURCE_TOKEN, "PAGENT_SOURCE_TOKEN"),
      repositoryKey: required(
        env.PAGENT_REPOSITORY_KEY,
        "PAGENT_REPOSITORY_KEY",
      ),
      connectorId: required(env.PAGENT_CONNECTOR_ID, "PAGENT_CONNECTOR_ID"),
      allowedEnvironments: required(
        env.PAGENT_ALLOWED_ENVIRONMENTS,
        "PAGENT_ALLOWED_ENVIRONMENTS",
      )
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    },
  ];
}

function connectorsFromEnvironment(env: NodeJS.ProcessEnv): ConnectorCredential[] {
  if (env.PAGENT_CONNECTORS_JSON) {
    return parseJsonArray(
      env.PAGENT_CONNECTORS_JSON,
      "PAGENT_CONNECTORS_JSON",
    ).map((value, index) => {
      if (typeof value !== "object" || value === null) {
        throw new Error(`PAGENT_CONNECTORS_JSON[${index}] must be an object`);
      }
      const item = value as Record<string, unknown>;
      return {
        id: requiredString(item.id, `PAGENT_CONNECTORS_JSON[${index}].id`),
        token: requiredString(
          item.token,
          `PAGENT_CONNECTORS_JSON[${index}].token`,
        ),
      };
    });
  }

  return [
    {
      id: required(env.PAGENT_CONNECTOR_ID, "PAGENT_CONNECTOR_ID"),
      token: required(env.PAGENT_CONNECTOR_TOKEN, "PAGENT_CONNECTOR_TOKEN"),
    },
  ];
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return required(value, name);
}

function assertUnique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${name} values must be unique`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const sources = sourcesFromEnvironment(env);
  const connectors = connectorsFromEnvironment(env);
  assertUnique(
    sources.map((source) => source.token),
    "source token",
  );
  assertUnique(
    connectors.map((connector) => connector.id),
    "connector id",
  );
  assertUnique(
    connectors.map((connector) => connector.token),
    "connector token",
  );

  const connectorIds = new Set(connectors.map((connector) => connector.id));
  for (const source of sources) {
    if (!connectorIds.has(source.connectorId)) {
      throw new Error(
        `source for ${source.repositoryKey} references unknown connector ${source.connectorId}`,
      );
    }
    if (source.allowedEnvironments.length === 0) {
      throw new Error(
        `source for ${source.repositoryKey} needs at least one allowed environment`,
      );
    }
  }

  return {
    port: positiveInteger(env.PORT, 3000, "PORT"),
    heartbeatMs: positiveInteger(
      env.PAGENT_SSE_HEARTBEAT_MS,
      15_000,
      "PAGENT_SSE_HEARTBEAT_MS",
    ),
    sources,
    connectors,
  };
}
