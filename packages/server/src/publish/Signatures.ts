/**
 * Where search's TypeScript signatures become compiler input.
 *
 * The registry's signature strings and every manifest's export signatures are
 * spliced into declaration files and a conformance check, and the publish
 * compile holds the real code to them. That is what makes the signatures
 * honest: the string a model reads in a search response is the same string
 * the compiler checked against real types.
 */
import type { Manifest, PackageExport } from "../packages/Manifest.ts";
import type { Capability } from "../registry/Registry.ts";

/** The one file name the conformance check may use: uppercase, so it can
 * never collide with a package path, which is lowercase by rule. */
export const CHECK_FILE = "OPTI.check.ts";

/**
 * One export declaration from one member-form signature. A signature that
 * opens with `name(` is a function; anything else declares a value with the
 * member's own `name: type` shape.
 */
const declaration = (declared: PackageExport): string =>
  declared.signature.trimStart().startsWith(`${declared.name}(`)
    ? `export declare function ${declared.signature};`
    : `export declare const ${declared.signature};`;

/** The `opti:capabilities` module as the compiler sees it, generated from
 * the same records search serves so the two cannot drift apart. */
export const capabilitiesDts = (capabilities: readonly Capability[]): string =>
  capabilities.map((capability) => declaration({ name: capability.name, signature: capability.signature })).join("\n");

/** An `opti:packages/<name>` module as the compiler sees it, from the
 * manifest of an already-published package. */
export const packageDts = (manifest: Manifest): string => manifest.exports.map(declaration).join("\n");

/**
 * The conformance check: the manifest's signatures as one object type, and
 * the real module assigned to it. A declared export that does not exist, or
 * exists with a type the signature does not admit, fails this file's compile
 * - and the diagnostic points here, which is what tells the caller the
 * manifest is the half to fix.
 */
export const conformanceCheck = (emittedEntry: string, manifest: Manifest): string =>
  `import * as candidate from "./${emittedEntry}";\n` +
  "declare const declared: {\n" +
  `${manifest.exports.map((declared) => `  ${declared.signature};`).join("\n")}\n` +
  "};\n" +
  "const conforms: typeof declared = candidate;\n" +
  "void conforms;\n";
