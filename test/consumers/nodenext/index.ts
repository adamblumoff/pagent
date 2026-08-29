import { createPagent, defineEvent } from "../../../dist/index.js";

interface HealthContext {
  reason: string;
  attempts: number;
}

const event = defineEvent<HealthContext>({ name: "health.failed" });
const pagent = createPagent({ enabled: false });
const observed = pagent.observe(
  async (attempts: number) => ({ attempts, healthy: false }),
  {
    event,
    on: "result",
    triggerWhen: ({ result }) => !result.healthy,
    context: ({ result }) => ({
      reason: "probe failed",
      attempts: result.attempts,
    }),
  },
);

void observed(2);

const observedRequest = pagent.observe(
  async (status: number) => {
    if (status >= 500) throw new Error("request failed");
    return { status };
  },
  {
    event,
    on: ["result", "error"],
    triggerWhen: (observation) =>
      observation.kind === "error" || observation.result.status >= 500,
    context: (observation) => ({
      reason:
        observation.kind === "error" ? "request failed" : "bad response",
      attempts: 1,
    }),
  },
);

void observedRequest(200);
