#!/usr/bin/env node
/**
 * The verify helper: starts one isolated OPTI (wrangler dev + a GitHub double)
 * per run, drives it the way an MCP host and the operator do, reads what it
 * left behind, and stops exactly what it started.
 *
 * Every call is appended to <run>/transcript.log with its exact command line
 * and everything it printed, refusals and failures included.
 *
 * Usage: see SKILL.md beside this file. `opti-verify.mjs help` prints it short.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER = path.join(REPO, "packages/server");
const SCRATCH = path.join(REPO, ".scratch/verify");
const WRANGLER = path.join(SERVER, "node_modules/wrangler/bin/wrangler.js");
const DOUBLE = path.join(SERVER, "test/worker/support/upstream.ts");
const OPERATOR_SH = path.join(REPO, "scripts/operator.sh");

// The identity the GitHub double is always signed in as, and so the only
// owner a run's allowlist admits. Kept in step with SIGNED_IN in
// test/worker/support/upstream-address.ts.
const SIGNED_IN_IDENTITY = "github:4242";

// Verify-only secrets. Never a real value: these exist so the run's worker
// has every binding production has, and they live only in the run folder.
const RUN_SECRETS = {
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  OWNER_ALLOWLIST: SIGNED_IN_IDENTITY,
  OPERATOR_TOKEN: "verify-operator-token",
  CREDENTIAL_KEY: "verify-credential-key-with-enough-entropy",
};

const REDIRECT_URI = "http://127.0.0.1:1/verify-host/callback";
const MCP_PROTOCOL = "2025-11-25";

// ---------------------------------------------------------------- output

let transcript = null;
/** Plain output for commands that belong to no run, so nothing to transcribe. */
const say = (text) => process.stdout.write(`${text}\n`);
const out = [];
const print = (line = "") => {
  out.push(line);
  process.stdout.write(`${line}\n`);
};
const quote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`);
const flush = (code) => {
  if (transcript !== null) {
    const command = [".agents/skills/verify/opti-verify.mjs", ...process.argv.slice(2)].map(quote).join(" ");
    fs.appendFileSync(transcript, `\n$ ${command}\n${out.join("\n")}\n[exit ${code}] ${new Date().toISOString()}\n`);
  }
};
const finish = (code) => {
  flush(code);
  process.exit(code);
};
const refuse = (message) => {
  print(`REFUSED: ${message}`);
  print("Nothing was changed.");
  finish(3);
};
const fail = (message) => {
  print(`FAILED: ${message}`);
  finish(1);
};

// ---------------------------------------------------------------- run state

const runDir = (run) => {
  if (run === undefined || !/^[\w-]+$/.test(run)) {
    refuse(`"${run ?? ""}" is not a run id. Pass the id \`start\` printed (a folder under .scratch/verify/).`);
  }
  const dir = path.join(SCRATCH, run);
  if (!fs.existsSync(path.join(dir, "run.json"))) {
    refuse(`no run ${run} under .scratch/verify/. This helper only drives runs it started.`);
  }
  transcript = path.join(dir, "transcript.log");
  return dir;
};
const readRun = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
const writeRun = (dir, state) => fs.writeFileSync(path.join(dir, "run.json"), `${JSON.stringify(state, null, 2)}\n`);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const commandOf = (pid) => spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
const childrenOf = (pid) =>
  spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean)
    .map(Number);
const treeOf = (pid) => {
  const all = [];
  const walk = (p) => {
    for (const child of childrenOf(p)) {
      all.push(child);
      walk(child);
    }
  };
  walk(pid);
  return all;
};
const listenerPids = (port) =>
  spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean)
    .map(Number);

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** The stand-in answers anything it does not know with GitHub's own 404. */
const doubleAnswers = async (origin) => {
  try {
    const response = await fetch(`${origin}/verify-probe`);
    return response.status === 404 && (await response.text()).includes("Not Found");
  } catch {
    return false;
  }
};

/** A fingerprint of everything the worker bundles, so doctor can say "stale". */
const buildFingerprint = () => {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        hash.update(path.relative(SERVER, full));
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(path.join(SERVER, "src"));
  hash.update(fs.readFileSync(path.join(SERVER, "wrangler.jsonc")));
  return hash.digest("hex").slice(0, 16);
};

