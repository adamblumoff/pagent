import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";

import {
  assertVersionAgreement,
  parseArguments,
  parseReleaseTag,
  releasePackageJson,
} from "./build-release.mjs";

test("requires every component to match the release version", () => {
  assert.doesNotThrow(() =>
    assertVersionAgreement("0.1.0-rc.1", {
      "package.json": "0.1.0-rc.1",
      SDK: "0.1.0-rc.1",
      relay: "0.1.0-rc.1",
    }),
  );
  assert.throws(
    () => assertVersionAgreement("0.1.0-rc.1", { SDK: "0.1.0" }),
    /SDK reports version "0\.1\.0"/,
  );
});

test("parses stable release tags", () => {
  assert.equal(parseReleaseTag("v0.1.0"), "0.1.0");
  assert.equal(parseReleaseTag("v12.34.56"), "12.34.56");
  assert.equal(parseReleaseTag("v0.1.0-rc.1"), "0.1.0-rc.1");
  assert.equal(parseReleaseTag("v12.34.56-rc.0"), "12.34.56-rc.0");
});

test("rejects ambiguous or noncanonical tags", () => {
  for (const tag of [
    "1.2.3",
    "v1.2",
    "v01.2.3",
    "v1.2.3-beta.1",
    "v1.2.3-rc.01",
    "latest",
  ]) {
    assert.throws(() => parseReleaseTag(tag), /vMAJOR\.MINOR\.PATCH/);
  }
});

test("parses explicit release arguments", () => {
  assert.deepEqual(
    parseArguments([
      "--",
      "--tag",
      "v1.2.3",
      "--out-dir",
      "tmp/release",
      "--skip-build",
    ]),
    {
      tag: "v1.2.3",
      outputDirectory: resolve("tmp/release"),
      skipBuild: true,
    },
  );
});

test("keeps only runtime package metadata", () => {
  const source = {
    name: "pagent",
    version: "0.0.0",
    description: "description",
    private: true,
    type: "module",
    sideEffects: false,
    engines: { node: ">=22" },
    bin: { pagent: "./dist/cli.js" },
    exports: { ".": "./dist/index.js" },
    repository: { type: "git", url: "https://example.test/pagent.git" },
    scripts: { test: "false" },
    devDependencies: { typescript: "latest" },
  };

  assert.deepEqual(releasePackageJson(source, "1.2.3"), {
    name: "pagent",
    version: "1.2.3",
    description: "description",
    private: true,
    type: "module",
    sideEffects: false,
    engines: { node: ">=22" },
    bin: { pagent: "./dist/cli.js" },
    exports: { ".": "./dist/index.js" },
    repository: { type: "git", url: "https://example.test/pagent.git" },
  });
});
