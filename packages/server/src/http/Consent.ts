/**
 * The screen that names what is being granted.
 *
 * Dynamic client registration makes this a security surface rather than a
 * formality: a client chooses its own name, so it can call itself anything at
 * all. The only thing on this page the client does not choose is where the
 * token will be sent, which is why the origin of the redirect URI leads and the
 * self-declared name is subordinate to it.
 */
import { escapeHtml } from "./html.ts";

export interface Consent {
  /** The opaque state token, which is also the form's CSRF token. */
  readonly state: string;
  /** Where the token goes if this is approved. Not chosen by the client. */
  readonly redirectOrigin: string;
  /** What the client calls itself. Chosen entirely by the client. */
  readonly clientName: string;
  /** True when this client has never been approved before. */
  readonly firstTime: boolean;
}

export const render = (consent: Consent): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize access to OPTI</title>
<style>
  :root { color-scheme: light dark; --fg: #16181d; --muted: #5b6270; --bg: #fbfbfd; --card: #fff; --line: #e3e5ea; --warn: #8a5a00; --warn-bg: #fff8e6; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8eaef; --muted: #9aa1b1; --bg: #101116; --card: #181a21; --line: #2a2d36; --warn: #f0c674; --warn-bg: #2a2213; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
         background: var(--bg); color: var(--fg);
         font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 27rem; background: var(--card); border: 1px solid var(--line);
         border-radius: 14px; padding: 28px; }
  h1 { margin: 0 0 4px; font-size: 1.15rem; letter-spacing: -0.01em; }
  p { margin: 0 0 16px; color: var(--muted); }
  dl { margin: 0 0 20px; padding: 16px; border: 1px solid var(--line); border-radius: 10px; }
  dt { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  dd { margin: 2px 0 14px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  dd:last-of-type { margin-bottom: 0; }
  ul { margin: 0 0 20px; padding-left: 1.1rem; color: var(--muted); }
  li { margin-bottom: 6px; }
  .notice { margin: 0 0 20px; padding: 10px 12px; border-radius: 8px;
            background: var(--warn-bg); color: var(--warn); font-size: 0.9rem; }
  button { width: 100%; padding: 11px; border: 0; border-radius: 9px; background: var(--fg);
           color: var(--bg); font: inherit; font-weight: 600; cursor: pointer; }
  button:hover { opacity: 0.9; }
</style>
</head>
<body>
<main>
  <h1>Authorize access to OPTI</h1>
  <p>Approve only if you started this yourself.</p>

  <dl>
    <dt>Tokens will be sent to</dt>
    <dd>${escapeHtml(consent.redirectOrigin)}</dd>
    <dt>This client calls itself</dt>
    <dd>${escapeHtml(consent.clientName)}</dd>
  </dl>

  ${consent.firstTime ? '<p class="notice">This client has not been approved before. Any client can register itself and choose its own name, so check the address above rather than the name.</p>' : ""}

  <p>Approving lets it:</p>
  <ul>
    <li>run code it writes, in your account, in a sandbox</li>
    <li>use capabilities and packages you own</li>
    <li>reach services you later save credentials for and approve a host for</li>
  </ul>

  <form method="post" action="/authorize">
    <input type="hidden" name="state" value="${escapeHtml(consent.state)}">
    <button type="submit">Continue with GitHub</button>
  </form>
</main>
</body>
</html>
`;