const git = (...args) => spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).stdout.trim();

// ---------------------------------------------------------------- http

const request = async (state, method, pathname, { headers = {}, body, redirect = "manual" } = {}) => {
  const response = await fetch(`${state.origin}${pathname}`, { method, headers, body, redirect });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
};

const printResponse = ({ status, headers, text }, { showHeaders = [] } = {}) => {
  print(`HTTP ${status}`);
  for (const name of showHeaders) {
    const value = headers.get(name);
    if (value !== null) print(`${name}: ${value}`);
  }
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {}
  if (pretty.length > 0) print(pretty);
};

const token = (dir) => {
  const file = path.join(dir, "access-token");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null;
};

const rpc = async (state, dir, method, params) => {
  const bearer = token(dir);
  if (bearer === null) refuse("this run has not signed in. Run `login <run>` first.");
  return request(state, "POST", "/mcp", {
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
};

// ---------------------------------------------------------------- guards

/** Refuse to drive anything but this run's own live worker. */
const requireLive = (dir, state) => {
  if (!alive(state.wranglerPid) || !commandOf(state.wranglerPid).includes(dir)) {
    refuse(`run ${state.run} is not running (wrangler pid ${state.wranglerPid} is gone or is not this run's).`);
  }
};

// ---------------------------------------------------------------- commands

const start = async () => {
  const run = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")}-${randomBytes(3).toString("hex")}`;
  const dir = path.join(SCRATCH, run);
  fs.mkdirSync(path.join(dir, "home"), { recursive: true });
  fs.mkdirSync(path.join(dir, "modules"));
  transcript = path.join(dir, "transcript.log");

  const [port, inspectorPort, upstreamPort] = [await freePort(), await freePort(), await freePort()];
  const upstreamOrigin = `http://127.0.0.1:${upstreamPort}`;

  fs.writeFileSync(
    path.join(dir, "secrets.env"),
    `${Object.entries(RUN_SECRETS)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\n`,
  );

  // Only what a process needs to run. The user's CLOUDFLARE_* and WRANGLER_*
  // settings, their wrangler login and their shell config stay out: HOME is
  // the run's own empty folder.
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(dir, "home"),
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_LOG_PATH: path.join(dir, "wrangler-logs"),
    CI: "1",
  };

  const doubleLog = fs.openSync(path.join(dir, "github-double.log"), "a");
  const double = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { serveUpstream } = await import(${JSON.stringify(DOUBLE)}); await serveUpstream(${upstreamPort}); process.stdout.write("github double on ${upstreamOrigin} for ${dir}\\n");`,
    ],
    { cwd: dir, env, detached: true, stdio: ["ignore", doubleLog, doubleLog] },
  );
  double.unref();

  const devLog = fs.openSync(path.join(dir, "dev.log"), "a");
  const wrangler = spawn(
    process.execPath,
    [
      WRANGLER,
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      path.join(dir, "state"),
      "--env-file",
      path.join(dir, "secrets.env"),
      "--var",
      `GITHUB_ORIGIN:${upstreamOrigin}`,
      "--var",
      `GITHUB_API_ORIGIN:${upstreamOrigin}`,
      "--enable-containers=false",
      "--show-interactive-dev-session=false",
    ],
    { cwd: SERVER, env, detached: true, stdio: ["ignore", devLog, devLog] },
  );
  wrangler.unref();

  const state = {
    run,
    dir,
    origin: `http://127.0.0.1:${port}`,
    port,
    inspectorPort,
    upstreamOrigin,
    upstreamPort,
    wranglerPid: wrangler.pid,
    doublePid: double.pid,
    commit: git("rev-parse", "HEAD"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
    build: buildFingerprint(),
    startedAt: new Date().toISOString(),
  };
  writeRun(dir, state);

  const deadline = Date.now() + 90_000;
  let workerReady = false;
  let doubleReady = false;
  while (Date.now() < deadline && !(workerReady && doubleReady)) {
    if (!alive(wrangler.pid) || !alive(double.pid)) break;
    if (!workerReady) {
      try {
        const health = await request(state, "GET", "/health");
        workerReady = health.status === 200 && health.text.includes('"service":"opti"');
      } catch {}
    }
    if (!doubleReady) doubleReady = await doubleAnswers(upstreamOrigin);
    if (!(workerReady && doubleReady)) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const ready = workerReady && doubleReady;

  fs.writeFileSync(
    path.join(dir, "evidence.md"),
    [
      `# Verify run ${run}`,
      "",
      `- Commit: \`${state.commit}\` on \`${state.branch}\``,
      `- Uncommitted changes: ${state.dirty ? "yes" : "no"}`,
      `- Started: ${state.startedAt}`,
      "",
      "## Verdict",
      "",
      "_Fill in: Done / Done, with n not driven (name them) / Not done (name the failed checks) / Done once the map changes in this PR._",
      "",
      "## Checks",
      "",
    ].join("\n"),
  );

  print(`run: ${run}`);
  print(`folder: .scratch/verify/${run}`);
  print(`origin: ${state.origin}`);
  print(`github double: ${upstreamOrigin} (always signed in as ${SIGNED_IN_IDENTITY})`);
  print(`wrangler pid: ${wrangler.pid}, github double pid: ${double.pid}`);
  print(`commit: ${state.commit} (${state.branch}${state.dirty ? ", uncommitted changes" : ""})`);
  if (!ready) {
    print("");
    if (!workerReady) {
      print("NOT READY: the worker's /health did not answer within 90s. Last lines of dev.log:");
      print(fs.readFileSync(path.join(dir, "dev.log"), "utf8").split("\n").slice(-25).join("\n"));
    }
    if (!doubleReady) {
      print("NOT READY: the GitHub stand-in did not answer. github-double.log:");
      print(fs.readFileSync(path.join(dir, "github-double.log"), "utf8").trimEnd());
    }
    print(`Run \`stop ${run}\` before trying again.`);
    finish(1);
  }
  print('ready: GET /health answered {"ok":true,"value":{"service":"opti"}}, and the GitHub stand-in answers');
  finish(0);
};

const doctor = async (run) => {
  const dir = runDir(run);
  const state = readRun(dir);
  const problems = [];
  const line = (ok, what) => {
    print(`${ok ? "ok  " : "BAD "} ${what}`);
    if (!ok) problems.push(what);
  };

  const wranglerUp = alive(state.wranglerPid) && commandOf(state.wranglerPid).includes(dir);
  line(
    wranglerUp,
    wranglerUp
      ? `wrangler pid ${state.wranglerPid} is alive and was started for this run folder`
      : `wrangler pid ${state.wranglerPid} has exited (see dev.log)`,
  );
  const doubleUp = alive(state.doublePid) && commandOf(state.doublePid).includes(dir);
  line(
    doubleUp,
    doubleUp
      ? `github double pid ${state.doublePid} is alive and was started for this run folder`
      : `github double pid ${state.doublePid} has exited (see github-double.log)`,
  );
  line(await doubleAnswers(state.upstreamOrigin), `the GitHub stand-in answers on ${state.upstreamOrigin}`);

  const tree = wranglerUp ? treeOf(state.wranglerPid) : [];
  const owners = listenerPids(state.port);
  line(
    owners.length > 0 && owners.every((pid) => tree.includes(pid) || pid === state.wranglerPid),
    `port ${state.port} is served by this run's process tree (listeners: ${owners.join(", ") || "none"})`,
  );

  let healthy = false;
  try {
    const health = await request(state, "GET", "/health");
    healthy = health.status === 200 && health.text.includes('"service":"opti"');
  } catch {}
  line(healthy, `GET ${state.origin}/health answers as opti`);

  const current = buildFingerprint();
  line(
    current === state.build,
    current === state.build
      ? "packages/server/src and wrangler.jsonc are unchanged since start (current build)"
      : "packages/server/src or wrangler.jsonc changed since start: stop this run and start a new one",
  );

  const bearer = token(dir);
  if (bearer === null) {
    print("--   not signed in yet (run `login` to sign in as the owner)");
  } else if (healthy) {
    const listed = await rpc(state, dir, "tools/list");
    line(listed.status === 200, `signed in: tools/list with the run's token answers HTTP ${listed.status}`);
  }

  print("");
  print(problems.length === 0 ? "FIT: this instance is worth driving." : `UNFIT: ${problems.length} problem(s) above.`);
  finish(problems.length === 0 ? 0 : 1);
};

const login = async (run) => {
  const dir = runDir(run);
  const state = readRun(dir);
  requireLive(dir, state);

  // 1. What a host does first: call /mcp with no token and read the 401.
  const bare = await request(state, "POST", "/mcp", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  print(`1. POST /mcp without a token -> HTTP ${bare.status}`);
  print(`   www-authenticate: ${bare.headers.get("www-authenticate")}`);

  const resourceMeta = await request(state, "GET", "/.well-known/oauth-protected-resource/mcp");
  print(`2. GET /.well-known/oauth-protected-resource/mcp -> HTTP ${resourceMeta.status} ${resourceMeta.text}`);
  const serverMeta = await request(state, "GET", "/.well-known/oauth-authorization-server");
  const endpoints = JSON.parse(serverMeta.text);
  print(
    `3. GET /.well-known/oauth-authorization-server -> HTTP ${serverMeta.status}: authorize ${endpoints.authorization_endpoint}, token ${endpoints.token_endpoint}, register ${endpoints.registration_endpoint}`,
  );

  // 2. Dynamic registration, as a public client, like a desktop host.
  const registered = await request(state, "POST", "/register", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "verify host",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (registered.status !== 201 && registered.status !== 200) {
    fail(`POST /register answered HTTP ${registered.status}: ${registered.text}`);
  }
  const client = JSON.parse(registered.text);
  print(`4. POST /register (client_name "verify host") -> HTTP ${registered.status}, client_id ${client.client_id}`);

  // 3. The consent screen a person would see.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    state: "verify-host-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${state.origin}/mcp`,
  });
  const consent = await request(state, "GET", `/authorize?${authorize}`);
  fs.writeFileSync(path.join(dir, "consent.html"), consent.text);
  const title = /<h1>(.*?)<\/h1>/s.exec(consent.text)?.[1];
  const button = /<button[^>]*>(.*?)<\/button>/s.exec(consent.text)?.[1];
  const formState = /name="state" value="([^"]+)"/.exec(consent.text)?.[1];
  print(
    `5. GET /authorize -> HTTP ${consent.status}, heading "${title}", button "${button}" (page saved to consent.html)`,
  );
  print(`   to see it in a browser: ${state.origin}/authorize?${authorize}`);
  if (formState === undefined) fail("the consent page carries no state field; see consent.html");

  // 4. Press the button: the form posts, and the browser follows redirects.
  const posted = await request(state, "POST", "/authorize", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ state: formState }).toString(),
  });
  const toGithub = posted.headers.get("location") ?? "";
  print(
    `6. POST /authorize (Continue with GitHub) -> HTTP ${posted.status} to ${new URL(toGithub).origin}${new URL(toGithub).pathname}`,
  );
  const github = await fetch(toGithub, { redirect: "manual" });
  const toCallback = github.headers.get("location") ?? "";
  print(`7. GitHub double -> HTTP ${github.status} to ${new URL(toCallback).pathname}`);
  const callback = await fetch(toCallback, { redirect: "manual" });
  const toHost = callback.headers.get("location") ?? "";
  if (callback.status !== 302 || !toHost.startsWith(REDIRECT_URI)) {
    const text = await callback.text();
    fail(
      `GET /callback/github answered HTTP ${callback.status}: ${text
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()}`,
    );
  }
  const code = new URL(toHost).searchParams.get("code");
  print(`8. GET /callback/github -> HTTP ${callback.status} back to the host's redirect_uri with a code`);

  // 5. The host trades the code for a token.
  const exchanged = await request(state, "POST", "/token", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
    }).toString(),
  });
  if (exchanged.status !== 200) fail(`POST /token answered HTTP ${exchanged.status}: ${exchanged.text}`);
  const granted = JSON.parse(exchanged.text);
  fs.writeFileSync(path.join(dir, "access-token"), `${granted.access_token}\n`, { mode: 0o600 });
  print(
    `9. POST /token -> HTTP 200, token_type ${granted.token_type}, expires_in ${granted.expires_in} (token saved to access-token)`,
  );

  state.identity = SIGNED_IN_IDENTITY;
  writeRun(dir, state);
  print("");
  print(`signed in as ${SIGNED_IN_IDENTITY}`);
  finish(0);
};

