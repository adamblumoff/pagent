import { buildApp } from "./app.js";
import { pagentOptions } from "../../shared/service.js";

const app = buildApp(
  pagentOptions({
    enabled: process.env.PAGENT_ENABLED,
    environment: process.env.PAGENT_ENV,
    encryptionKey: process.env.PAGENT_ENCRYPTION_KEY,
    encryptionKeyId: process.env.PAGENT_ENCRYPTION_KEY_ID,
    relayToken: process.env.PAGENT_RELAY_TOKEN,
    relayUrl: process.env.PAGENT_RELAY_URL,
  }),
);

await app.listen({
  host: "127.0.0.1",
  port: positivePort(process.env.PORT),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => process.exit(0));
  });
}

function positivePort(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}
