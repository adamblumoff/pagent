import { createPagent, defineEvent } from "../../../dist/index.js";

declare function waitUntil(promise: Promise<unknown>): void;

const event = defineEvent<{ path: string }>({ name: "route.failed" });
const pagent = createPagent({ enabled: false });
const observed = pagent.observe(
  async (request: Request) => new Response(null, { status: 500 }),
  {
    event,
    on: "result",
    triggerWhen: ({ result }) => result.status >= 500,
    context: ({ args: [request] }) => ({
      path: new URL(request.url).pathname,
    }),
  },
);

export async function GET(request: Request): Promise<Response> {
  try {
    return await observed(request);
  } finally {
    waitUntil(pagent.flush());
  }
}
