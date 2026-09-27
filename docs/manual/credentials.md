# Credentials and host approval

An agent writes a credential's name where its value goes, and OPTI substitutes the value outside the sandbox only for a host the owner approved; until then the agent gets a never-retry denial with an approval link to hand to the owner, and the value never shows up in output, records or storage.

## Entry points

- `{{credential:<name>}}` inside a request made with the `fetch` capability, from an executed module.
- The approval link a denial carries: `GET /approve?credential=<name>&host=<host>`, a page a person reads.
- The operator command, `scripts/operator.sh save-credential` and `approve-host`, which calls `POST /admin/save-credential` and `POST /admin/approve-host` with the operator token.

## Steps

Preconditions: `verify login <run>`, which is also what creates the owner `github:4242` that the operator commands address (without it they answer `UnknownIdentity`), and the machine can reach `https://httpbin.org`.

- **An unknown credential.** `modules/cred-fetch.js`:

  ```js
  import { fetch } from "opti:capabilities";
  export default async () => {
    const response = await fetch("https://httpbin.org/headers", {
      headers: { authorization: "Bearer {{credential:demo}}" },
    });
    return { status: response.status, body: await response.text() };
  };
  ```

  Run `verify exec <run> <run folder>/modules/cred-fetch.js`.
  It exits 2 with `envelope: failure UnknownCredential (retry never)` and a message starting `no credential named "demo" is saved.` that names the `./scripts/operator.sh save-credential` command.
- **Save it.** Run `OPTI_CREDENTIAL_VALUE=verify-demo-secret-value verify operator <run> save-credential github:4242 demo`.
  It prints `{"ok":true,"value":{"saved":"demo"}}` and `operator.sh exit 0`.
  The transcript records the command without the `OPTI_CREDENTIAL_VALUE` prefix, on purpose; say in the check's note that the value came from it.
- **Saved is not approved.** Run `verify exec <run> <run folder>/modules/cred-fetch.js`.
  It exits 2 with `envelope: failure HostNotApproved (retry never)`, the message `host httpbin.org is not approved for credential "demo".` and an `action` of `{"kind": "approve-host", "url": "<origin>/approve?credential=demo&host=httpbin.org"}`.
- **The approval link.** Run `verify http <run> GET "/approve?credential=demo&host=httpbin.org"`.
  HTTP 200, `text/html`, with the `<title>` `Approve egress` and the heading `Approve egress?`; it names `demo` and `httpbin.org`, says `that exact host, nothing wider`, and shows the command `OPTI_ORIGIN=<origin> \`, `OPTI_OPERATOR_TOKEN=... \`, `./scripts/operator.sh approve-host <your-upstream-identity> demo httpbin.org`.
  Open the same URL in the browser pane, in light and in dark: readable, no scrollbar, and the command wraps inside its box without splitting `httpbin.org` in the middle.
- **The admin routes need the operator token.** Run `verify http <run> POST /admin/approve-host '{"identity":"github:4242","credential":"demo","host":"evil.example"}'`.
  HTTP 401 with `"tag": "OperatorUnauthorized"`.
- **A host is an exact hostname.** Run `verify operator <run> approve-host github:4242 demo "https://httpbin.org"`.
  It prints `"tag":"MalformedAdminRequest"` with `a host is an exact hostname - no scheme, no port, no path, no wildcards`, and a non-zero `operator.sh exit`.
- **Approve it.** Run `verify operator <run> approve-host github:4242 demo httpbin.org`.
  `{"ok":true,"value":{"approved":{"credential":"demo","host":"httpbin.org"}}}` and `operator.sh exit 0`.
- **The credentialed fetch.** Run `verify exec <run> <run folder>/modules/cred-fetch.js`.
  `envelope: ok` with `"status": 200`, and the body httpbin echoes back reads `"Authorization": "Bearer [redacted:demo]"`: the value went out, and did not come back in.

## Behind it

The value is nowhere a run or the owner store can see it:

```bash
verify inspect <run> store "SELECT count(*) AS records, sum(instr(record, 'verify-demo-secret-value') > 0) AS with_plaintext, sum(instr(record, '[redacted:demo]') > 0) AS with_marker FROM run_records"
verify inspect <run> vault verify-demo-secret-value
verify inspect <run> vault httpbin.org
```

The first prints `with_plaintext` `0` and `with_marker` `1`: one record carries the redaction marker and none carries the value.
The second lists, among the daily `counter:` keys, `credential:demo` and `hosts:demo`, each with `"contains_needle": 0`: the vault holds the credential encrypted, never as plain text.
The third is its control: `hosts:demo` has `"contains_needle": 1`, which proves the search can see plain text when it is there.

## Gotchas

- The last step and its record check need the public internet; offline, the fetch fails with a network error, and that check is `not driven`, not `fail`.
- The run's operator token is the helper's own; `verify operator` supplies it. Never pass a real operator token or a real credential value to a run.
- The daily fetch budget in a run is the production one, 5000, so a run never trips it by accident.
