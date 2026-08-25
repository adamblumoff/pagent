import { createPagent, defineEvent } from "../../../dist/index.js";

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

declare function waitUntil(promise: Promise<unknown>): void;

const requestFailed = defineEvent<{ path: string; status: number }>({
  name: "request.failed",
});
const pagent = createPagent({ enabled: false });
const observedRequest = pagent.observe(
  async (request: Request) => new Response(null, { status: 503 }),
  {
    event: requestFailed,
    on: "result",
    triggerWhen: ({ result }) => result.status >= 500,
    context: ({ args: [request], result }) => ({
      path: new URL(request.url).pathname,
      status: result.status,
    }),
  },
);

export async function workerHandle(
  request: Request,
  context: ExecutionContextLike,
): Promise<Response> {
  try {
    return await observedRequest(request);
  } finally {
    context.waitUntil(pagent.flush());
  }
}

export async function vercelGet(request: Request): Promise<Response> {
  try {
    return await observedRequest(request);
  } finally {
    waitUntil(pagent.flush());
  }
}

const dependencyFailed = defineEvent<{ reason: string }>({
  name: "dependency.failed",
});
const observedDependency = pagent.observe(
  async () => ({ ok: false, reason: "dependency unavailable" }),
  {
    event: dependencyFailed,
    on: "result",
    triggerWhen: ({ result }) => !result.ok,
    context: ({ result }) => ({ reason: result.reason }),
  },
);

await observedDependency();
