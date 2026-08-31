/**
 * The `packages` tool: lifecycle only - create from a run or from source,
 * read, edit, publish. Anything that is behaviour lives inside `execute`;
 * a fifth action here is the tripwire, not the solution.
 *
 * Create exists on the tool rather than as a capability for exactly one
 * reason: its input is the module the host already holds from a previous
 * run, so the model names a run instead of re-emitting code. The actions are
 * argument-shaped modes on one discriminator, the same design as search's
 * three, because four almost-identical tools would spend the context budget
 * the three-tool ceiling exists to protect.
 */
import { Data, Effect, Schema } from "effect";
import type { Owner } from "../identity/index.ts";
import type { Failure } from "../kernel/index.ts";
import { builtIns } from "../registry/Registry.ts";
import { type OwnerStore, storeFor } from "../store/OwnerStore.ts";
import { NoSuchRun, type RunRecord } from "../store/RunRecords.ts";
import { checkFilePath, checkFiles, checkManifest, checkName, type Manifest, type PackageFile } from "./Manifest.ts";
import * as Publish from "./Publish.ts";

export interface PackagesBindings extends Publish.PublishBindings {}

/** The arguments do not fit the named action. Never retryable as written;
 * the message says what the action needs instead. */
export class MalformedPackageRequest extends Data.TaggedError("MalformedPackageRequest")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/** Names are unique across capabilities and packages, so no package can
 * shadow `fetch` and a name lookup never needs disambiguation. */
export class PackageNameTaken extends Data.TaggedError("PackageNameTaken")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

export const parameters = Schema.Struct({
  action: Schema.Literals(["create", "read", "edit", "publish"]),
  name: Schema.optionalKey(Schema.String),
  fromRun: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  files: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String }))),
  exports: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, signature: Schema.String }))),
  path: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
});

export const tool = {
  name: "packages",
  description:
    "Package lifecycle. {action:create} with {name} and either {fromRun: runId} or {files, exports, summary}. " +
    "{action:read}: all your packages, or one with {name}. {action:edit} one file ({name, path, content}) or the manifest ({name, summary?, exports?}). " +
    "{action:publish} typechecks, boots and verifies {name}; only published packages appear in search and imports.",
  parametersSchema: parameters,
};

type Input = typeof parameters.Type;

export interface PackagesContext {
  readonly ownerId: Owner.OwnerId;
}

const need = (message: string) => new MalformedPackageRequest({ message });

/** Every action but the bare read addresses one package by name. */
const namedPackage = (input: Input) =>
  Effect.gen(function* () {
    const name = input.name;
    if (name === undefined) {
      return yield* need(`${input.action} needs a package name`);
    }
    const invalid = checkName(name);
    if (invalid !== null) {
      return yield* invalid;
    }
    return name;
  });

/** Create-from-run freezes the run's function as the first version's one
 * export, honest about being a first attempt; create-from-source and edit
 * exist precisely so the proper parameterized version can replace it. */
const fromRun = (store: DurableObjectStub<OwnerStore>, input: Input, runId: string) =>
  Effect.gen(function* () {
    if (input.files !== undefined || input.exports !== undefined) {
      return yield* need("create takes fromRun or files+exports, not both: a run already holds its code");
    }
    const recordText = yield* Effect.promise(async () => await store.getRun(runId));
    if (recordText === null) {
      return yield* new NoSuchRun({ message: `no run record is named ${JSON.stringify(runId)}` });
    }
    const record: RunRecord = JSON.parse(recordText);
    const files: PackageFile[] = [
      // The submitted module, frozen verbatim; the wrapper names its default
      // export, because the manifest's exports must be named.
      { path: "run.js", content: record.code },
      { path: "index.js", content: 'export { default as run } from "./run.js";\n' },
    ];
    const manifest: Manifest = {
      summary: input.summary ?? `Created from run ${runId}; a frozen first attempt.`,
      exports: [{ name: "run", signature: "run(): Promise<unknown>" }],
    };
    return { files, manifest };
  });

const fromSource = (input: Input) =>
  Effect.gen(function* () {
    const { files, exports, summary } = input;
    if (files === undefined || exports === undefined || summary === undefined) {
      return yield* need("create from source needs files, exports and a summary - or a fromRun instead");
    }
    return {
      files: [...files],
      manifest: { summary, exports: [...exports] },
    };
  });

