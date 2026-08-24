import {
  codexAgent,
  createPagent,
  defineEvent,
} from "../src/index.js";
import { checkHealth, type HealthResult } from "./health.js";

const healthFailed = defineEvent<HealthResult>({
  name: "health.failed",
  enabledIn: ["staging"],
  cooldownMs: 60_000,
  prompt: (event) => `
A staging health check reported unhealthy in this repository.

Event: ${event.type}
Environment: ${event.environment}
Observed latency: ${event.payload.latencyMs}ms
Healthy threshold: ${event.payload.thresholdMs}ms

Inspect demo/health.ts and explain whether this result follows its configured
threshold. This is a simulated incident, so do not change files.
`.trim(),
});

const pagent = createPagent({
  enabled: process.env.PAGENT_ENABLED === "true",
  environment: process.env.PAGENT_ENV,
  cwd: process.cwd(),
  agent: codexAgent(),
  onError: (error) => console.error("[pagent] agent run failed", error),
  onAgentResult: (result, event) => {
    console.log(
      `[pagent] ${event.type} opened ${result.threadId ?? "an unknown thread"}`,
    );
    if (result.finalResponse !== undefined) {
      console.log(result.finalResponse);
    }
  },
});

const observedHealthCheck = pagent.observe(checkHealth, {
  event: healthFailed,
  when: ({ result }) => result.status === "unhealthy",
  context: ({ result }) => result,
});

const latencyMs = readPositiveNumber("SIMULATED_LATENCY_MS", 750);
const thresholdMs = readPositiveNumber("HEALTH_THRESHOLD_MS", 500);
const pollMs = readPositiveNumber("HEALTH_POLL_MS", 5_000);

function pollHealth(): void {
  const health = observedHealthCheck(latencyMs, thresholdMs);
  console.log(
    `[demo] ${health.status}: ${health.latencyMs}ms (threshold ${health.thresholdMs}ms)`,
  );
}

function readPositiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function shutdown(): Promise<void> {
  clearInterval(timer);
  await pagent.drain();
  process.exit(0);
}

console.log(
  `[demo] environment=${process.env.PAGENT_ENV ?? "unset"} enabled=${process.env.PAGENT_ENABLED === "true"}`,
);
pollHealth();
const timer = setInterval(pollHealth, pollMs);

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
