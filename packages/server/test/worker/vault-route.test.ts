/**
 * The gateway's vault route, driven through the MCP surface like everything
 * else the sandbox can do.
 *
 * Shortcut, written down per the testing decisions: the pool parses the
 * containers block but never runs a container, so `VAULT_ORIGIN` points the
 * backend at the loopback listener, which answers with container-shaped
 * fixtures - one knowable note, a canned write receipt. What this file
 * proves is therefore the gateway's half: policy before backend, denials
 * with their tags intact through the boundary, and the wire-side negative -
 * a refused write is a request the container never received. What it cannot
 * prove is the container itself; that half is the local docker run and the
 * deployed probe.
 */
import { describe, expect, it } from "vitest";
import { vaultCapability } from "../../src/registry/Registry.ts";
import { LISTENER_ORIGIN } from "./support/listener-address.ts";
import { callTool } from "./support/mcp.ts";
import { mintAccessToken } from "./support/token.ts";

const execute = (accessToken: string, code: string) => callTool(accessToken, "execute", { code });

const connectionsSeen = async (): Promise<number> => Number(await (await fetch(`${LISTENER_ORIGIN}/count`)).text());

describe("the vault route", () => {
  it("runs the vault worked example, and gets the miss it documents", async () => {
    // Imported from the registry, not copied, so the example a model copies
    // most literally cannot go stale without failing here. The double knows
    // one note and it is not this one, which is exactly the fresh state the
    // example's declared result describes.
    const { accessToken } = await mintAccessToken();

    const result = await execute(accessToken, vaultCapability.example.code);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, value: { result: vaultCapability.example.result } });
  });

  it("reads the note the vault holds, syncedAt included", async () => {
    const { accessToken } = await mintAccessToken();

    const result = await execute(
      accessToken,
      'import { vault } from "opti:capabilities";\n' +
        'export default async () => await vault.read("10 Content Engine/existing.md");\n',
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      value: {
        result: {
          path: "10 Content Engine/existing.md",
          content: "# Existing\n",
          syncedAt: "2026-09-01T00:00:00.000Z",
        },
      },
    });
  });

  it("refuses a write outside the approved folders, and the container never sees it", async () => {
    const { accessToken } = await mintAccessToken();
    const before = await connectionsSeen();

    const result = await execute(
      accessToken,
      'import { vault } from "opti:capabilities";\n' +
        "export default async () => {\n" +
        "  try {\n" +
        '    await vault.write("00 Journal/2026-09-01.md", "injected");\n' +
        "    return { wrote: true };\n" +
        "  } catch (refused) {\n" +
        "    return { stopped: refused._tag, retry: refused.retry };\n" +
        "  }\n" +
        "};\n",
    );

    expect(result.structuredContent).toMatchObject({
      ok: true,
      value: { result: { stopped: "VaultWriteRefused", retry: "never" } },
    });
    // The negative that matters: the refusal happened at the gateway, so the
    // wire recorded no connection - the journal write was not merely
    // rejected downstream, it never left.
    expect(await connectionsSeen()).toBe(before);
  });

  it("refuses traversal out of the vault before any backend is consulted", async () => {
    const { accessToken } = await mintAccessToken();
    const before = await connectionsSeen();

    const result = await execute(
      accessToken,
      'import { vault } from "opti:capabilities";\n' +
        "export default async () => {\n" +
        "  try {\n" +
        '    await vault.read("10 Content Engine/../00 Journal/2026-09-01.md");\n' +
        "    return { read: true };\n" +
        "  } catch (refused) {\n" +
        "    return { stopped: refused._tag };\n" +
        "  }\n" +
        "};\n",
    );

    expect(result.structuredContent).toMatchObject({ ok: true, value: { result: { stopped: "InvalidVaultPath" } } });
    expect(await connectionsSeen()).toBe(before);
  });

  it("carries a write inside the approved folder through to the vault", async () => {
    const { accessToken } = await mintAccessToken();
    const before = await connectionsSeen();

    const result = await execute(
      accessToken,
      'import { vault } from "opti:capabilities";\n' +
        'export default async () => await vault.write("10 Content Engine/draft.md", "# Draft\\n");\n',
    );

    // The double's canned receipt, spliced through untouched - and exactly
    // one connection: the write, with no second request hiding anywhere.
    expect(result.structuredContent).toMatchObject({ ok: true, value: { result: { path: "double", bytes: 0 } } });
    expect(await connectionsSeen()).toBe(before + 1);
  });
});
