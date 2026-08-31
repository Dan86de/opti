/**
 * The `execute` tool: code and nothing else, so there is no second path for
 * data to reach the sandbox before anything needs one.
 *
 * The tool resolves the owner's capability set, has the virtual module
 * builder turn it into a module map, and hands the map to the runner. Slice 1
 * resolves the same built-ins for every owner; what stays true regardless is
 * that the grant is resolved here, at the tool, and the runner runs whatever
 * map it is given - authorization at the door, never inside.
 */
import { type Effect, Schema } from "effect";
import type { Owner } from "../identity/index.ts";
import type { Failure } from "../kernel/index.ts";
import { builtIns } from "../registry/Registry.ts";
import * as Runner from "./Runner.ts";
import * as VirtualModule from "./VirtualModule.ts";

export const parameters = Schema.Struct({
  code: Schema.String,
});

export const tool = {
  name: "execute",
  description:
    "Run a JavaScript module in a fresh sandbox and get its return value. " +
    '{code}: a complete ES module that default-exports an async function returning a JSON-serializable value. Import the capabilities search names from "opti:capabilities". ' +
    "No network, no environment; console output comes back as logs.",
  parametersSchema: parameters,
};

export const run = (
  bindings: Runner.RunnerBindings,
  ownerId: Owner.OwnerId,
  input: typeof parameters.Type,
): Effect.Effect<Runner.RunOutcome, Failure.OptiError> =>
  Runner.run(bindings, ownerId, VirtualModule.build(builtIns, input.code));
