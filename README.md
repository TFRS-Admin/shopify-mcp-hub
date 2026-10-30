# shopify-mcp-hub
Multi-store, read-only-by-default Shopify Admin GraphQL MCP server for Claude custom connectors.
Endpoint per store: `POST /mcp/<store-key>` with `Authorization: Bearer <STORE_<KEY>_SECRET>`.
See server.js header for the Railway variables.
