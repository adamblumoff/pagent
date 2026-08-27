import { createPagent, defineEvent } from "../../dist/index.js";

const received = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    received.push(await request.json());
    return new Response(null, { status: 202 });
  },
});

try {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = btoa(String.fromCharCode(...keyBytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  const pagent = createPagent({
    enabled: true,
    environment: "staging",
    endpoint: {
      url: `http://127.0.0.1:${server.port}/v1/events`,
      token: "bun-source-token",
    },
    encryption: { keyId: "bun-smoke", key },
  });
  const observed = pagent.observe(
    () => ({ status: "unhealthy", reason: "bun sentinel" }),
    {
      event: defineEvent({ name: "health.failed" }),
      on: "result",
      triggerWhen: ({ result }) => result.status === "unhealthy",
      context: ({ result }) => ({ reason: result.reason }),
    },
  );

  const result = observed();
  await pagent.flush();

  if (result.reason !== "bun sentinel") {
    throw new Error("The observed Bun result changed.");
  }
  if (received.length !== 1 || received[0]?.version !== 2) {
    throw new Error("Bun did not deliver one envelope v2 event.");
  }
  const serialized = JSON.stringify(received[0]);
  if (serialized.includes("bun sentinel") || !received[0]?.event?.context?.ciphertext) {
    throw new Error("Bun sent plaintext context instead of ciphertext.");
  }
} finally {
  server.stop(true);
}
