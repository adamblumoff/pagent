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
