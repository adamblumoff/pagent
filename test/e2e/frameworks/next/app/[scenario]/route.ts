import { after } from "next/server";

import { FixtureFailure } from "../../../shared/service";
import { service } from "../service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ scenario: string }> },
): Promise<Response> {
  const { scenario } = await params;

  if (scenario === "healthy") {
    return Response.json(service.healthy());
  }
  if (scenario === "failure") {
    const result = service.fail();
    after(() => service.flush());
    return Response.json(result, { status: result.statusCode });
  }
  if (scenario === "burst") {
    const results = [
      service.fail("burst"),
      service.fail("burst"),
      service.fail("burst"),
    ];
    after(() => service.flush());
    return Response.json(
      { status: "unhealthy", framework: "next", count: results.length },
      { status: 503 },
    );
  }
  if (scenario === "throw") {
    try {
      return service.throw();
    } catch (error) {
      after(() => service.flush());
      return Response.json(
        {
          name: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : "unknown error",
          sameError: error instanceof FixtureFailure,
        },
        { status: 500 },
      );
    }
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}
