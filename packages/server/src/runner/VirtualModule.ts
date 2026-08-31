/**
 * The virtual module builder: a resolved capability set and one submitted
 * module in, the module map an isolate boots from out.
 *
 * The map holds exactly three members. `opti:capabilities` carries concrete
 * named exports for the granted set and nothing else, so an ungranted
 * capability fails at the import line rather than halfway through a run - it
 * is a grant list, not a boundary; the boundary is `globalOutbound` plus the
 * absent parent environment, applied by the runner. `submitted.js` is the
 * model's code, kept in its own module so a syntax error or an ungranted
 * import fails before any of its statements run, and a bug fails inside the
 * call. `main.js` is the generated entry.
 *
 * The entry serialises the report itself, because a rejected fetch on the
 * host side leaves nothing but a message string: it catches, reads the tag
 * off whatever was thrown so the boundary does not flatten what went wrong,
 * and shadows `console.*` so a run's output comes home with it.
 */
import type { Capability } from "../registry/Registry.ts";

/**
 * A module name that is not a path must state its type - the spike finding.
 * The object form is what lets the grant list keep a greppable specifier.
 */
export const CAPABILITIES_MODULE = "opti:capabilities";

/**
 * The generated entry. Everything here runs inside the sandbox, so it can
 * rely on nothing from the host and must survive anything the submitted
 * module does: the report is built from primitives, and even the log
 * collector refuses to throw.
 */
const ENTRY = `
const readTag = (thrown) =>
  thrown !== null && typeof thrown === "object" && typeof thrown._tag === "string"
    ? thrown._tag
    : thrown instanceof Error && thrown.name.length > 0
      ? thrown.name
      : "Unexpected";

const readMessage = (thrown) =>
  thrown !== null && typeof thrown === "object" && typeof thrown.message === "string"
    ? thrown.message
    : String(thrown);

const readRetry = (thrown) =>
  thrown !== null && typeof thrown === "object" && (thrown.retry === "now" || thrown.retry === "after")
    ? thrown.retry
    : undefined;

const readAction = (thrown) =>
  thrown !== null &&
  typeof thrown === "object" &&
  thrown.action !== null &&
  typeof thrown.action === "object" &&
  typeof thrown.action.kind === "string" &&
  typeof thrown.action.url === "string"
    ? { kind: thrown.action.kind, url: thrown.action.url }
    : undefined;

const show = (value) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export default {
  async fetch() {
    const startedAt = Date.now();
    const logs = [];
    // Phase timings, sandbox-reported because the host sees one opaque call.
    // Workerd freezes the clock during pure computation, so these mostly
    // measure I/O - which is the half worth measuring.
    const timings = {};
    const record = (level) => (...args) => {
      logs.push(level + ": " + args.map(show).join(" "));
    };
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      console[level] = record(level);
    }

    const report = (body) =>
      new Response(body, { headers: { "content-type": "application/json" } });
    // retry and action ride along when the thrown value carried them, so the
    // boundary does not flatten a denial into a bare message. Absent means the
    // boring default - never retry, nothing for a human to do.
    const failure = (tag, message, thrown) => {
      const retry = readRetry(thrown);
      const action = readAction(thrown);
      return report(JSON.stringify({
        ok: false,
        error: Object.assign({ tag, message }, retry && { retry }, action && { action }),
        logs,
        timings,
      }));
    };

    let submitted;
    try {
      submitted = await import("./submitted.js");
      timings.bootMs = Date.now() - startedAt;
    } catch (thrown) {
      timings.bootMs = Date.now() - startedAt;
      return failure(readTag(thrown), "the module could not be loaded: " + readMessage(thrown), thrown);
    }
    if (typeof submitted.default !== "function") {
      return failure("NoDefaultExport", "the module must default-export an async function");
    }

    const callStartedAt = Date.now();
    try {
      const value = await submitted.default();
      timings.executeMs = Date.now() - callStartedAt;
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        return failure("ResultNotSerializable", "the returned value does not survive JSON");
      }
      return report('{"ok":true,"value":' + serialized + ',"logs":' + JSON.stringify(logs) +
        ',"timings":' + JSON.stringify(timings) + "}");
    } catch (thrown) {
      timings.executeMs = Date.now() - callStartedAt;
      return failure(readTag(thrown), readMessage(thrown), thrown);
    }
  },
};
`;

export type ModuleMap = Record<string, string | { readonly js: string }>;

/** What the map needs of a published package: the emitted files, the entry
 * they start from, and the manifest's export names for the alias. */
export interface SandboxPackage {
  readonly name: string;
  readonly entry: string;
  readonly files: Readonly<Record<string, string>>;
  readonly exportNames: readonly string[];
}

/**
 * The bare package specifier resolves to a generated alias that re-exports
 * exactly the manifest's names from the entry file. The manifest is the
 * interface: an export the manifest does not declare is reachable through
 * the full file path but invisible at the name the model imports.
 *
 * The leading slash is load-bearing: workerd resolves specifiers as paths
 * against the referrer, and this alias module's own name contains slashes,
 * so a bare specifier here would resolve under `opti:packages/` instead of
 * at the root. `/` is the depth-independent spelling of "from the root";
 * publish rewrites the emitted files' own `opti:` imports the same way.
 */
const packageAlias = (pkg: SandboxPackage): string =>
  `export { ${pkg.exportNames.join(", ")} } from "/opti:packages/${pkg.name}/${pkg.entry}";`;

/**
 * Build the map for one execution. Generated per execution on purpose: the
 * grant list is whatever was resolved for this run, so what `search` said and
 * what the import line finds cannot drift apart. Every published package is
 * included - the virtual module is a grant list of everything yours, the
 * same philosophy as the built-ins.
 */
export const build = (
  granted: readonly Capability[],
  packages: readonly SandboxPackage[],
  submitted: string,
): ModuleMap => {
  for (const capability of granted) {
    // The layering rule, enforced at build time as well as by the boundary
    // test: a capability never imports a package, because shipped code must
    // not depend on owner-mutable code. Our own mistake is the threat, so
    // throwing a defect here is the right loudness.
    if (capability.code.includes("opti:packages")) {
      throw new Error(
        `capability ${capability.name} names opti:packages; an edit to a package must never change what a primitive means`,
      );
    }
  }
  const map: ModuleMap = {
    "main.js": ENTRY,
    "submitted.js": submitted,
    [CAPABILITIES_MODULE]: { js: granted.map((capability) => capability.code).join("\n") },
  };
  for (const pkg of packages) {
    map[`opti:packages/${pkg.name}`] = { js: packageAlias(pkg) };
    for (const [path, content] of Object.entries(pkg.files)) {
      map[`opti:packages/${pkg.name}/${path}`] = { js: content };
    }
  }
  return map;
};
