import { loadConfig } from "./config.js";
import { PostgresRelayStore } from "./postgres-store.js";
import { createRelayServer } from "./server.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const config = loadConfig();
const store = new PostgresRelayStore(databaseUrl);
await store.initialize();

const server = createRelayServer({ config, store });
server.listen(config.port, "0.0.0.0", () => {
  console.log(`Pagent relay listening on port ${config.port}`);
});

let shuttingDown = false;
async function shutDown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await store.close();
}

process.once("SIGTERM", () => void shutDown());
process.once("SIGINT", () => void shutDown());
