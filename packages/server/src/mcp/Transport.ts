/**
 * The stateless MCP transport.
 *
 * Written by hand rather than on `McpServer.layerHttp`, per the Slice 1
 * decision: `layerHttp` keeps sessions in an in-memory map, and on Workers
 * that map lives in an isolate that can be evicted between requests, so a
 * well-behaved host would be told to start over at unpredictable moments.
 * This transport issues no session id at all, which the protocol permits, so
 * the 404-on-forgotten-session path does not exist.
 *
 * Only the shell is ours. Tool definitions are `Tool` from `effect`, argument
 * decoding is `Schema`, and the tests hold the wire shapes to `McpSchema`'s
 * account of the protocol.
 *
 * JSON-RPC errors are reserved for protocol faults - a body that is not JSON,
 * a method that does not exist, a tool name we do not serve. Anything that
 * goes wrong inside a tool crosses as a tool result carrying the envelope,
 * because a host that sees a JSON-RPC error may surface it as a malfunction
 * and never hand the payload to the model, which deletes the retry
 * classification and the approval link that Slice 2 depends on.
 */
import { Data, Effect, Schema } from "effect";
import { Tool } from "effect/unstable/ai";
import { Envelope, type Failure } from "../kernel/index.ts";

/**
 * The protocol revisions this transport can answer in. Order matters: the
 * first entry is what a client that asks for something unknown is offered.
 * Nothing OPTI serves differs between the two; both are listed so a host on
 * either side of the 2025-06-18 line connects without a downgrade dance.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];

const SERVER_INFO = { name: "opti", title: "OPTI", version: "0.1.0" };

/** JSON-RPC 2.0 error codes. Only the protocol-fault ones; see the docblock. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/**
 * A tool the transport serves: what `tools/list` advertises, and what
 * `tools/call` runs. Handlers are already bound to their owner context by
 * whoever built the list - the transport never sees an owner id, so it cannot
 * be the place where one leaks in from anywhere but the door.
 */
export interface ServedTool {
  readonly definition: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  };
  readonly call: (args: unknown) => Effect.Effect<unknown, Failure.OptiError>;
}

/**
 * The model wrote arguments the tool's schema refuses. Never retryable as
 * written: repeating the same arguments cannot help, and the message carries
 * what to change instead.
 */
export class InvalidArguments extends Data.TaggedError("InvalidArguments")<{
  readonly message: string;
}> {
  readonly retry: Failure.Retry = "never";
}

/**
 * Serve one `Tool` definition with its handler.
 *
 * The same schema does both jobs: it is advertised as JSON Schema in
 * `tools/list` and it decodes the arguments in `tools/call`, so what the model
 * was told and what is enforced cannot drift apart.
 */
export const serve = <Parameters extends Schema.Struct<Schema.Struct.Fields> & { readonly DecodingServices: never }>(
  tool: {
    readonly name: string;
    readonly description?: string | undefined;
    readonly parametersSchema: Parameters;
  },
  run: (input: Parameters["Type"]) => Effect.Effect<unknown, Failure.OptiError>,
): ServedTool => {
  const decodeArguments = Schema.decodeUnknownEffect(tool.parametersSchema);
  return {
    definition: {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: Tool.getJsonSchemaFromSchema(tool.parametersSchema),
    },
    call: (args) =>
      decodeArguments(args).pipe(
        Effect.mapError(
          (error) => new InvalidArguments({ message: `the arguments do not match ${tool.name}: ${error.message}` }),
        ),
        Effect.flatMap(run),
      ),
  };
};

/**
 * One incoming JSON-RPC message. `id` absent means a notification; nothing
 * here depends on which notification it is, because a stateless server has no
 * state for a notification to change.
 */
const JsonRpcMessage = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Any)),
});

const InitializeParams = Schema.Struct({
  protocolVersion: Schema.optionalKey(Schema.String),
});

const CallToolParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Any)),
});

type JsonRpcId = string | number | null;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const result = (id: JsonRpcId, value: unknown) => json(200, { jsonrpc: "2.0", id, result: value });

