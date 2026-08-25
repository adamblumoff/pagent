import Fastify, { type FastifyInstance } from "fastify";

import {
  createFixtureService,
  FixtureFailure,
  type FixtureService,
} from "../../shared/service.js";
import type { PagentOptions } from "pagent";

export function buildApp(options: PagentOptions): FastifyInstance {
  const app = Fastify();
  const service = createFixtureService("fastify", options);

  app.get("/healthy", async () => service.healthy());
  app.get("/failure", async (_request, reply) => {
    const result = service.fail();
    return reply.code(result.statusCode).send(result);
  });
  app.get("/throw", async () => service.throw());
  app.get("/burst", async (_request, reply) => {
    const results = burst(service);
    return reply.code(503).send({
      status: "unhealthy",
      framework: "fastify",
      count: results.length,
    });
  });
  app.setErrorHandler((error, _request, reply) =>
    reply.code(500).send({
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "unknown error",
      sameError: error instanceof FixtureFailure,
    }),
  );
  app.addHook("onClose", async () => service.flush());

  return app;
}

function burst(service: FixtureService): readonly unknown[] {
  return [service.fail("burst"), service.fail("burst"), service.fail("burst")];
}
