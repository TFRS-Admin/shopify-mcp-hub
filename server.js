// Multi-store Shopify Admin MCP server. One endpoint per store: POST /mcp/<store>
// Config (Railway variables), for each store key K (lowercase letters/digits/dashes):
//   STORE_<K>_DOMAIN  e.g. my-shop.myshopify.com
//   STORE_<K>_TOKEN   Admin API access token (shpat_...)  -- OR use client credentials (preferred):
//   SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET   Dev Dashboard app credentials shared by all stores in your
//                     organization (or STORE_<K>_CLIENT_ID / STORE_<K>_CLIENT_SECRET per store). The server
//                     exchanges them for a 24-hour token and refreshes it automatically.
//   STORE_<K>_SECRET  random string; the Claude connector sends it as "Authorization: Bearer <secret>"
//   STORE_<K>_WRITE   "true" to enable the mutation tool (default: read-only)
// Optional: SHOPIFY_API_VERSION (default 2026-10)
import express from "express";
import crypto from "node:crypto";
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
    if (!secret || (!token && !(clientId && clientSecret))) { console.warn(`store ${key}: needs SECRET plus TOKEN or client id/secret, skipped`); continue; }
    stores[key] = { domain: value.replace(/^https?:\/\//, "").replace(/\/$/, ""), token, clientId, clientSecret, secret, cache: null,
      write: (process.env[`STORE_${k}_WRITE`] || "").toLowerCase() === "true" };
  }
  return stores;
}
const stores = loadStores();

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

async function getToken(store) {
  if (store.token) return store.token;
  if (store.cache && Date.now() < store.cache.expiresAt - 60_000) return store.cache.token;
  const r = await fetch(`https://${store.domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: store.clientId, client_secret: store.clientSecret }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token request failed (${r.status}): ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  store.cache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 86399) * 1000 };
  return store.cache.token;
}

async function shopifyGraphql(store, query, variables) {
  let token;
  try { token = await getToken(store); }
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

function buildServer(key, store) {
  const server = new McpServer({ name: `shopify-${key}`, version: "1.0.0" });
  server.tool("get_shop_info",
    `Name, domain, plan and currency of the connected store (${key}). Call this first to confirm which store you are on.`,
    {}, async () => shopifyGraphql(store, "{ shop { name myshopifyDomain primaryDomain { url } currencyCode plan { publicDisplayName } } }"));
  server.tool("graphql_query",
    `Run a read-only Admin GraphQL query on store '${key}' (${store.domain}). Mutations are rejected.`,
    { query: z.string().describe("GraphQL query"), variables: z.record(z.any()).optional() },
    async ({ query, variables }) => {
      if (opType(query) !== "query" || hasMutation(query))
        return { isError: true, content: [{ type: "text", text: "Only read-only queries are allowed on this tool." }] };
      return shopifyGraphql(store, query, variables);
    });
  if (store.write) {
    server.tool("graphql_mutation",
      `Run an Admin GraphQL MUTATION on store '${key}' (${store.domain}). This changes live data.`,
      { query: z.string().describe("GraphQL mutation"), variables: z.record(z.any()).optional() },
      async ({ query, variables }) => {
        if (opType(query) !== "mutation")
          return { isError: true, content: [{ type: "text", text: "This tool only accepts a mutation." }] };
        return shopifyGraphql(store, query, variables);
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
  if (!store || !auth.startsWith("Bearer ") || !safeEq(auth.slice(7), store.secret)) {
    return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }
  try {
    const server = buildServer(key, store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
const methodNotAllowed = (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get("/mcp/:store", methodNotAllowed);
app.delete("/mcp/:store", methodNotAllowed);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`shopify-mcp-hub on :${port}, stores: ${Object.keys(stores).join(", ") || "(none)"}`));
