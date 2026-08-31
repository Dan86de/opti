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
 */
import net from "node:net";
import { LISTENER_HOST, LISTENER_PORT } from "./listener-address.ts";

export const BANNER = "OPTI-ECHO";

export default async function startListener() {
  let probes = 0;

  const http = (body: string) =>
    `HTTP/1.1 200 OK\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`;

  const server = net.createServer((socket) => {
    // A probe that is refused mid-handshake must not take the listener down.
    socket.on("error", () => {});
    socket.once("data", (chunk) => {
      const head = chunk.toString();
      if (head.startsWith("GET /count")) {
        socket.end(http(String(probes)));
        return;
      }
      probes += 1;
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
