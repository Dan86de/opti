/**
 * The vault container: obsidian-headless keeps VAULT_DIR in continuous sync
 * with Obsidian Sync, and this server is the file API the gateway's vault
 * route calls. It is deliberately dumb: path safety lives here because paths
 * are resolved here, but the write-prefix policy is the gateway's job - the
 * same split as host policy living outside the thing that fetches.
 *
 * Secrets arrive read-only at SECRETS_DIR (auth_token, sync/<id>/config.json)
 * and are copied into HOME at boot with vaultPath and deviceName rewritten;
 * sync state (state.db) is rebuilt from the service on a fresh disk, which is
 * what makes container disk ephemerality a non-event.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const VAULT_DIR = process.env.VAULT_DIR ?? "/vault";
const SECRETS_DIR = process.env.SECRETS_DIR ?? "/secrets";
const DEVICE_NAME = process.env.DEVICE_NAME ?? "opti-container";
const PORT = Number(process.env.PORT ?? "8788");
const LIST_BOUND = 500;
const SEARCH_BOUND = 50;

let syncedAt = null;
let lastSyncLine = "";
let syncProcess = null;

/** The CLI's config dir: XDG on Linux, a dotdir in HOME elsewhere. */
const headlessHome = () =>
  process.platform === "linux"
    ? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "obsidian-headless")
    : path.join(os.homedir(), ".obsidian-headless");

const writeSyncConfig = (config) => {
  config.vaultPath = VAULT_DIR;
  config.deviceName = DEVICE_NAME;
  const target = path.join(headlessHome(), "sync", config.vaultId);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "config.json"), JSON.stringify(config));
  fs.mkdirSync(VAULT_DIR, { recursive: true });
};

/**
 * Install secrets, pointing the sync config at this container. Two shapes:
 * Cloudflare hands them in as environment variables (OBSIDIAN_AUTH_TOKEN is
 * read by the CLI straight from the environment; OBSIDIAN_SYNC_CONFIG is the
 * per-vault config JSON, carrying the derived encryption key), while a local
 * docker run mounts the laptop's config dir read-only at SECRETS_DIR.
 */
const installSecrets = () => {
  const configJson = process.env.OBSIDIAN_SYNC_CONFIG;
  if (configJson !== undefined && configJson.length > 0) {
    if ((process.env.OBSIDIAN_AUTH_TOKEN ?? "") === "") {
      throw new Error("OBSIDIAN_SYNC_CONFIG is set but OBSIDIAN_AUTH_TOKEN is not; both cross together");
    }
    writeSyncConfig(JSON.parse(configJson));
    return;
  }
  const authToken = path.join(SECRETS_DIR, "auth_token");
  const syncRoot = path.join(SECRETS_DIR, "sync");
  const vaultIds = fs.readdirSync(syncRoot).filter((entry) => /^[0-9a-f]{32}$/.test(entry));
  if (vaultIds.length !== 1) {
    throw new Error(`expected exactly one vault under ${syncRoot}, found ${vaultIds.length}`);
  }
  const vaultId = vaultIds[0];
  fs.mkdirSync(headlessHome(), { recursive: true });
  fs.copyFileSync(authToken, path.join(headlessHome(), "auth_token"));
  writeSyncConfig(JSON.parse(fs.readFileSync(path.join(syncRoot, vaultId, "config.json"), "utf8")));
};

const noteSyncLine = (line) => {
  if (line.length === 0) return;
  lastSyncLine = line;
  if (/Fully synced|Accepted |Upload complete /.test(line)) {
    syncedAt = new Date().toISOString();
  }
  console.log(`[sync] ${line}`);
};

/** One-shot sync; the boot barrier before the API opens. */
const initialSync = async () => {
  const { stdout } = await execFileAsync("ob", ["sync", "--path", VAULT_DIR], {
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const line of stdout.split("\n")) noteSyncLine(line.trim());
};

/** Continuous sync, restarted with backoff if it dies. */
const startContinuousSync = (delayMs = 0) => {
  setTimeout(() => {
    syncProcess = spawn("ob", ["sync", "--continuous", "--path", VAULT_DIR]);
    const wire = (stream) => {
      let buffer = "";
      stream.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) noteSyncLine(line.trim());
      });
    };
    wire(syncProcess.stdout);
    wire(syncProcess.stderr);
    syncProcess.on("exit", (code) => {
      noteSyncLine(`continuous sync exited with ${code}; restarting`);
      startContinuousSync(Math.min(Math.max(delayMs * 2, 1000), 60_000));
    });
  }, delayMs);
};

