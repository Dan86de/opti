# Connect a host

The owner points an MCP host at OPTI, approves it once on a consent screen, signs in with GitHub, and the host finds exactly three tools.

## Entry points

- An MCP host calling `POST /mcp` without a token, then following the OAuth discovery it is pointed at.
- The consent screen at `/authorize`, which a person sees in a browser.

## Steps

- **Sign in the way a host does.** Run `verify login <run>`.
  It exits 0 and prints nine numbered hops:
  - `1. POST /mcp without a token -> HTTP 401` with `www-authenticate: Bearer realm="OAuth", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`.
  - `2. GET /.well-known/oauth-protected-resource/mcp -> HTTP 200` naming `"resource":"<origin>/mcp"` and `"resource_name":"OPTI"`.
  - `3. GET /.well-known/oauth-authorization-server -> HTTP 200` with authorize `<origin>/authorize`, token `<origin>/token`, register `<origin>/register`.
  - `4. POST /register (client_name "verify host") -> HTTP 201`.
  - `5. GET /authorize -> HTTP 200, heading "Authorize access to OPTI", button "Continue with GitHub"`.
  - `6. POST /authorize (Continue with GitHub) -> HTTP 302` to the stand-in's `/login/oauth/authorize`.
  - `7. GitHub double -> HTTP 302 to /callback/github`.
  - `8. GET /callback/github -> HTTP 302 back to the host's redirect_uri with a code`.
  - `9. POST /token -> HTTP 200, token_type bearer, expires_in 3600`.
  It ends with `signed in as github:4242`.
- **Read the consent screen.** This step has no helper command; its evidence is the file. Read `<run folder>/consent.html`, the raw HTML (stripping tags naively can lose the address, which sits alone in a `<dd>`).
  Its visible text says `Approve only if you started this yourself.`, then `Tokens will be sent to` `http://127.0.0.1:1`, then `This client calls itself` `verify host`, then the first-time notice `This client has not been approved before.`, then three lines under `Approving lets it:` (run code, use capabilities and packages, reach services you later approve), then the `Continue with GitHub` button.
- **See the consent screen.** Hop 5 also prints `to see it in a browser: <origin>/authorize?...`.
  Open that URL in the browser pane, in light and in dark.
  The card is readable in both, the address sits above the client's name, and nothing overflows.
  It no longer shows the first-time notice, because the login already approved this client; that is expected.
  Do not press the button: `verify login` already has.
- **Initialize.** Run `verify mcp <run> initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"verify host","version":"1"}}'`.
  HTTP 200 with `"protocolVersion": "2025-06-18"`, `"capabilities": {"tools": {}}` and `"serverInfo": {"name": "opti", "title": "OPTI", "version": "0.1.0"}`.
- **Exactly three tools.** Run `verify mcp <run> tools/list`.
  HTTP 200 with three tools, in order `search`, `execute`, `packages`, and no others.
- **A bad sign-in shows a page, not JSON.** In the browser pane, open `<origin>/callback/github?state=nope&code=x`.
  The page is titled `Could not sign you in`, says `That authorization has expired or was already used. Start again from your client.` and shows the tag `NoPendingAuthorization`.
  In light and dark it is readable, shows no scrollbar, and the text sits in the middle of the window.

## Behind it

The login leaves one owner and one client in `OAUTH_KV`:

```bash
verify inspect <run> kv
```

It lists `identity:github:4242 = own_<uuid>`, one `client:<id>`, one `client-seen:<id> = 1`, one `grant:own_<uuid>:...` and one `token:own_<uuid>:...`, and nothing else except the `pending:` keys below.
The login itself leaves no `pending:` key, because a pending authorization is single use.
Each time the consent page is opened afterwards it adds one `pending:<uuid>`, so run the command again after the browser step to see it, which expires after ten minutes; those are the only other keys allowed.

## Gotchas

- `verify login` twice in one run registers a second client; the owner stays the same `own_<uuid>`.
- The stand-in only ever signs in as `github:4242`. `NotAllowlisted` cannot be driven with it; that path is covered by `identity.test.ts`.
- A login that fails after hop 6 leaves its `pending:` key behind; that is a failed login, not a map error. Stop the run and start a fresh one.
- The consent redirect address `http://127.0.0.1:1` is the helper's pretend host. Nothing listens there, and nothing needs to: the helper reads the code off the redirect.
