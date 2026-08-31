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
