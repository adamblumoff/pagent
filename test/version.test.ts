import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EVENT_PROTOCOL_VERSION, PAGENT_VERSION } from "../src/version.js";

describe("release compatibility contract", () => {
  it("keeps the package and event protocol versions explicit", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(PAGENT_VERSION).toBe(packageJson.version);
    expect(EVENT_PROTOCOL_VERSION).toBe(2);
  });

  it("exports only the package and event protocol versions", async () => {
    const version = await import("../src/version.js") as Record<string, unknown>;
    expect(Object.keys(version).sort()).toEqual([
      "EVENT_PROTOCOL_VERSION",
      "PAGENT_VERSION",
    ]);
  });
});