const create = (store: DurableObjectStub<OwnerStore>, input: Input) =>
  Effect.gen(function* () {
    const name = yield* namedPackage(input);
    if (builtIns.some((capability) => capability.name === name)) {
      return yield* new PackageNameTaken({
        message: `a capability is named ${JSON.stringify(name)}; a package cannot shadow it`,
      });
    }
    const { files, manifest } = yield* input.fromRun !== undefined
      ? fromRun(store, input, input.fromRun)
      : fromSource(input);
    const invalid = checkFiles(files) ?? checkManifest(manifest);
    if (invalid !== null) {
      return yield* invalid;
    }
    const verdict = yield* Effect.promise(async () => await store.createPackage(name, manifest, files));
    if (!verdict.ok) {
      return yield* new PackageNameTaken({ message: verdict.message });
    }
    // Draft on purpose: create and publish are separate steps, so working
    // state and live state stay different things.
    return { created: name, state: "draft" as const };
  });

const read = (store: DurableObjectStub<OwnerStore>, input: Input) =>
  Effect.gen(function* () {
    const name = input.name;
    if (name === undefined) {
      // Everything with its state, drafts included, so an unpublished draft
      // from a dead conversation is findable.
      return { packages: yield* Effect.promise(async () => await store.packagesOverview()) };
    }
    const detail = yield* Effect.promise(async () => await store.readPackage(name));
    if (detail === null) {
      return yield* new Publish.NoSuchPackage({ message: `no package is named ${JSON.stringify(name)}` });
    }
    return detail;
  });

const edit = (store: DurableObjectStub<OwnerStore>, input: Input) =>
  Effect.gen(function* () {
    const name = yield* namedPackage(input);
    const { path, content, summary, exports } = input;
    const editsFile = path !== undefined || content !== undefined;
    const editsManifest = summary !== undefined || exports !== undefined;
    if (editsFile === editsManifest) {
      return yield* need(
        "edit changes one file ({path, content}) or the manifest ({summary and/or exports}), one at a time",
      );
    }

    if (editsFile) {
      if (path === undefined || content === undefined) {
        return yield* need("a file edit needs both path and content");
      }
      const invalid = checkFilePath(path);
      if (invalid !== null) {
        return yield* invalid;
      }
      const verdict = yield* Effect.promise(async () => await store.editPackageFile(name, { path, content }));
      if (!verdict.ok) {
        return yield* new Publish.NoSuchPackage({ message: verdict.message });
      }
      return { edited: name, file: path };
    }

    // A manifest edit merges by halves inside the store; the merged result
    // is validated here first, so the store never holds a manifest that
    // could not publish.
    const current = yield* Effect.promise(async () => await store.readPackage(name));
    if (current === null) {
      return yield* new Publish.NoSuchPackage({ message: `no package is named ${JSON.stringify(name)}` });
    }
    const merged: Manifest = {
      summary: summary ?? current.manifest.summary,
      exports: exports === undefined ? current.manifest.exports : [...exports],
    };
    const invalid = checkManifest(merged);
    if (invalid !== null) {
      return yield* invalid;
    }
    const verdict = yield* Effect.promise(
      async () =>
        await store.editPackageManifest(name, {
          ...(summary === undefined ? {} : { summary }),
          ...(exports === undefined ? {} : { exports: [...exports] }),
        }),
    );
    if (!verdict.ok) {
      return yield* new Publish.NoSuchPackage({ message: verdict.message });
    }
    return { edited: name, manifest: merged };
  });

export const run = (
  bindings: PackagesBindings,
  context: PackagesContext,
  input: Input,
): Effect.Effect<unknown, Failure.OptiError> => {
  const store = storeFor(bindings.OWNER_STORE, context.ownerId);
  switch (input.action) {
    case "create":
      return create(store, input);
    case "read":
      return read(store, input);
    case "edit":
      return edit(store, input);
    case "publish":
      return namedPackage(input).pipe(Effect.flatMap((name) => Publish.publish(bindings, context.ownerId, name)));
  }
};