const rpcError = (status: number, id: JsonRpcId, code: number, message: string) =>
  json(status, { jsonrpc: "2.0", id, error: { code, message } });

/** 202 with no body: the protocol's answer to a notification. */
const accepted = () => new Response(null, { status: 202 });

const decodeMessage = Schema.decodeUnknownEffect(JsonRpcMessage);
const decodeInitializeParams = Schema.decodeUnknownEffect(InitializeParams);
const decodeCallToolParams = Schema.decodeUnknownEffect(CallToolParams);

/**
 * Answer one MCP request. Always resolves to a `Response`: every fault this
 * function can produce is a protocol fault with a JSON-RPC shape, and
 * everything that goes wrong inside a tool is folded into the envelope.
 */
export const handle = (request: Request, tools: readonly ServedTool[]): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (request.method !== "POST") {
      // No GET stream: a stateless server has nothing to push. 405 is the
      // answer the streamable HTTP transport specifies for exactly this.
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }

    const stated = request.headers.get("mcp-protocol-version");
    if (stated !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(stated)) {
      return rpcError(400, null, INVALID_REQUEST, `unsupported protocol version: ${stated}`);
    }

    const parsed = yield* Effect.tryPromise({ try: () => request.json(), catch: () => null }).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (parsed === undefined) {
      return rpcError(400, null, PARSE_ERROR, "the body is not JSON");
    }
    if (Array.isArray(parsed)) {
      // 2025-06-18 removed batching from the protocol; a stateless server
      // gains nothing by keeping it for older clients.
      return rpcError(400, null, INVALID_REQUEST, "batched requests are not supported; send one message per POST");
    }

    const decoded = yield* Effect.exit(decodeMessage(parsed));
    if (decoded._tag === "Failure") {
      return rpcError(400, null, INVALID_REQUEST, "that is not a JSON-RPC 2.0 message");
    }
    const message = decoded.value;

    if (!("id" in message)) {
      // A notification. There is deliberately no dispatch on the method: with
      // no session there is no state for `initialized` or `cancelled` to
      // change, so acknowledging is the whole job.
      return accepted();
    }
    const id = message.id;
    const params: unknown = "params" in message ? message.params : {};

    switch (message.method) {
      case "initialize": {
        const initialize = yield* Effect.exit(decodeInitializeParams(params));
        if (initialize._tag === "Failure") {
          return rpcError(200, id, INVALID_PARAMS, "initialize needs a protocolVersion string");
        }
        const requested = "protocolVersion" in initialize.value ? initialize.value.protocolVersion : undefined;
        return result(id, {
          protocolVersion:
            requested !== undefined && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      }

      case "ping":
        return result(id, {});

      case "tools/list":
        return result(id, { tools: tools.map((tool) => tool.definition) });

      case "tools/call": {
        const call = yield* Effect.exit(decodeCallToolParams(params));
        if (call._tag === "Failure") {
          return rpcError(200, id, INVALID_PARAMS, "tools/call needs a tool name and an arguments object");
        }
        const tool = tools.find((candidate) => candidate.definition.name === call.value.name);
        if (tool === undefined) {
          // A tool we do not serve is a protocol fault, not a tool failure:
          // there is no tool whose result could carry the envelope.
          const known = tools.map((candidate) => candidate.definition.name).join(", ");
          return rpcError(200, id, INVALID_PARAMS, `no tool is named ${call.value.name}. The tools here: ${known}`);
        }

        const args: unknown = "arguments" in call.value ? call.value.arguments : {};
        const envelope = Envelope.fromExit(yield* Effect.exit(tool.call(args)));
        return result(id, {
          content: [{ type: "text", text: JSON.stringify(envelope) }],
          structuredContent: envelope,
          // `isError` mirrors `ok`, and only when it is a signal: an absent
          // field means the boring default.
          ...(envelope.ok ? {} : { isError: true }),
        });
      }

      default:
        return rpcError(200, id, METHOD_NOT_FOUND, `no method is named ${message.method}`);
    }
  });
