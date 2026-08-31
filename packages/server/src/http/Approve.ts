/**
 * The approval link's landing page.
 *
 * `GET /approve?credential=NAME&host=HOST` renders the grant in plain words
 * and the exact operator command to run; it writes nothing, reads nothing and
 * needs no auth. The URL shape is the stable contract: when a web application
 * eventually exists, the same URL starts performing the approval behind
 * authentication, and every link in an old conversation keeps working.
 *
 * The page states the grant before the command - the same discipline as the
 * authorize screen leading with the redirect origin - because whoever can
 * provoke a denial can also craft this link.
 */
import { NAME_PATTERN } from "../gateway/Placeholder.ts";
import { escapeHtml } from "./html.ts";

/** The same shape the admin surface accepts; anything else gets no command. */
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

const page = (title: string, main: string, status: number) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${escapeHtml(title)}</title>` +
      `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;` +
      `font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif;color-scheme:light dark}` +
      `main{max-width:36rem}h1{font-size:1.15rem;margin:0 0 8px}p{margin:0 0 12px}` +
      `pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;` +
      `padding:12px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);` +
      `border-radius:6px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}</style>` +
      `</head><body><main>${main}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

export const handle = (request: Request): Response | null => {
  const url = new URL(request.url);
  if (url.pathname !== "/approve" || request.method !== "GET") {
    return null;
  }

  const credential = url.searchParams.get("credential") ?? "";
  const host = url.searchParams.get("host") ?? "";
  if (!NAME_PATTERN.test(credential) || !HOST_PATTERN.test(host)) {
    return page(
      "Not a grant",
      `<h1>Not a grant</h1><p>This link does not name a valid credential and host pair, so there is nothing to approve.</p>`,
      400,
    );
  }

  const command =
    `OPTI_ORIGIN=${url.origin} \\\n` +
    `OPTI_OPERATOR_TOKEN=... \\\n` +
    `./scripts/operator.sh approve-host <your-upstream-identity> ${credential} ${host}`;

  // The grant first, in plain words, then the command. The denial message
  // already named both, so a reader arriving here has seen them once.
  return page(
    "Approve egress",
    `<h1>Approve egress?</h1>` +
      `<p>This would allow the credential named <strong>${escapeHtml(credential)}</strong> to be sent to ` +
      `<strong>${escapeHtml(host)}</strong> - that exact host, nothing wider - every time your agent asks, ` +
      `until you say otherwise.</p>` +
      `<p>Approval is deliberately unreachable from every agent surface. If you decide to grant it, run this ` +
      `from your terminal, with your own identity (for example <code>github:12345</code>):</p>` +
      `<pre>${escapeHtml(command)}</pre>` +
      `<p>If you did not expect this link, do nothing: deny is the default and stays the default.</p>`,
    200,
  );
};
