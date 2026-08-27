import { Hono } from "hono";

import {
  createFixtureService,
  FixtureFailure,
  pagentOptions,
  type FixtureService,
} from "../../shared/service";

interface Bindings {
  PAGENT_ENABLED?: string;
  PAGENT_ENV?: string;
  PAGENT_ENCRYPTION_KEY?: string;
  PAGENT_ENCRYPTION_KEY_ID?: string;
  PAGENT_SOURCE_TOKEN?: string;
  PAGENT_ENDPOINT_URL?: string;
}

const app = new Hono<{ Bindings: Bindings }>();

app.get("/healthy", (c) => c.json(service(c.env).healthy()));
app.get("/failure", (c) => {
  const current = service(c.env);
  const result = current.fail();
  c.executionCtx.waitUntil(current.flush());
  return c.json(result, 503);
});
app.get("/throw", (c) => {
  const current = service(c.env);
  try {
    return c.json(current.throw());
  } catch (error) {
    c.executionCtx.waitUntil(current.flush());
    throw error;
  }
});
app.get("/burst", (c) => {
  const current = service(c.env);
  const results = burst(current);
  c.executionCtx.waitUntil(current.flush());
  return c.json(
    { status: "unhealthy", framework: "hono", count: results.length },
    503,
  );
});
app.onError((error, c) =>
  c.json(
    {
      name: error.name,
      message: error.message,
      sameError: error instanceof FixtureFailure,
    },
    500,
  ),
);

export default app;

function service(bindings: Bindings): FixtureService {
  return createFixtureService(
    "hono",
    pagentOptions({
      enabled: bindings.PAGENT_ENABLED,
      environment: bindings.PAGENT_ENV,
      encryptionKey: bindings.PAGENT_ENCRYPTION_KEY,
      encryptionKeyId: bindings.PAGENT_ENCRYPTION_KEY_ID,
      sourceToken: bindings.PAGENT_SOURCE_TOKEN,
      endpointUrl: bindings.PAGENT_ENDPOINT_URL,
    }),
  );
}

function burst(current: FixtureService): readonly unknown[] {
  return [
    current.fail("burst"),
    current.fail("burst"),
    current.fail("burst"),
  ];
}
