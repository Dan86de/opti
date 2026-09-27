/**
 * A doubled GitHub, started once for the run.
 *
 * It exists because the real GitHub cannot be logged into from CI, and because
 * the parts worth testing are ours: the allowlist, the identity mapping, and
 * what the callback does with a shape GitHub hands back.
 *
 * SHORTCUT, recorded per the testing decisions: this proves our code handles a
 * GitHub-shaped response, and not that GitHub sends one. The real round trip is
 * verified by hand, once, against the deployed worker.
 *
 * Two behaviours here are copied from GitHub rather than invented, because both
 * are things a naive client gets wrong:
 *
 * - a failed token exchange is HTTP 200 with an `error` field in the body, not
 *   a 4xx. A client that only checks the status treats a bad code as a success.
 * - `/user` requires a `user-agent`, and refuses the request without one.
 */
import http from "node:http";
import {
  authorizationCode,
  SIGNED_IN,
  UPSTREAM_CLIENT_ID,
  UPSTREAM_CLIENT_SECRET,
  UPSTREAM_HOST,
  UPSTREAM_PORT,
} from "./upstream-address.ts";

const json = (response: http.ServerResponse, status: number, body: unknown) => {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
};

const readBody = (request: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
  });

/** The token is derived from the code, so the double holds no session state. */
const accessTokenFor = (code: string) => code.replace(/^code:/, "token:");

/**
 * The double on a port of the caller's choosing, so a verify run can keep its
 * own GitHub beside another run or beside the worker tests. The tests keep
 * the fixed port below; nothing about the double's answers depends on it.
 */
export async function serveUpstream(port: number) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${UPSTREAM_HOST}:${port}`);

    if (request.method === "POST" && url.pathname === "/login/oauth/access_token") {
      const form = new URLSearchParams(await readBody(request));
      if (form.get("client_id") !== UPSTREAM_CLIENT_ID || form.get("client_secret") !== UPSTREAM_CLIENT_SECRET) {
        return json(response, 200, { error: "incorrect_client_credentials" });
      }
      const code = form.get("code") ?? "";
      if (!/^code:[^:]+:[^:]+$/.test(code)) {
        return json(response, 200, { error: "bad_verification_code" });
      }
      return json(response, 200, { access_token: accessTokenFor(code), token_type: "bearer", scope: "" });
    }

    // The browser leg. A real GitHub would show a login screen here; the double
    // is always already logged in as one fixed user, so the happy path can be
    // driven by following redirects. Any other user is reached by calling our
    // callback directly with a code the test writes itself.
    if (request.method === "GET" && url.pathname === "/login/oauth/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", authorizationCode(SIGNED_IN.subject, SIGNED_IN.login));
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: back.toString() });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/user") {
      if (request.headers["user-agent"] === undefined) {
        return json(response, 403, { message: "Request forbidden by administrative rules." });
      }
      const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      const parsed = /^token:([^:]+):([^:]+)$/.exec(token);
      if (parsed === null) {
        return json(response, 401, { message: "Bad credentials" });
      }
      return json(response, 200, { id: Number(parsed[1]), login: parsed[2] });
    }

    return json(response, 404, { message: "Not Found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (cause: Error) =>
      reject(
        new Error(
          `the doubled upstream could not bind ${UPSTREAM_HOST}:${port} (${cause.message}). ` +
            "Free the port or change it in upstream-address.ts.",
        ),
      ),
    );
    server.listen(port, UPSTREAM_HOST, resolve);
  });

  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}

export default function startUpstream() {
  return serveUpstream(UPSTREAM_PORT);
}
