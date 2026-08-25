import { createPagent, defineEvent } from "../../../dist/index.js";

const event = defineEvent<{ reason: string }>({ name: "deno.failed" });
const pagent = createPagent({ enabled: false });
const observed = pagent.observe(
  async () => ({ ok: false, reason: "dependency unavailable" }),
  {
    event,
    on: "result",
    triggerWhen: ({ result }) => !result.ok,
    context: ({ result }) => ({ reason: result.reason }),
  },
);

await observed();
