// Multi-store Shopify Admin MCP server. One endpoint per store: POST /mcp/<store>
// Config (Railway variables), for each store key K (lowercase letters/digits/dashes):
//   STORE_<K>_DOMAIN  e.g. my-shop.myshopify.com
//   STORE_<K>_TOKEN   Admin API access token (shpat_...)  -- OR use client credentials (preferred):
//   SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET   Dev Dashboard app credentials shared by all stores in your
//                     organization (or STORE_<K>_CLIENT_ID / STORE_<K>_CLIENT_SECRET per store). The server
//                     exchanges them for a 24-hour token and refreshes it automatically.
//   STORE_<K>_SECRET        READ key: random string; the Claude connector sends it as "Authorization: Bearer <secret>".
//                           Can only run queries.
//   STORE_<K>_WRITE_SECRET  WRITE key: a different random string. Same endpoint, but also exposes the
//                           graphql_mutation tool. Use this one only in connectors that may change live data.
//   STORE_<K>_WRITE         legacy: "true" makes STORE_<K>_SECRET a read+write key (ignored if WRITE_SECRET is set)
// Optional: SHOPIFY_API_VERSION (default 2026-10)
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";

function loadStores() {
  const stores = {};
  for (const [name, value] of Object.entries(process.env)) {
    const m = name.match(/^STORE_([A-Z0-9_]+)_DOMAIN$/);
    if (!m) continue;
    const k = m[1];
    const key = k.toLowerCase().replace(/_/g, "-");
    const token = process.env[`STORE_${k}_TOKEN`];
    const clientId = process.env[`STORE_${k}_CLIENT_ID`] || process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env[`STORE_${k}_CLIENT_SECRET`] || process.env.SHOPIFY_CLIENT_SECRET;
    const secret = process.env[`STORE_${k}_SECRET`];
    const writeSecret = process.env[`STORE_${k}_WRITE_SECRET`];
    if ((!secret && !writeSecret) || (!token && !(clientId && clientSecret))) { console.warn(`store ${key}: needs SECRET and/or WRITE_SECRET plus TOKEN or client id/secret, skipped`); continue; }
    if (secret && writeSecret && secret === writeSecret) { console.warn(`store ${key}: SECRET and WRITE_SECRET must differ, skipped`); continue; }
    const legacyWrite = (process.env[`STORE_${k}_WRITE`] || "").toLowerCase() === "true";
    stores[key] = { domain: value.replace(/^https?:\/\//, "").replace(/\/$/, ""), token, clientId, clientSecret, cache: null,
      readSecret: secret, writeSecret: writeSecret || (legacyWrite ? secret : undefined) };
  }
  return stores;
}
const stores = loadStores();

// Returns "write" | "read" | null for the presented key. Write is checked first so a legacy
// single key that is both read and write resolves to write.
function accessLevel(store, presented) {
  if (store.writeSecret && safeEq(presented, store.writeSecret)) return "write";
  if (store.readSecret && safeEq(presented, store.readSecret)) return "read";
  return null;
}

const safeEq = (a, b) => {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

// Returns "query" | "mutation" | "subscription" | null for the first operation keyword.
function opType(doc) {
  const stripped = doc.replace(/#[^\n]*/g, "").replace(/"""[\s\S]*?"""/g, "").trim();
  if (stripped.startsWith("{")) return "query";
  const m = stripped.match(/^(query|mutation|subscription)\b/);
  return m ? m[1] : null;
}
const hasMutation = (doc) => /(^|[\s}])mutation\b/.test(doc.replace(/#[^\n]*/g, ""));

const DATA_DIR = process.env.DATA_DIR || "/data";
const TOKEN_FILE = path.join(DATA_DIR, "tokens.json");
function readTokens() { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); } catch { return {}; } }
function writeToken(key, rec) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const all = readTokens(); all[key] = rec;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(all), { mode: 0o600 });
}
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

