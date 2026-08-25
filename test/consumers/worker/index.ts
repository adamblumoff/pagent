import { createPagent, defineEvent } from "../../../dist/index.js";

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

const event = defineEvent<{ path: string; status: number }>({
  name: "request.failed",
});
const pagent = createPagent({ enabled: false });
const observed = pagent.observe(
  async (request: Request) => new Response(null, { status: 503 }),
  {
    event,
    on: "result",
    triggerWhen: ({ result }) => result.status >= 500,
    context: ({ args: [request], result }) => ({
      path: new URL(request.url).pathname,
      status: result.status,
    }),
  },
);

export async function handle(
  request: Request,
  context: ExecutionContextLike,
): Promise<Response> {
  try {
    return await observed(request);
  } finally {
    context.waitUntil(pagent.flush());
  }
}
