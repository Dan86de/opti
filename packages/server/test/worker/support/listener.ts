/**
 * A TCP listener for the sandbox egress test, started once for the run.
 *
 * The egress test's negative assertions are only worth something if the target
 * is genuinely reachable, so this exists to be reached: the granted case is the
 * control that makes the denied case evidence rather than a tautology.
 *
 * It answers three kinds of connection because there are three ways out of an
 * isolate, and all three have to be shown to be closed:
 *
 * - `GET /count` reports how many probe connections have arrived. The test
 *   itself asks, from the host, which is how "no request was made" is asserted
 *   against the wire rather than against an error message.
 * - any other HTTP request is answered so `fetch` can complete.
 * - anything else is answered with the same banner, for a raw socket.
 *
 * Since Slice 2 it also plays the third-party API in the credential tests,
 * which adds three behaviours:
 *
 * - `GET /last` reports the raw head of the last probe, so a test can assert
 *   what actually crossed the wire - the substituted value, or its absence -
 *   from the host side. Like /count it is a question, not a probe.
 * - any request to `/echo` is answered with its own raw head as the body, so
 *   a test can make an API that reflects a credential back at the sandbox.
 * - `GET /redirect` answers 301 toward `/probe`, so a test can prove the
 *   gateway hands a credentialed redirect back as data instead of following
 *   it: if anything follows, the extra probe shows up in the count.
 */
import net from "node:net";
import { LISTENER_HOST, LISTENER_PORT } from "./listener-address.ts";

export const BANNER = "OPTI-ECHO";

export default async function startListener() {
  let probes = 0;
  let lastProbe = "";

  const http = (body: string) =>
    `HTTP/1.1 200 OK\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;

  const server = net.createServer((socket) => {
    // A probe that is refused mid-handshake must not take the listener down.
    socket.on("error", () => {});
    socket.once("data", (chunk) => {
      const head = chunk.toString();
      if (head.startsWith("GET /count")) {
        socket.end(http(String(probes)));
        return;
      }
      if (head.startsWith("GET /last")) {
        socket.end(http(lastProbe));
        return;
      }
      probes += 1;
      lastProbe = head;
      if (/^[A-Z]+ \/echo/.test(head)) {
        socket.end(http(head));
        return;
      }
      if (head.startsWith("GET /redirect-evil")) {
        // The same listener under a different name: a cross-host redirect
        // whose target is approved for nothing, for the hop-two denial test.
        socket.end(
          `HTTP/1.1 301 Moved Permanently\r\nlocation: http://localhost:${LISTENER_PORT}/steal\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`,
        );
        return;
      }
      if (head.startsWith("GET /redirect")) {
        socket.end(
          `HTTP/1.1 301 Moved Permanently\r\nlocation: /probe\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`,
        );
        return;
      }
      socket.end(head.startsWith("GET ") ? http(BANNER) : BANNER);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (cause: Error) =>
      reject(
        new Error(
          `the egress test's listener could not bind ${LISTENER_HOST}:${LISTENER_PORT} (${cause.message}). ` +
            "Free the port or change it in listener-address.ts - without the listener the egress test proves nothing.",
        ),
      ),
    );
    server.listen(LISTENER_PORT, LISTENER_HOST, resolve);
  });

  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}
