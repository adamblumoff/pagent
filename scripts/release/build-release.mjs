import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const DEFAULT_OUTPUT_DIRECTORY = join(repositoryRoot, "release");
const RELEASE_TAG =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;
const OUTPUT_MARKER = ".pagent-release-output";

export function parseReleaseTag(tag) {
  const match = RELEASE_TAG.exec(tag);
  if (match === null) {
    throw new Error(
      `Release tag must use vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.N, received ${JSON.stringify(tag)}.`,
    );
  }
  return tag.slice(1);
}

export function parseArguments(arguments_) {
  let tag = process.env.GITHUB_REF_NAME;
  let outputDirectory = DEFAULT_OUTPUT_DIRECTORY;
  let skipBuild = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--tag") {
      tag = requiredValue(arguments_, ++index, argument);
    } else if (argument === "--out-dir") {
      outputDirectory = resolve(repositoryRoot, requiredValue(arguments_, ++index, argument));
    } else if (argument === "--skip-build") {
      skipBuild = true;
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
    }
  }

  if (tag === undefined || tag === "") {
    throw new Error("Pass --tag vMAJOR.MINOR.PATCH or set GITHUB_REF_NAME.");
  }

  return { tag, outputDirectory, skipBuild };
}

export async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export function releasePackageJson(source, version) {
  return {
    name: source.name,
    version,
    description: source.description,
    private: true,
    type: source.type,
    sideEffects: source.sideEffects,
    engines: source.engines,
    bin: source.bin,
    exports: source.exports,
    repository: source.repository,
  };
}

export function assertVersionAgreement(releaseVersion, componentVersions) {
  for (const [component, version] of Object.entries(componentVersions)) {
    if (version !== releaseVersion) {
      throw new Error(
        `${component} reports version ${JSON.stringify(version)}, but the release tag targets ${releaseVersion}.`,
      );
    }
  }
}

