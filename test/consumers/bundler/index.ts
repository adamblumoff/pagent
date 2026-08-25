import { createPagent, defineEvent } from "../../../dist/index.js";

type QueueContext = {
  queue: string;
  depth: number;
};

const event = defineEvent<QueueContext>({ name: "queue.backed_up" });
const pagent = createPagent({ enabled: false });
const observed = pagent.observe(
  (queue: string, depth: number) => ({ queue, depth }),
  {
    event,
    on: "result",
    triggerWhen: ({ result }) => result.depth > 100,
    context: ({ result }) => result,
  },
);

observed("email", 101);
