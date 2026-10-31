# shopify-mcp-hub
Multi-store Shopify Admin GraphQL MCP server for Claude custom connectors.
Endpoint per store: `POST /mcp/<store-key>`; the bearer key you send decides the access level.

| Key (Railway variable) | Tools exposed |
| --- | --- |
| `STORE_<K>_SECRET` (read key) | `get_shop_info`, `graphql_query` |
| `STORE_<K>_WRITE_SECRET` (write key) | the above plus `graphql_mutation` |

Create two Claude connectors per store with the same URL: one with the read key, one with the write key.
The two keys must differ. (Legacy: `STORE_<K>_WRITE=true` makes `STORE_<K>_SECRET` read+write.)

## Shopify app scopes
Access is limited by the scopes on your Dev Dashboard app. The hub's keys only gate which tools Claude sees.
Dev Dashboard -> your app -> Versions -> new version -> set Scopes -> release -> approve the update on each store.
Suggested scopes (the `write_*` ones imply read):

```
read_products,write_products,read_inventory,write_inventory,read_orders,write_orders,
read_customers,write_customers,read_draft_orders,write_draft_orders,read_discounts,write_discounts,
read_fulfillments,write_fulfillments,read_content,write_content,read_themes,read_locations,
read_reports,read_analytics,read_metaobjects,write_metaobjects,read_files,write_files
```
Orders older than 60 days also need `read_all_orders`. Customer PII fields may need protected-data access approval.

## Railway variables
```
SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET   Dev Dashboard app credentials
STORE_<K>_DOMAIN                            my-shop.myshopify.com
STORE_<K>_SECRET                            read key (openssl rand -hex 24)
STORE_<K>_WRITE_SECRET                      write key (a different random string)
PUBLIC_URL                                  https://<your-railway-domain>   (for /auth/start)
DATA_DIR                                    /data  (attach a Railway volume here to keep install tokens)
```
Stores in your own organization authenticate via client credentials. Stores outside it (e.g. client transfers)
need a one-time `/auth/start?store=<key>&key=<read or write key>`.
