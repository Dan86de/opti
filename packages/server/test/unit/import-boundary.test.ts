/**
 * The import boundary around the vault's write paths, enforced by the build
 * rather than by review.
 *
 * The security property of Slice 2 is that nothing on any agent surface can
 * widen egress or plant a credential: no tool, no sandboxed code, no
 * capability handler. Structurally that means the host policy's write path
 * and the credential store's put are reachable from the operator surface and
 * from nowhere else. This test reads the source and fails on the day someone
 * adds a second caller, which is cheaper than noticing it in review and much
 * cheaper than not noticing it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../../src");

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(directory, entry.name)]
        : [],
  );

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, "utf8"),
}));

describe("the layering rule", () => {
  it("keeps every built-in capability's sandbox code free of opti:packages", async () => {
    // A capability never imports a package: shipped code must not depend on
    // owner-mutable code, or an edit to a package could change what a
    // primitive means. The threat is our own mistake, so the enforcement is
    // a scan over the built-in sources - and the virtual module builder
    // refuses the same thing at build time.
    const { builtIns } = await import("../../src/registry/Registry.ts");

    for (const capability of builtIns) {
      expect(capability.code, `capability ${capability.name}`).not.toContain("opti:packages");
    }
  });
});

describe("the owner store write paths", () => {
  // The store's own files delegate to their storage-level modules, so they
  // are the definition side here, the way the vault is in its tests below.
  const outsideStore = files.filter((file) => !file.path.startsWith("store/"));

  const callersOf = (writeCall: RegExp): string[] =>
    outsideStore
      .filter((file) => writeCall.test(file.text))
      .map((file) => file.path)
      .sort();

  it("lets only the gateway drive storage writes and the trail", () => {
    // The gateway's internal route is the only way sandbox traffic reaches
    // the store, and nothing on the host side writes storage on its own.
    expect(callersOf(/\.(storageSet|storageDelete)\(/)).toStrictEqual(["gateway/Internal.ts"]);
    // The trail is the gateway's own account of what left, one line per
    // request; nothing else may write history into it.
    expect(callersOf(/\.appendTrail\(/)).toStrictEqual(["gateway/Gateway.ts"]);
  });

  it("lets only the execute path write run records", () => {
    expect(callersOf(/\.putRecord\(/)).toStrictEqual(["runner/Execute.ts"]);
  });

  it("lets only the packages tool drive the package write paths", () => {
    // Package state changes only through the lifecycle tool: no capability,
    // no sandboxed code, no other surface can mutate what publishes.
    expect(callersOf(/\.(createPackage|editPackageFile|editPackageManifest|commitPublish)\(/)).toStrictEqual([
      "packages/Packages.ts",
      "packages/Publish.ts",
    ]);
  });
});

describe("the vault write paths", () => {
  it("keeps the storage-level write modules inside the vault", () => {
    // HostPolicy and CredentialStore hold the write functions themselves.
    // Only vault modules may import them; everything else goes through the
    // vault's RPC surface, where the next assertion draws the line.
    const outsideVault = files.filter(
      (file) => !file.path.startsWith("vault/") && /from "[^"]*(HostPolicy|CredentialStore)\.ts"/.test(file.text),
    );

    expect(outsideVault.map((file) => file.path)).toStrictEqual([]);
  });

  it("lets only the admin module call the vault's write methods", () => {
    const writeCall = /\.(putCredential|approveHost)\(/;
    const callers = files
      .filter((file) => writeCall.test(file.text))
      .map((file) => file.path)
      .sort();

    // The admin module is their one caller - the vault defines them without
    // a receiver, so it does not appear. A new path in this list is the
    // alarm this test exists to raise.
    expect(callers).toStrictEqual(["admin/Admin.ts"]);
  });

  it("keeps the admin module itself off every agent surface", () => {
    // The MCP transport, the tools, the runner, the gateway and discovery
    // must not import the admin module: approval is structurally unreachable
    // from anything an agent can drive.
    const importers = files.filter(
      (file) => file.path !== "index.ts" && !file.path.startsWith("admin/") && /from "[^"]*admin\//.test(file.text),
    );

    expect(importers.map((file) => file.path)).toStrictEqual([]);
  });
});
