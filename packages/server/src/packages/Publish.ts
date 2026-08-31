/**
 * The publish pipeline, in order: typecheck, emit, boot the emitted module in
 * a real isolate, verify the declared exports exist. Any failure fails the
 * publish, the pointer does not move, and the previous version keeps
 * serving. Publish is the one transaction the package store owns: the checks
 * run out here against a pinned revision, and the store's commit refuses to
 * move the pointer if an edit landed while they ran.
 *
 * Only the published snapshot ever enters an isolate; working state never
 * runs, except inside this check itself - where it runs with no way out at
 * all, because the boot probe's isolate gets a null outbound.
 */
import { Data, Effect } from "effect";
import type { Owner } from "../identity/index.ts";
import type { Failure } from "../kernel/index.ts";
import { compile } from "../publish/Compile.ts";
import { CHECK_FILE, capabilitiesDts, conformanceCheck, packageDts } from "../publish/Signatures.ts";
import { builtIns, sandboxPackages } from "../registry/Registry.ts";
import * as Runner from "../runner/Runner.ts";
import * as VirtualModule from "../runner/VirtualModule.ts";
import { type OwnerStore, storeFor } from "../store/OwnerStore.ts";
import { checkFiles, checkManifest, emittedPath, entryFile, type InvalidPackage } from "./Manifest.ts";

export interface PublishBindings extends Runner.RunnerBindings {
  readonly OWNER_STORE: DurableObjectNamespace<OwnerStore>;
}

export class NoSuchPackage extends Data.TaggedError("NoSuchPackage")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/** A check failed. The previous version keeps serving; the message names
 * what to fix, because "publishing is always safe to attempt" is only useful
 * when a failed attempt says why. */
export class PublishCheckFailed extends Data.TaggedError("PublishCheckFailed")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/** An edit landed while the checks ran. Retry `now`: the same call against
 * the settled working state is exactly the remedy. */
export class PublishRaced extends Data.TaggedError("PublishRaced")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "now";
}

export interface Published {
  readonly published: string;
  readonly exports: readonly string[];
}

export const publish = (
  bindings: PublishBindings,
  ownerId: Owner.OwnerId,
  name: string,
): Effect.Effect<Published, NoSuchPackage | InvalidPackage | PublishCheckFailed | PublishRaced> =>
  Effect.gen(function* () {
    const store = storeFor(bindings.OWNER_STORE, ownerId);

    const source = yield* Effect.promise(async () => await store.publishSource(name));
    if (source === null) {
      return yield* new NoSuchPackage({ message: `no package is named ${JSON.stringify(name)}` });
    }

    // Re-validated here even though create and edit validate too: publish is
    // the gate to live, so it does not trust its own callers' history.
    const invalid = checkFiles(source.files) ?? checkManifest(source.manifest);
    if (invalid !== null) {
      return yield* invalid;
    }
    const entry = entryFile(source.files.map((file) => file.path));
    if (entry === null) {
      return yield* new PublishCheckFailed({ message: "the package has no index file" });
    }
    const emittedEntry = emittedPath(entry);
    const exportNames = source.manifest.exports.map((declared) => declared.name);

    // Declarations for everything the package may import: the capabilities,
    // and every other published package - self excluded, so a package cannot
    // depend on its own previous version without anyone noticing.
    const published = yield* Effect.promise(async () => await store.listPublished());
    const others = published.filter((pkg) => pkg.name !== name);
    const ambient: Record<string, string> = {
      "/types/opti-capabilities.d.ts": capabilitiesDts(builtIns),
    };
    for (const pkg of others) {
      ambient[`/types/packages/${pkg.name}.d.ts`] = packageDts(pkg.manifest);
    }

    const files: Record<string, string> = { [CHECK_FILE]: conformanceCheck(emittedEntry, source.manifest) };
    for (const file of source.files) {
      files[file.path] = file.content;
    }

    const compiled = yield* Effect.promise(() => compile({ files, ambient }));
    if (!compiled.ok) {
      return yield* new PublishCheckFailed({
        message: `the package does not typecheck:\n${compiled.diagnostics.join("\n")}`,
      });
    }
    const emitted: Record<string, string> = {};
    for (const [path, content] of Object.entries(compiled.emitted)) {
      if (path !== emittedPath(CHECK_FILE)) {
        emitted[path] = content;
      }
    }

    // The boot check: the emitted module in a real isolate, beside the other
    // published packages it may import, with no network. An import-time
    // throw or a missing export fails here rather than in somebody's run.
    const candidate: VirtualModule.SandboxPackage = { name, entry: emittedEntry, files: emitted, exportNames };
    const probe =
      `import * as candidate from "opti:packages/${name}/${emittedEntry}";\n` +
      `export default async () => ${JSON.stringify(exportNames)}.filter((declared) => !(declared in candidate));\n`;
    const report = yield* Runner.run(
      bindings,
      ownerId,
      `publish-${crypto.randomUUID()}`,
      VirtualModule.build(builtIns, [...sandboxPackages(others), candidate], probe),
      null,
    );
    if (!report.outcome.ok) {
      return yield* new PublishCheckFailed({
        message: `the emitted module failed to boot: ${report.outcome.error.message}`,
      });
    }
    const missing = Array.isArray(report.outcome.result) ? report.outcome.result : null;
    if (missing === null || missing.length > 0) {
      return yield* new PublishCheckFailed({
        message: `the manifest declares exports the module does not have: ${(missing ?? exportNames).join(", ")}`,
      });
    }

    const verdict = yield* Effect.promise(async () => await store.commitPublish(name, source.revision, emitted));
    if (!verdict.ok) {
      return yield* new PublishRaced({ message: verdict.message });
    }
    return { published: name, exports: exportNames };
  });