export async function buildRelease({ tag, outputDirectory, skipBuild }) {
  const version = parseReleaseTag(tag);
  assertSafeOutputDirectory(outputDirectory);

  if (!skipBuild) {
    run("pnpm", ["build"]);
  }

  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const relayPackageJson = JSON.parse(
    await readFile(join(repositoryRoot, "relay/package.json"), "utf8"),
  );
  const compatibility = await inspectBuiltRelease(
    packageJson.version,
    relayPackageJson.version,
    version,
  );

  await prepareOutputDirectory(outputDirectory);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pagent-release-"));
  try {
    const packageDirectory = join(temporaryDirectory, "package");
    await stagePackage(packageDirectory, packageJson, version);

    const packageArtifact = await packPackage(packageDirectory, outputDirectory, version);
    const artifactName = basename(packageArtifact);
    const artifacts = [
      await describeArtifact(packageArtifact, "sdk-and-cli", [
        { component: "sdk", command: `npm install ./${artifactName}` },
        {
          component: "cli",
          command: `npm install --global ./${artifactName}`,
        },
      ]),
    ];
    const manifest = {
      schemaVersion: 1,
      tag,
      version,
      commit: releaseCommit(),
      requirements: { node: packageJson.engines.node, codex: "installed locally" },
      protocols: compatibility.protocols,
      artifacts,
    };
    const manifestPath = join(outputDirectory, "release-manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    await writeChecksums(
      [...artifacts.map(({ name }) => join(outputDirectory, name)), manifestPath],
      outputDirectory,
    );

    return manifest;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function stagePackage(directory, packageJson, version) {
  await mkdir(directory, { recursive: true });
  await cp(join(repositoryRoot, "dist"), join(directory, "dist"), { recursive: true });
  await cp(join(repositoryRoot, "README.md"), join(directory, "README.md"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(releasePackageJson(packageJson, version), null, 2) + "\n",
  );

  await chmod(join(directory, "dist/cli.js"), 0o755);
}

async function inspectBuiltRelease(packageVersion, relayPackageVersion, releaseVersion) {
  const sdkVersionModule = await import(
    pathToFileURL(join(repositoryRoot, "dist/version.js")).href + `?release=${Date.now()}`
  );
  const relayVersionModule = await import(
    pathToFileURL(join(repositoryRoot, "relay/dist/src/version.js")).href +
      `?release=${Date.now()}`
  );
  const cliVersion = run(process.execPath, [join(repositoryRoot, "dist/cli.js"), "--version"], {
    encoding: "utf8",
  }).trim();
  assertVersionAgreement(releaseVersion, {
    "package.json": packageVersion,
    "relay/package.json": relayPackageVersion,
    SDK: sdkVersionModule.PAGENT_VERSION,
    relay: relayVersionModule.PAGENT_VERSION,
    CLI: cliVersion,
  });

  const protocols = {
    event: sdkVersionModule.EVENT_PROTOCOL_VERSION,
    relay: sdkVersionModule.RELAY_PROTOCOL_VERSION,
  };
  if (
    protocols.event !== relayVersionModule.EVENT_PROTOCOL_VERSION ||
    protocols.relay !== relayVersionModule.RELAY_PROTOCOL_VERSION
  ) {
    throw new Error("SDK and relay protocol versions do not agree.");
  }

  return { protocols };
}

async function packPackage(packageDirectory, outputDirectory, version) {
  const packOutput = run(
    "npm",
    ["pack", packageDirectory, "--pack-destination", outputDirectory, "--json"],
    { encoding: "utf8" },
  );
  const result = JSON.parse(packOutput);
  if (!Array.isArray(result) || typeof result[0]?.filename !== "string") {
    throw new Error("npm pack did not report an artifact filename.");
  }
  const source = join(outputDirectory, result[0].filename);
  const destination = join(outputDirectory, `pagent-v${version}.tgz`);
  await rename(source, destination);
  return destination;
}

async function describeArtifact(file, kind, installModes) {
  const fileStat = await stat(file);
  return {
    name: basename(file),
    kind,
    bytes: fileStat.size,
    sha256: await sha256(file),
    installModes,
  };
}

async function writeChecksums(files, outputDirectory) {
  const lines = [];
  for (const file of files) {
    lines.push(`${await sha256(file)}  ${basename(file)}`);
  }
  await writeFile(join(outputDirectory, "SHA256SUMS"), lines.join("\n") + "\n");
}

function releaseCommit() {
  return (
    process.env.GITHUB_SHA ??
    run("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  );
}

function assertSafeOutputDirectory(directory) {
  const resolved = resolve(directory);
  if (
    resolved === resolve("/") ||
    resolved === repositoryRoot ||
    resolved === resolve(repositoryRoot, "..")
  ) {
    throw new Error(`Refusing to replace unsafe output directory ${resolved}.`);
  }
}

async function prepareOutputDirectory(directory) {
  const entries = await readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });

  if (entries !== undefined && entries.length > 0) {
    if (!entries.includes(OUTPUT_MARKER)) {
      throw new Error(
        `Refusing to replace non-release files in ${directory}. Choose an empty output directory.`,
      );
    }
    const marker = await readFile(join(directory, OUTPUT_MARKER), "utf8");
    if (marker !== "pagent release artifacts\n") {
      throw new Error(`Release output marker in ${directory} is invalid.`);
    }
    await rm(directory, { recursive: true, force: true });
  }

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, OUTPUT_MARKER), "pagent release artifacts\n");
}

function requiredValue(arguments_, index, option) {
  const value = arguments_[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function run(command, arguments_, options = {}) {
  return execFileSync(command, arguments_, {
    cwd: repositoryRoot,
    stdio: options.encoding === undefined ? "inherit" : ["ignore", "pipe", "inherit"],
    ...options,
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = await buildRelease(options);
  console.log(`Built ${manifest.tag} in ${options.outputDirectory}`);
  for (const artifact of manifest.artifacts) {
    console.log(`${artifact.name}  ${artifact.sha256}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
