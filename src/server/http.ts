// HTTP service. Every route except /health needs a token (x-sync-token or Authorization: Bearer).
// Tokens have scopes: read < write < publish < admin, optionally limited to some syncs.

import http from "node:http";
import { statSync } from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { findConfig, loadConfig, reloadConfig, type LoadedConfig } from "../config/load.ts";
import { hasScope, type Scope, type TokenConfig } from "../config/schema.ts";
import { createSync, type Sync } from "../engine.ts";
import { SyncError } from "../core/issues.ts";
import type { Connector } from "../framer/client.ts";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../mcp/server.ts";
import { postsFromBody } from "../core/posts.ts";

function findToken(tokens: TokenConfig[], given: string): TokenConfig | null {
  const g = Buffer.from(given);
  for (const t of tokens) {
    const b = Buffer.from(t.token);
    if (b.length === g.length && timingSafeEqual(b, g)) return t;
  }
  return null;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new SyncError("INPUT_INVALID", `body larger than ${Math.round(maxBytes / 1048576)} MB`, { fix: "raise server.maxBodyMb" });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createHandler(initial: LoadedConfig, opts: { connect?: Connector; connectors?: Record<string, Connector> } = {}) {
  if (!initial.config.server.tokens.length) throw new SyncError("AUTH_MISSING", "the server won't start without a token", { fix: "create one with `framer-cms-sync tokens add`, or set server.tokens in the config" });
  // Write queues are shared across reloads, so a write in progress keeps its place.
  const queues = new Map();
  // One engine per caller, so the run log (`history`) names the token that did each thing.
  const engineFor = (l: LoadedConfig) => {
    const byActor = new Map<string, Sync>();
    return (actor: string) => {
      if (!byActor.has(actor)) byActor.set(actor, createSync({ config: l.config, configDir: l.dir, configFile: l.file, connect: opts.connect, connectors: opts.connectors, actor, queues }) as Sync);
      return byActor.get(actor)!;
    };
  };
  const build = (l: LoadedConfig) => ({
    loaded: l,
    tokens: l.config.server.tokens,
    engine: engineFor(l),
  });
  let state = build(initial);
  // Live reload: when the config or .env changes (a token added or revoked, a sync created in the
  // terminal app), the next request uses the new version. A broken edit keeps the last good config.
  const fileOf = initial.file && initial.file !== "(inline)" ? path.resolve(initial.file) : null;
  const mtime = () => { if (!fileOf) return 0; let t = 0; for (const f of [fileOf, path.join(path.dirname(fileOf), ".env")]) { try { t = Math.max(t, statSync(f).mtimeMs); } catch { /* missing */ } } return t; };
  let seen = mtime();
  const current = () => {
    const t = mtime();
    if (fileOf && t !== seen) {
      seen = t;
      try { state = build(reloadConfig(fileOf)); if (process.env.NODE_ENV !== "test") console.log("config changed: reloaded"); }
      catch (e) { console.error(`config changed but couldn't be loaded, keeping the previous one: ${(e as Error).message}`); }
    }
    return state;
  };

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const { loaded, tokens, engine } = current();
    const maxBytes = loaded.config.server.maxBodyMb * 1048576;
    return handle(req, res, loaded, tokens, engine, maxBytes);
  };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, loaded: LoadedConfig, tokens: TokenConfig[], engine: (actor: string) => Sync, maxBytes: number) {
  const started = Date.now();
  const url = new URL(req.url ?? "/", "http://local");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const q = url.searchParams;
  const flag = (k: string) => /^(1|true|yes)$/i.test(q.get(k) ?? "");
  const deploy = q.get("deploy") === "false" ? false : undefined;
  try {
    if (p === "/health") return send(res, 200, { ok: true, service: "framer-cms-sync", syncs: Object.keys(loaded.config.syncs) });

    const given = String(req.headers["x-sync-token"] ?? "").trim() || String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    const token = given ? findToken(tokens, given) : null;
    if (!token) throw new SyncError("UNAUTHORIZED", "missing or wrong token", { fix: "send x-sync-token: <token> or Authorization: Bearer <token>" });
    const sync = engine(token.name);

    // MCP over HTTP (streamable HTTP, stateless). Same token; tools are filtered by its scope.
    if (p === "/mcp") {
      if (token.projects || token.syncs)
        throw new SyncError("FORBIDDEN", `token "${token.name}" is limited to some sites or syncs; MCP needs a token without those limits`, { fix: "create a separate token for MCP, with just the scope it needs" });
      if (req.method !== "POST") { res.statusCode = 405; res.setHeader("allow", "POST"); res.end(); return; }
      const raw = await readBody(req, maxBytes);
      let parsed: unknown;
      try { parsed = raw ? JSON.parse(raw) : undefined; } catch { throw new SyncError("INPUT_INVALID", "MCP requests must be JSON"); }
      const mcp = createMcpServer(loaded, { scope: token.scope, engine: engine(`${token.name} (mcp)`) });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
      return;
    }
    const project = q.get("project") ?? undefined;
    const need = (scope: Scope, syncName?: string) => {
      if (!hasScope(token.scope, scope)) throw new SyncError("FORBIDDEN", `token "${token.name}" has scope ${token.scope}; this needs ${scope}`);
      if (syncName && token.syncs && !token.syncs.includes(syncName)) throw new SyncError("FORBIDDEN", `token "${token.name}" can't use sync "${syncName}"`);
      const proj = syncName ? loaded.config.syncs[syncName]?.project : project ?? (sync.projectNames.length === 1 ? sync.projectNames[0] : undefined);
      if (token.projects && proj && !token.projects.includes(proj)) throw new SyncError("FORBIDDEN", `token "${token.name}" can't use project "${proj}"`);
      if (token.projects && !proj && !syncName) throw new SyncError("FORBIDDEN", `token "${token.name}" is limited to some projects; pass ?project=`);
    };
    const body = async () => {
      const text = ["POST", "PUT", "PATCH"].includes(req.method ?? "") ? await readBody(req, maxBytes) : "";
      return text.trim() ? { text, contentType: String(req.headers["content-type"] ?? "") } : undefined;
    };
    const publishParam = (): boolean | "on-change" | undefined => {
      const v = q.get("publish");
      if (v === null) return undefined;
      if (v === "on-change") return "on-change";
      return flag("publish");
    };
    // Writing needs write scope, or publish scope when this request will publish (asked for, or the sync's default).
    const writeScope = (name: string, publish: boolean | "on-change" | undefined): Scope =>
      (publish === undefined ? (loaded.config.syncs[name]?.publish ?? loaded.config.defaults.publish) !== "never" : publish !== false) ? "publish" : "write";
    const m = (re: RegExp) => p.match(re);
    let r: RegExpMatchArray | null;

    if (req.method === "GET" && p === "/projects") { need("read"); return send(res, 200, (await sync.projects()).filter((x) => !token.projects || token.projects.includes(x.name)).map(({ url: _u, ...x }) => x)); }
    if (req.method === "GET" && p === "/collections") { need("read"); return send(res, 200, await sync.collections({ project })); }
    if (req.method === "GET" && (r = m(/^\/collections\/([^/]+)\/fields$/))) { need("read"); return send(res, 200, await sync.fields(decodeURIComponent(r[1]), { project })); }
    if (req.method === "GET" && p === "/syncs") { need("read"); return send(res, 200, sync.syncs().filter((s) => !token.syncs || token.syncs.includes(s.name))); }
    // Inspect data: a sync's configured source (GET), or data sent in the body (POST). Arbitrary URLs need admin,
    // because letting a token make the server fetch any address could reach your internal network.
    if (p === "/inspect" && req.method === "POST") {
      const url = q.get("url");
      need(url ? "admin" : "read");
      const b = await body();
      if (!url && !b) throw new SyncError("NO_INPUT", "send the data to inspect in the body, or ?url= (admin)");
      return send(res, 200, await sync.inspect({ ...(url ? { url } : { text: b!.text, contentType: b!.contentType }), rows: q.get("rows") ?? undefined }));
    }
    if ((r = m(/^\/syncs\/([^/]+)\/inspect$/))) {
      const name = decodeURIComponent(r[1]);
      need("read", name);
      const b = req.method === "POST" ? await body() : undefined;
      return send(res, 200, await sync.inspect({ sync: name, ...(b ? { text: b.text, contentType: b.contentType } : {}), rows: q.get("rows") ?? undefined }));
    }
    if ((r = m(/^\/syncs\/([^/]+)\/(plan|apply|setup|check|items|mappings)$/))) {
      const name = decodeURIComponent(r[1]), op = r[2];
      // Data sent in the body is partial by default (webhooks usually send a few rows): it adds and
      // updates but never removes. ?complete=true says it's the full set. With no body, the sync's own
      // source is used and is complete unless ?partial=true.
      const runOpts = (b: unknown) => ({
        partial: b ? q.get("complete") !== "true" && !flag("replace") : flag("partial"),
        createOnly: flag("createOnly"), updateOnly: flag("updateOnly"), replace: flag("replace"),
        limit: Number(q.get("limit")) || undefined, only: q.get("only")?.split(",").filter(Boolean),
      });
      if (op === "plan" && req.method === "POST") {
        need("read", name);
        const b = await body();
        const out = await sync.plan(name, b, runOpts(b));
        return send(res, out.ok ? 200 : 422, out);
      }
      if (op === "apply" && req.method === "POST") {
        const publish = publishParam();
        need(writeScope(name, publish), name);
        if (flag("allowMassRemove")) need("admin", name);
        const b = await body();
        const out = await sync.apply(name, b, {
          ...runOpts(b), publish, deploy, planId: q.get("planId") ?? undefined,
          allowMassRemove: flag("allowMassRemove"),
        });
        return send(res, out.ok ? 200 : 422, out);
      }
      if (op === "setup" && req.method === "POST") { need("admin", name); return send(res, 200, await sync.setup(name, { force: flag("force") })); }
      if (op === "check" && (req.method === "GET" || req.method === "POST")) { need("read", name); return send(res, 200, await sync.check(name, await body())); }
      if (op === "items" && req.method === "GET") { need("read", name); return send(res, 200, await sync.items(name)); }
      // Single Markdown posts: POST adds, PUT/PATCH updates. Written straight away; the folder is kept in step.
      if (op === "items" && ["POST", "PUT", "PATCH"].includes(req.method ?? "")) {
        const publish = publishParam();
        need(writeScope(name, publish), name);
        const b = await body();
        const posts = postsFromBody(b?.text ?? "", b?.contentType, q.get("slug") ?? undefined);
        const o = { publish, deploy };
        const out = req.method === "POST" ? await sync.addPosts(name, posts, o) : await sync.updatePosts(name, posts, o);
        return send(res, out.ok ? 200 : 422, out);
      }
      if (op === "mappings" && req.method === "GET") { need("read", name); return send(res, 200, await sync.mappings(name)); }
      if (op === "mappings" && (req.method === "POST" || req.method === "PUT")) {
        need("write", name);
        const b = await body();
        let parsed: unknown;
        try { parsed = JSON.parse(b?.text ?? "null"); } catch { throw new SyncError("INPUT_INVALID", "send JSON: { changes: [{ column, to }] }"); }
        const changes = Array.isArray(parsed) ? parsed : (parsed as { changes?: unknown })?.changes
          ?? Object.entries((parsed as Record<string, unknown>) ?? {}).map(([column, to]) => ({ column, to }));
        return send(res, 200, await sync.setMappings(name, changes as never));
      }
    }
    if (req.method === "DELETE" && (r = m(/^\/syncs\/([^/]+)\/items\/([^/]+)$/))) {
      const name = decodeURIComponent(r[1]);
      need(flag("publish") ? "publish" : "write", name);
      return send(res, 200, await sync.remove(name, decodeURIComponent(r[2]), { redirectTo: q.get("redirectTo") ?? undefined, publish: flag("publish"), keepFile: flag("keepFile") }));
    }
    if (req.method === "GET" && p === "/redirects") { need("read"); return send(res, 200, await sync.redirects.list({ project })); }
    if (req.method === "POST" && p === "/redirects/plan") { need("read"); const b = await body(); const out = await sync.redirects.plan(b?.text ?? "", { project }); return send(res, out.issues.some((i) => i.level === "error") ? 422 : 200, out); }
    if (req.method === "POST" && p === "/redirects/apply") { need(flag("publish") ? "publish" : "write"); const b = await body(); const out = await sync.redirects.apply(b?.text ?? "", { project, publish: flag("publish") }); return send(res, out.ok ? 200 : 422, out); }
    if (req.method === "POST" && p === "/redirects/remove") {
      need("write");
      const b = await body();
      let froms: string[] = [];
      try { const j = JSON.parse(b?.text ?? "[]"); froms = Array.isArray(j) ? j : j.from ?? []; } catch { froms = (b?.text ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
      return send(res, 200, await sync.redirects.remove(froms, { project }));
    }
    if (req.method === "POST" && p === "/publish") { need("publish"); return send(res, 200, await sync.publish({ project, deploy })); }

    throw new SyncError("NOT_FOUND", `no route ${req.method} ${p}`, {
      details: ["GET /health", "POST /mcp (MCP over HTTP)", "GET /projects", "GET /collections[?project=]", "GET /collections/:id/fields", "GET /syncs", "POST /syncs/:sync/plan", "POST /syncs/:sync/apply[?publish=&planId=&complete=&partial=&createOnly=&updateOnly=&replace=&limit=&only=]",
        "POST /syncs/:sync/setup[?force=true]", "GET /syncs/:sync/check", "GET /syncs/:sync/items", "POST /syncs/:sync/items (add Markdown posts)", "PUT /syncs/:sync/items (update Markdown posts)", "GET|POST /syncs/:sync/mappings", "GET|POST /syncs/:sync/inspect", "POST /inspect[?url= (admin)&rows=]", "DELETE /syncs/:sync/items/:slug[?redirectTo=&publish=&keepFile=]",
        "GET /redirects", "POST /redirects/plan", "POST /redirects/apply[?publish=]", "POST /redirects/remove", "POST /publish[?deploy=false]"],
    });
  } catch (e) {
    const err = e instanceof SyncError ? e : new SyncError("INTERNAL_ERROR", String((e as Error)?.message ?? e), { fix: "this is a bug in framer-cms-sync; please report it with the request you sent" });
    send(res, err.status, err.toJSON());
  } finally {
    if (process.env.NODE_ENV !== "test") console.log(`${req.method} ${p} ${res.statusCode} ${Date.now() - started}ms`);
  }
}

/**
 * Start the HTTP service. Given a config file (or nothing: search from the working directory),
 * it waits in "setup mode" until a valid config with at least one token exists, so a fresh
 * Docker container can be set up from inside with the terminal app, then starts serving.
 */
export function startServer(source: LoadedConfig | string | undefined, opts: { port?: number; host?: string; connect?: Connector; connectors?: Record<string, Connector> } = {}) {
  let handler: ReturnType<typeof createHandler> | null = null;
  let waitingFor = "";
  const tryLoad = (): boolean => {
    if (handler) return true;
    try {
      const loaded = typeof source === "object" ? source : (() => {
        const file = source ? path.resolve(source) : findConfig(process.cwd());
        if (!file) throw new SyncError("CONFIG_NOT_FOUND", "no framer-cms-sync.config.yaml yet");
        return loadConfig(file);
      })();
      handler = createHandler(loaded, opts);
      if (waitingFor) console.log("setup complete: serving requests");
      return true;
    } catch (e) {
      const why = (e as Error).message.split("\n")[0];
      if (why !== waitingFor) {
        waitingFor = why;
        console.log(`waiting for setup: ${why}`);
        console.log("  open the terminal app to set up: docker exec -it <container> framer-cms-sync  (or run framer-cms-sync in this folder)");
        console.log("  the service needs a site and at least one access token (Tokens screen, or: framer-cms-sync tokens add <name> --scope write)");
      }
      return false;
    }
  };
  tryLoad();
  const initialPort = typeof source === "object" ? source.config.server.port : undefined;
  const port = opts.port ?? initialPort ?? 8080;
  const host = opts.host ?? (typeof source === "object" ? source.config.server.host : "127.0.0.1");
  const server = http.createServer((req, res) => {
    if (handler || tryLoad()) return void handler!(req, res);
    const p = new URL(req.url ?? "/", "http://local").pathname;
    if (p === "/health") return send(res, 200, { ok: true, ready: false, setup: waitingFor, next: "docker exec -it <container> framer-cms-sync" });
    send(res, 503, { ok: false, error: { code: "NOT_SET_UP", message: `framer-cms-sync isn't set up yet: ${waitingFor}`, fix: "open the terminal app (docker exec -it <container> framer-cms-sync) to add a site and an access token" } });
  });
  server.listen(port, host, () => console.log(`framer-cms-sync listening on http://${host}:${port}${handler ? "" : " (waiting for setup)"}`));
  return server;
}