const mcp = async (run, method, params) => {
  const dir = runDir(run);
  const state = readRun(dir);
  requireLive(dir, state);
  if (method === undefined) refuse("name a JSON-RPC method, e.g. `mcp <run> tools/list`.");
  const parsed = params === undefined ? undefined : JSON.parse(readArg(params));
  const response = await rpc(state, dir, method, parsed);
  printResponse(response);
  finish(response.status === 200 ? 0 : 1);
};

/** `@file` reads the file; anything else is the literal text. */
const readArg = (arg) => (arg.startsWith("@") ? fs.readFileSync(arg.slice(1), "utf8") : arg);

const tool = async (run, name, args) => {
  const dir = runDir(run);
  const state = readRun(dir);
  requireLive(dir, state);
  if (name === undefined) refuse("name a tool: search, execute or packages.");
  const response = await rpc(state, dir, "tools/call", { name, arguments: JSON.parse(readArg(args ?? "{}")) });
  if (response.status !== 200) {
    printResponse(response);
    finish(1);
  }
  const body = JSON.parse(response.text);
  if (body.error !== undefined) {
    print(`JSON-RPC error ${body.error.code}: ${body.error.message}`);
    finish(1);
  }
  const envelope = body.result.structuredContent;
  print(`envelope: ${envelope.ok ? "ok" : `failure ${envelope.error.tag} (retry ${envelope.error.retry})`}`);
  print(JSON.stringify(envelope, null, 2));
  finish(envelope.ok ? 0 : 2);
};