/** Vault-relative path in, absolute path out; traversal refuses loudly. */
const resolveSafe = (relative) => {
  if (typeof relative !== "string" || relative.length === 0) {
    throw Object.assign(new Error("a vault path is a non-empty vault-relative string"), { status: 400 });
  }
  const absolute = path.resolve(VAULT_DIR, relative);
  if (absolute !== VAULT_DIR && !absolute.startsWith(VAULT_DIR + path.sep)) {
    throw Object.assign(new Error(`${JSON.stringify(relative)} escapes the vault`), { status: 400 });
  }
  return absolute;
};

const walk = (dir, out) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, out);
    else out.push(path.relative(VAULT_DIR, absolute));
    if (out.length > LIST_BOUND) return;
  }
};

const listPaths = (folder) => {
  const root = folder === undefined ? VAULT_DIR : resolveSafe(folder);
  const paths = [];
  walk(root, paths);
  if (paths.length > LIST_BOUND) {
    return { paths: paths.slice(0, LIST_BOUND), truncated: `more files exist; narrow the folder` };
  }
  return { paths };
};

const searchVault = (query) => {
  const needle = query.toLowerCase();
  const hits = [];
  const paths = [];
  walk(VAULT_DIR, paths);
  for (const relative of paths) {
    if (!relative.endsWith(".md")) continue;
    const content = fs.readFileSync(path.join(VAULT_DIR, relative), "utf8");
    const index = content.toLowerCase().indexOf(needle);
    if (index === -1) continue;
    const lineStart = content.lastIndexOf("\n", index) + 1;
    const lineEnd = content.indexOf("\n", index);
    hits.push({
      path: relative,
      snippet: content
        .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
        .trim()
        .slice(0, 300),
    });
    if (hits.length >= SEARCH_BOUND) {
      return { hits, truncated: "more matches exist; narrow the query" };
    }
  }
  return { hits };
};

const readBody = (request) =>
  new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) reject(Object.assign(new Error("body too large"), { status: 413 }));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

const respond = (response, status, payload) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return respond(response, 200, { ok: true, syncedAt, lastSyncLine });
    }
    if (request.method === "GET" && url.pathname === "/read") {
      const absolute = resolveSafe(url.searchParams.get("path") ?? "");
      if (!fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) {
        return respond(response, 404, { error: "no such note" });
      }
      return respond(response, 200, {
        path: path.relative(VAULT_DIR, absolute),
        content: fs.readFileSync(absolute, "utf8"),
        syncedAt,
      });
    }
    if (request.method === "GET" && url.pathname === "/list") {
      const folder = url.searchParams.get("folder") ?? undefined;
      return respond(response, 200, listPaths(folder));
    }
    if (request.method === "GET" && url.pathname === "/search") {
      const query = url.searchParams.get("q") ?? "";
      if (query.length === 0) return respond(response, 400, { error: "q is required" });
      return respond(response, 200, searchVault(query));
    }
    if (request.method === "POST" && url.pathname === "/write") {
      const { path: relative, content } = JSON.parse(await readBody(request));
      if (typeof content !== "string") return respond(response, 400, { error: "content must be a string" });
      const absolute = resolveSafe(relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
      return respond(response, 200, { path: path.relative(VAULT_DIR, absolute), bytes: content.length });
    }
    return respond(response, 404, { error: "unknown route" });
  } catch (error) {
    respond(response, error.status ?? 500, { error: error.message });
  }
});

installSecrets();
console.log("[boot] secrets installed, running initial sync");
await initialSync();
console.log(`[boot] initial sync done at ${syncedAt}`);
startContinuousSync();
server.listen(PORT, () => console.log(`[boot] vault API listening on ${PORT}`));