async function tokenRequest(domain, params) {
  const r = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token request failed (${r.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// Order: static STORE_<K>_TOKEN -> token saved by the install flow (/auth/start) -> client credentials grant.
async function getToken(store, key) {
  if (store.token) return store.token;
  const saved = readTokens()[key];
  if (saved) {
    if (!saved.expires_at || Date.now() < saved.expires_at - 60_000) return saved.access_token;
    if (saved.refresh_token) {
      const j = await tokenRequest(store.domain, { grant_type: "refresh_token", refresh_token: saved.refresh_token,
        client_id: store.clientId || CLIENT_ID, client_secret: store.clientSecret || CLIENT_SECRET });
      const rec = { access_token: j.access_token, refresh_token: j.refresh_token || saved.refresh_token,
        expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : null };
      writeToken(key, rec); return rec.access_token;
    }
  }
  if (store.cache && Date.now() < store.cache.expiresAt - 60_000) return store.cache.token;
  if (!(store.clientId && store.clientSecret)) throw new Error(`store not connected yet: open /auth/start?store=${key}&key=<store secret>`);
  const j = await tokenRequest(store.domain, { grant_type: "client_credentials", client_id: store.clientId, client_secret: store.clientSecret });
  store.cache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 86399) * 1000 };
  return store.cache.token;
}

async function shopifyGraphql(store, key, query, variables) {
  let token;
  try { token = await getToken(store, key); }
  catch (e) { return { isError: true, content: [{ type: "text", text: String(e.message || e) }] }; }
  const r = await fetch(`https://${store.domain}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  const text = await r.text();
  if (!r.ok) return { isError: true, content: [{ type: "text", text: `HTTP ${r.status}: ${text.slice(0, 2000)}` }] };
  return { content: [{ type: "text", text }] };
}

function buildServer(key, store, level) {
  const server = new McpServer({ name: `shopify-${key}`, version: "1.0.0" });
  server.tool("get_shop_info",
    `Name, domain, plan and currency of the connected store (${key}). Call this first to confirm which store you are on.`,
    {}, async () => shopifyGraphql(store, key, "{ shop { name myshopifyDomain primaryDomain { url } currencyCode plan { publicDisplayName } } }"));
  server.tool("graphql_query",
    `Run a read-only Admin GraphQL query on store '${key}' (${store.domain}). Mutations are rejected.`,
    { query: z.string().describe("GraphQL query"), variables: z.record(z.any()).optional() },
    async ({ query, variables }) => {
      if (opType(query) !== "query" || hasMutation(query))
        return { isError: true, content: [{ type: "text", text: "Only read-only queries are allowed on this tool." }] };
      return shopifyGraphql(store, key, query, variables);
    });
  if (level === "write") {
    server.tool("graphql_mutation",
      `Run an Admin GraphQL MUTATION on store '${key}' (${store.domain}). This changes LIVE data. Confirm the intended change with the user first, and always request userErrors { field message } in the selection.`,
      { query: z.string().describe("GraphQL mutation"), variables: z.record(z.any()).optional() },
      async ({ query, variables }) => {
        if (opType(query) !== "mutation")
          return { isError: true, content: [{ type: "text", text: "This tool only accepts a mutation." }] };
        return shopifyGraphql(store, key, query, variables);
      });
  }
  return server;
}

const app = express();
app.use(express.json({ limit: "4mb" }));
app.get("/", (_req, res) => res.json({ ok: true, stores: Object.keys(stores), apiVersion: API_VERSION }));

app.post("/mcp/:store", async (req, res) => {
  const key = req.params.store;
  const store = stores[key];
  const auth = req.get("authorization") || "";
  const level = store && auth.startsWith("Bearer ") ? accessLevel(store, auth.slice(7)) : null;
  if (!level) {
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }
  try {
    const server = buildServer(key, store, level);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

// ---- Install / authorize flow for stores outside your Shopify organization (e.g. a client's store) ----
const pending = new Map(); // state -> { key, exp }
app.get("/auth/start", (req, res) => {
  const key = String(req.query.store || ""); const store = stores[key];
  if (!store || !accessLevel(store, String(req.query.key || ""))) return res.status(401).send("Unauthorized");
  const cid = store.clientId || CLIENT_ID;
  if (!cid || !(store.clientSecret || CLIENT_SECRET) || !process.env.PUBLIC_URL) return res.status(500).send("Server needs SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET and PUBLIC_URL.");
  const state = crypto.randomBytes(16).toString("hex");
  pending.set(state, { key, exp: Date.now() + 10 * 60_000 });
  const url = `https://${store.domain}/admin/oauth/authorize?` + new URLSearchParams({
    client_id: cid, redirect_uri: `${process.env.PUBLIC_URL}/auth/callback`, state });
  res.redirect(url);
});
app.get("/auth/callback", async (req, res) => {
  try {
    const { code, shop, state, hmac } = req.query;
    const p = pending.get(String(state)); pending.delete(String(state));
    if (!p || p.exp < Date.now()) return res.status(400).send("Link expired. Start again.");
    const store = stores[p.key];
    if (!store || String(shop) !== store.domain) return res.status(400).send("Store mismatch.");
    const secret = store.clientSecret || CLIENT_SECRET;
    const msg = Object.keys(req.query).filter((k) => k !== "hmac").sort().map((k) => `${k}=${req.query[k]}`).join("&");
    const mac = crypto.createHmac("sha256", secret).update(msg).digest("hex");
    if (!hmac || !safeEq(mac, String(hmac))) return res.status(400).send("Bad signature.");
    const j = await tokenRequest(store.domain, { client_id: store.clientId || CLIENT_ID, client_secret: secret, code: String(code) });
    writeToken(p.key, { access_token: j.access_token, refresh_token: j.refresh_token || null,
      expires_at: j.expires_in ? Date.now() + j.expires_in * 1000 : null });
    res.send(`<h2>Connected: ${p.key}</h2><p>Scopes granted: ${String(j.scope || "").replace(/[<>&]/g, "")}</p><p>You can close this tab.</p>`);
  } catch (e) { console.error(e); res.status(500).send("Could not save the token: " + String(e.message).slice(0, 200)); }
});
const methodNotAllowed = (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get("/mcp/:store", methodNotAllowed);
app.delete("/mcp/:store", methodNotAllowed);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`shopify-mcp-hub on :${port}, stores: ${Object.keys(stores).join(", ") || "(none)"}`));