const exec = async (run, file) => {
  if (file === undefined || !fs.existsSync(file)) refuse("pass a file holding the module to execute.");
  return tool(run, "execute", JSON.stringify({ code: fs.readFileSync(file, "utf8") }));
};

const http = async (run, method, pathname, body) => {
  const dir = runDir(run);
  const state = readRun(dir);
  requireLive(dir, state);
  if (method === undefined || pathname === undefined || !pathname.startsWith("/")) {
    refuse("usage: http <run> <METHOD> </path> [body|@file]. Paths only: this helper never takes an origin.");
  }
  const response = await request(state, method.toUpperCase(), pathname, {
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : readArg(body),
  });
  printResponse(response, { showHeaders: ["content-type", "location", "www-authenticate"] });
  finish(0);
};

const operator = async (run, ...args) => {
  const dir = runDir(run);
  const state = readRun(dir);
  requireLive(dir, state);
  const verb = args[0];
  if (verb !== "approve-host" && verb !== "save-credential") {
    refuse("operator takes approve-host or save-credential, exactly as scripts/operator.sh does.");
  }
  // The operator script, pointed at this run and nothing else. The value for
  // save-credential comes from OPTI_CREDENTIAL_VALUE, never from argv.
  const result = spawnSync(OPERATOR_SH, args, {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      OPTI_ORIGIN: state.origin,
      OPTI_OPERATOR_TOKEN: RUN_SECRETS.OPERATOR_TOKEN,
      ...(process.env.OPTI_CREDENTIAL_VALUE ? { OPTI_CREDENTIAL_VALUE: process.env.OPTI_CREDENTIAL_VALUE } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  print(`scripts/operator.sh ${args.map(quote).join(" ")} (OPTI_ORIGIN=${state.origin})`);
  if (result.stdout) print(result.stdout.trimEnd());
  if (result.stderr) print(result.stderr.trimEnd());
  print(`operator.sh exit ${result.status}`);
  finish(result.status === 0 ? 0 : 1);
};

const explorer = async (state, pathname, body) => {
  const response = await fetch(`${state.origin}/cdn-cgi/local/explorer/api${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return JSON.parse(await response.text());
};

const sqlString = (text) => `'${text.replaceAll("'", "''")}'`;

const readOnly = (sql) =>
  /^\s*(select|with|pragma\s+table_list|pragma\s+table_info)\b/i.test(sql) && !/;\s*\S/.test(sql);

const inspect = async (run, what, arg) => {
  const dir = runDir(run);
  const state = readRun(dir);
  requireLive(dir, state);

  if (what === "kv") {
    const listed = await explorer(state, "/storage/kv/namespaces/431d14eada56489b9602cf650efed706/keys");
    const keys = listed.result.map((k) => k.name).filter((name) => arg === undefined || name.startsWith(arg));
    print(`OAUTH_KV keys${arg === undefined ? "" : ` starting with "${arg}"`}: ${keys.length}`);
    for (const key of keys) {
      const value = await fetch(
        `${state.origin}/cdn-cgi/local/explorer/api/storage/kv/namespaces/431d14eada56489b9602cf650efed706/values/${encodeURIComponent(key)}`,
      ).then((r) => r.text());
      print(
        `${key} = ${key.startsWith("identity:") || key.startsWith("client-seen:") ? value : `<${value.length} chars>`}`,
      );
    }
    finish(0);
  }

  if (what === "store") {
    if (arg === undefined || !readOnly(arg)) {
      refuse("inspect store takes one read-only statement: SELECT, WITH, or PRAGMA table_list/table_info.");
    }
    const owner = await ownerId(state);
    if (owner === null) refuse("no owner yet: `login` first, so the identity mapping exists.");
    const result = await explorer(state, "/workers/durable_objects/namespaces/opti-OwnerStore/query", {
      durable_object_name: owner,
      queries: [{ sql: arg }],
    });
    if (!result.success) fail(JSON.stringify(result.errors));
    print(`OwnerStore of ${owner}: ${arg}`);
    print(JSON.stringify(result.result, null, 2));
    finish(0);
  }

  if (what === "vault") {
    // The vault keeps everything in the durable object KV API, whose table
    // the explorer refuses to query, so this reads the object's own SQLite
    // file from the run's state folder, opened read-only.
    const owner = await ownerId(state);
    if (owner === null) refuse("no owner yet: `login` first, so the identity mapping exists.");
    const objects = await explorer(state, "/workers/durable_objects/namespaces/opti-OwnerVault/objects");
    const object = objects.result.find((o) => o.name === owner);
    if (object === undefined) {
      print(`OwnerVault of ${owner}: never written (no object yet)`);
      finish(0);
    }
    const file = path.join(dir, "state/v3/do/opti-OwnerVault", `${object.id}.sqlite`);
    const needle =
      arg === undefined ? "" : `, instr(CAST(value AS BLOB), CAST(${sqlString(arg)} AS BLOB)) > 0 AS contains_needle`;
    const read = spawnSync(
      "sqlite3",
      ["-readonly", "-json", file, `SELECT key, length(value) AS bytes${needle} FROM _cf_KV ORDER BY key`],
      { encoding: "utf8" },
    );
    if (read.status !== 0) fail(read.stderr.trim());
    print(
      `OwnerVault of ${owner}: keys and sizes${arg === undefined ? "" : `, and whether each value contains ${JSON.stringify(arg)}`}`,
    );
    print(JSON.stringify(JSON.parse(read.stdout || "[]"), null, 2));
    finish(0);
  }

  if (what === "logs") {
    const sql = arg ?? "SELECT created_at, level, message FROM logs ORDER BY ts_ms DESC LIMIT 20";
    if (!readOnly(sql)) refuse("inspect logs takes one SELECT or WITH statement over the spans and logs tables.");
    const result = await explorer(state, "/local/observability/query", { sql });
    print(JSON.stringify(result.result ?? result, null, 2));
    finish(0);
  }

  refuse("inspect takes kv [prefix], store <sql>, vault [needle], or logs [sql].");
};

const ownerId = async (state) => {
  const response = await fetch(
    `${state.origin}/cdn-cgi/local/explorer/api/storage/kv/namespaces/431d14eada56489b9602cf650efed706/values/${encodeURIComponent(`identity:${SIGNED_IN_IDENTITY}`)}`,
  );
  return response.status === 200 ? (await response.text()).trim() : null;
};

const stop = async (run) => {
  const dir = runDir(run);
  const state = readRun(dir);
  const targets = [];
  for (const [what, pid] of [
    ["wrangler", state.wranglerPid],
    ["github double", state.doublePid],
  ]) {
    if (alive(pid) && commandOf(pid).includes(dir)) {
      targets.push({ what, pid, tree: treeOf(pid) });
    } else {
      print(`${what} pid ${pid}: not running (nothing to stop)`);
    }
  }
  for (const target of targets) process.kill(target.pid, "SIGTERM");

  const everyone = targets.flatMap((t) => [t.pid, ...t.tree]);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && everyone.some(alive)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // Only this run's own pids, recorded above, and only if SIGTERM left them.
  for (const pid of everyone.filter(alive)) {
    print(`pid ${pid} outlived SIGTERM; sending SIGKILL`);
    process.kill(pid, "SIGKILL");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  for (const target of targets) {
    print(
      `${target.what} pid ${target.pid} and ${target.tree.length} child process(es): ${[target.pid, ...target.tree].some(alive) ? "STILL RUNNING" : "stopped"}`,
    );
  }
  const listening = [state.port, state.upstreamPort].flatMap(listenerPids);
  for (const [what, port] of [
    ["worker port", state.port],
    ["github double port", state.upstreamPort],
  ]) {
    const pids = listenerPids(port);
    print(`${what} ${port}: ${pids.length === 0 ? "closed" : `STILL LISTENING (${pids.join(", ")})`}`);
  }
  const leftovers = everyone.filter(alive);
  state.stoppedAt = new Date().toISOString();
  writeRun(dir, state);
  print(`evidence stays in .scratch/verify/${run}/`);
  finish(leftovers.length === 0 && listening.length === 0 ? 0 : 1);
};

const list = () => {
  if (!fs.existsSync(SCRATCH)) {
    say("no runs");
    return;
  }
  for (const run of fs.readdirSync(SCRATCH).sort()) {
    const file = path.join(SCRATCH, run, "run.json");
    if (!fs.existsSync(file)) continue;
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    const up = (pid) => alive(pid) && commandOf(pid).includes(state.dir);
    const status =
      up(state.wranglerPid) && up(state.doublePid)
        ? "running"
        : up(state.wranglerPid) || up(state.doublePid)
          ? "BROKEN (one process is gone; stop the run)"
          : "stopped";
    say(`${run}  ${status}  ${state.origin}`);
  }
};

// Commands a verify run must never perform, and why.
const REFUSED = {
  deploy: "deploys ship from CI on main only; a verify run never touches production",
  secret: "worker secrets belong to production; a run keeps its own in secrets.env",
  remote: "a run is local only; --remote would reach the user's Cloudflare account",
  tail: "tailing reads production; a run reads its own dev.log and `inspect logs`",
};

const HELP = `usage: opti-verify.mjs <command> ...
  start                                   start an isolated run; prints its id
  doctor <run>                            read-only fitness check
  login <run>                             sign in through the real OAuth flow
  mcp <run> <method> [params|@file]       raw JSON-RPC to /mcp
  tool <run> <name> [args|@file]          tools/call; prints the envelope
  exec <run> <file.js>                    execute a module from a file
  http <run> <METHOD> </path> [body|@file] any other route
  operator <run> approve-host|save-credential ...   scripts/operator.sh at this run
  inspect <run> kv [prefix] | store <sql> | vault [needle] | logs [sql]
  stop <run>                              stop this run's processes
  list                                    runs and whether they are running`;

const [command, ...args] = process.argv.slice(2);
const commands = { start, doctor, login, mcp, tool, exec, http, operator, inspect, stop };
if (command === "list") list();
else if (command === undefined || command === "help") say(HELP);
else if (command in REFUSED) {
  if (args[0] !== undefined && fs.existsSync(path.join(SCRATCH, args[0], "run.json"))) {
    transcript = path.join(SCRATCH, args[0], "transcript.log");
  }
  refuse(`${command}: ${REFUSED[command]}.`);
} else if (command in commands) {
  commands[command](...args).catch((error) => fail(String(error?.stack ?? error)));
} else {
  say(HELP);
  process.exit(64);
}
