# PR: Add ShipStation API v1 Support (Dual-Client Parallel Mode)

## Summary

Add ShipStation API v1 as a **parallel, always-on** companion to the existing v2 integration. When both sets of credentials are provided, the MCP server instantiates **both** clients simultaneously — v1 tools and v2 tools are all registered and available in the same session. This gives the AI assistant live access to the best of both APIs at all times.

## Motivation

- ShipStation v2 API lacks robust search and filtering for **orders**, **customers**, **products**, and **fulfillments**
- v1 has endpoints (orders, customers, stores, fulfillments) that v2 either doesn't expose or handles differently
- v2 has capabilities v1 lacks (batches, manifests, inventory, return labels)
- Running both in parallel means **zero compromises** — full coverage of the ShipStation platform

---

## Architecture: Dual-Client Design

```
┌─────────────────────────────────────────────────────┐
│                   MCP Server                         │
│                                                      │
│   SHIPSTATION_API_KEY (v2)  ──► v2 Client            │
│   ┌─────────────────────────────────────────┐        │
│   │ v2 Tools (always registered):           │        │
│   │  get_shipments, create_shipment,        │        │
│   │  create_label, get_rates, get_carriers, │        │
│   │  batches, manifests, inventory,         │        │
│   │  return labels, tags, webhooks, etc.    │        │
│   └─────────────────────────────────────────┘        │
│                                                      │
│   SHIPSTATION_V1_API_KEY    ──► v1 Client            │
│   SHIPSTATION_V1_API_SECRET ──► (if both present)    │
│   ┌─────────────────────────────────────────┐        │
│   │ v1 Tools (registered when creds exist): │        │
│   │  v1_list_orders, v1_get_order,          │        │
│   │  v1_create_order, v1_list_customers,    │        │
│   │  v1_list_stores, v1_list_fulfillments,  │        │
│   │  v1_search_products, v1_search_shipments│        │
│   │  v1_get_rates, v1_list_carriers, etc.   │        │
│   └─────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────┘
```

**Key design decisions:**
- **v2 is always active** — requires `SHIPSTATION_API_KEY` as before (no regression)
- **v1 activates automatically** when `SHIPSTATION_V1_API_KEY` and `SHIPSTATION_V1_API_SECRET` are both set
- **v1 tools are prefixed with `v1_`** to avoid naming collisions with v2 tools
- **Both clients operate independently** — separate auth, separate base URLs, separate rate limits
- **No version toggle** — no `SHIPSTATION_API_VERSION` env var needed

---

## Scope of Changes

### 1. New File: `src/shipstation-client-v1.js`

A v1 API client class mirroring the structure of the existing `shipstation-client.js` (v2), adapted for v1 differences.

**Authentication:**
- v1 uses HTTP Basic Auth: `Authorization: Basic base64(API_KEY:API_SECRET)`
- Base URL: `https://ssapi.shipstation.com`
- Rate limit: 40 requests/minute (tracked via response headers)

**Rate-Limit Handling:**
- Read `X-Rate-Limit-Remaining` and `X-Rate-Limit-Reset` from every response
- On HTTP 429, auto-wait until the reset window elapses before retrying
- Expose rate-limit status so tools can report remaining capacity

**Endpoints to implement:**

| Resource | Method | v1 Endpoint | Why v1 (not available or limited in v2) |
|----------|--------|-------------|----------------------------------------|
| **Orders** | | | **Entire resource is v1-exclusive** |
| List Orders | GET | `/orders` | Rich filtering: customerName, itemKeyword, orderNumber, orderStatus, date ranges, storeId, sorting, pagination (max 500/page) |
| Get Order | GET | `/orders/{orderId}` | Full order detail with items, addresses, tags |
| Create/Update Order | POST | `/orders/createorder` | Full order creation with items, addresses, shipping prefs |
| Create/Update Multiple | POST | `/orders/createorders` | Bulk order creation |
| Delete Order | DELETE | `/orders/{orderId}` | |
| Hold Order | POST | `/orders/holduntil` | |
| Restore from Hold | POST | `/orders/restorefromhold` | |
| Mark Shipped | POST | `/orders/markasshipped` | |
| Add Tag to Order | POST | `/orders/addtag` | |
| Remove Tag from Order | POST | `/orders/removetag` | |
| Assign User to Order | POST | `/orders/assignuser` | |
| Create Label for Order | POST | `/orders/createlabelfororder` | |
| **Customers** | | | **Entire resource is v1-exclusive** |
| List Customers | GET | `/customers` | Filter by state, country, marketplace, tag, with sorting & pagination |
| Get Customer | GET | `/customers/{customerId}` | |
| **Stores** | | | **Entire resource is v1-exclusive** |
| List Stores | GET | `/stores` | Filter by marketplace, showInactive |
| Get Store | GET | `/stores/{storeId}` | |
| Update Store | PUT | `/stores/{storeId}` | |
| Deactivate Store | POST | `/stores/deactivate` | |
| Reactivate Store | POST | `/stores/reactivate` | |
| List Marketplaces | GET | `/stores/marketplaces` | |
| **Fulfillments** | | | **Entire resource is v1-exclusive** |
| List Fulfillments | GET | `/fulfillments` | Filter by order, tracking, recipient, date ranges |
| **Products** | | | **v1 has superior search** |
| List Products | GET | `/products` | SKU search, name search, UPC filter, category/type/tag filtering, showInactive |
| Get Product | GET | `/products/{productId}` | |
| Update Product | PUT | `/products/{productId}` | |
| **Shipments** | | | **v1 has superior filtering** |
| List Shipments | GET | `/shipments` | recipientName, orderNumber, trackingNumber, carrierCode, serviceCode filters |
| Get Rates | POST | `/shipments/getrates` | Different request shape, sometimes useful alongside v2 rates |
| Void Label | POST | `/shipments/voidlabel` | |
| Create Label | POST | `/shipments/createlabel` | |
| **Carriers** | | | |
| List Carriers | GET | `/carriers` | |
| List Services | GET | `/carriers/listservices` | |
| List Packages | GET | `/carriers/listpackages` | |
| **Warehouses** | | | |
| List Warehouses | GET | `/warehouses` | |
| Get Warehouse | GET | `/warehouses/{id}` | |
| Create Warehouse | POST | `/warehouses/createwarehouse` | v1-exclusive write operation |
| Update Warehouse | PUT | `/warehouses/{id}` | v1-exclusive write operation |
| Delete Warehouse | DELETE | `/warehouses/{id}` | v1-exclusive write operation |
| **Webhooks** | | | |
| List Webhooks | GET | `/webhooks` | |
| Subscribe | POST | `/webhooks/subscribe` | |
| Unsubscribe | DELETE | `/webhooks/{id}` | |
| **Accounts/Tags** | | | |
| List Tags | GET | `/accounts/listtags` | |

### 2. Modified File: `src/mcp-server.js`

**Environment variable changes:**

| Variable | Required | Description |
|----------|----------|-------------|
| `SHIPSTATION_API_KEY` | Yes | v2 API key (existing, unchanged) |
| `SHIPSTATION_API_URL` | No | Custom v2 base URL override (existing, unchanged) |
| `SHIPSTATION_V1_API_KEY` | No | v1 API key — if set with secret, enables v1 tools |
| `SHIPSTATION_V1_API_SECRET` | No | v1 API secret — required alongside v1 key |
| `SHIPSTATION_V1_API_URL` | No | Custom v1 base URL override (default: `https://ssapi.shipstation.com`) |

**Server initialization logic:**
```
# v2 — always active (existing behavior, unchanged)
require SHIPSTATION_API_KEY
v2Client = new ShipStationClient(SHIPSTATION_API_KEY, SHIPSTATION_API_URL)
register all existing v2 tools

# v1 — activated when credentials are present
if SHIPSTATION_V1_API_KEY and SHIPSTATION_V1_API_SECRET:
    v1Client = new ShipStationClientV1(V1_KEY, V1_SECRET, V1_URL)
    register all v1_ prefixed tools
    log: "ShipStation v1 API enabled — dual-client mode active"
else:
    log: "ShipStation v1 API not configured — v2 only mode"
```

**Complete v1 MCP tool registry (all prefixed `v1_`):**

| Tool Name | Description |
|-----------|-------------|
| **Orders (v1-exclusive)** | |
| `v1_list_orders` | Search/filter orders by customer name, item keyword, order number, status, date ranges, store ID. Supports sorting and pagination (max 500/page) |
| `v1_get_order` | Get full order detail by order ID — includes items, addresses, tags, shipping preferences |
| `v1_create_order` | Create or update an order with full item, address, and shipping details |
| `v1_create_orders` | Bulk create/update multiple orders in a single request |
| `v1_delete_order` | Delete an order by ID |
| `v1_hold_order` | Place an order on hold until a specified date |
| `v1_restore_order` | Restore an order from hold status |
| `v1_mark_order_shipped` | Mark an order as shipped with carrier, service, tracking number, and ship date |
| `v1_add_order_tag` | Add a tag to an order |
| `v1_remove_order_tag` | Remove a tag from an order |
| `v1_assign_order_user` | Assign a user to an order |
| `v1_create_order_label` | Create a shipping label directly for an order |
| **Customers (v1-exclusive)** | |
| `v1_list_customers` | Search customers by state, country, marketplace, tag. Supports sorting and pagination |
| `v1_get_customer` | Get customer detail by customer ID |
| **Stores (v1-exclusive)** | |
| `v1_list_stores` | List connected marketplace stores. Filter by marketplace ID and active status |
| `v1_get_store` | Get store detail by store ID |
| `v1_update_store` | Update store configuration |
| `v1_deactivate_store` | Deactivate a connected store |
| `v1_reactivate_store` | Reactivate a previously deactivated store |
| `v1_list_marketplaces` | List all available marketplace integrations |
| **Fulfillments (v1-exclusive)** | |
| `v1_list_fulfillments` | Search fulfillments by order ID, order number, tracking number, recipient name, date ranges |
| **Products (enhanced search)** | |
| `v1_list_products` | Search products by SKU, name, UPC, category, type, tag, date range, active status |
| `v1_get_product` | Get product detail by product ID |
| `v1_update_product` | Update product details (aliases, defaults, etc.) |
| **Shipments (enhanced filters)** | |
| `v1_list_shipments` | Search shipments by recipient name, order number, tracking number, carrier, service, date ranges, store ID |
| `v1_get_rates` | Get shipping rates for a carrier with origin/destination postal codes and weight |
| `v1_create_label` | Create a shipping label |
| `v1_void_label` | Void a shipping label by shipment ID |
| **Carriers** | |
| `v1_list_carriers` | List all connected carrier accounts |
| `v1_list_carrier_services` | List available services for a carrier code |
| `v1_list_carrier_packages` | List available package types for a carrier code |
| **Warehouses** | |
| `v1_list_warehouses` | List all warehouses (ship-from locations) |
| `v1_get_warehouse` | Get warehouse detail by ID |
| `v1_create_warehouse` | Create a new warehouse/ship-from location |
| `v1_update_warehouse` | Update warehouse details |
| `v1_delete_warehouse` | Delete a warehouse |
| **Webhooks** | |
| `v1_list_webhooks` | List all registered webhooks |
| `v1_subscribe_webhook` | Subscribe to a webhook event |
| `v1_unsubscribe_webhook` | Unsubscribe from a webhook |
| **Tags** | |
| `v1_list_tags` | List all account tags |

### 3. Modified File: `README.md`

- Add dual-client configuration example
- Document the `v1_` tool prefix convention
- List which tools come from v1 vs v2
- Note the v1 rate limit (40 req/min) and pagination max (500/page)
- Explain that v1 and v2 operate independently with separate credentials and rate limits

### 4. No Changes To

- `package.json` — no new dependencies needed (axios handles Basic Auth natively)
- `docker-compose.yml` / `Dockerfile` — just pass additional env vars
- `src/shipstation-client.js` — **zero modifications** to existing v2 client
- Existing v2 tool definitions — **zero modifications**, fully backward compatible

---

## v1 vs v2 Capability Matrix

This is why you need both — each API covers gaps the other has:

| Capability | v1 | v2 | Which Client Handles It |
|-----------|----|----|------------------------|
| Order CRUD + search | Yes | No | v1 |
| Customer search | Yes | No | v1 |
| Store management | Yes | No | v1 |
| Fulfillment search | Yes | No | v1 |
| Product search (SKU, name, UPC) | Yes | Basic only | v1 |
| Shipment search (recipient, tracking) | Yes | Limited | v1 |
| Batch label processing | No | Yes | v2 |
| Manifests (end-of-day) | No | Yes | v2 |
| Inventory management | No | Yes | v2 |
| Return labels | No | Yes | v2 |
| Shipment tagging | No | Yes | v2 |
| Package pickups | No | Yes | v2 |

---

## Implementation Plan

### Phase 1: v1 Client
1. Create `src/shipstation-client-v1.js` with Basic Auth, all v1 endpoints listed above
2. Include rate-limit tracking via `X-Rate-Limit-Remaining` / `X-Rate-Limit-Reset` response headers
3. Auto-retry with backoff on HTTP 429

### Phase 2: Dual-Client MCP Integration
4. Update `src/mcp-server.js` to read `SHIPSTATION_V1_API_KEY` and `SHIPSTATION_V1_API_SECRET`
5. Add v1 client instantiation **alongside** existing v2 client (not replacing it)
6. Register all `v1_` prefixed tool definitions with full input schemas and descriptions
7. Log which mode is active on startup (`v2 only` or `dual-client v1+v2`)

### Phase 3: Documentation & Testing
8. Update `README.md` with dual-client setup instructions and full tool reference
9. Add v1 unit tests mirroring existing test structure in `tests/`
10. Verify both clients work simultaneously — v1 tools hit `ssapi.shipstation.com`, v2 tools hit `api.shipstation.com`
11. Confirm zero regressions when v1 env vars are absent (v2-only mode)

---

## Risk & Mitigation

| Risk | Mitigation |
|------|------------|
| v1 rate limit (40/min) is restrictive | Built-in rate-limit tracking + auto-backoff on 429 in v1 client |
| Tool name confusion between v1 and v2 | All v1 tools prefixed with `v1_`; descriptions state which API they use |
| Breaking existing v2 users | v2 is completely unchanged; v1 is additive only when credentials are present |
| v1 API eventual deprecation by ShipStation | v1 client is a separate file — can be removed cleanly without touching v2 |
| Two clients hitting ShipStation simultaneously | Separate rate limit pools (v1 key vs v2 key); no interference |

---

## MCP Configuration Examples

### Dual-Client Mode (recommended — full access to both APIs)
```json
{
  "mcpServers": {
    "shipstation": {
      "command": "node",
      "args": ["/path/to/shipstation-mcp/src/mcp-server.js"],
      "env": {
        "SHIPSTATION_API_KEY": "your_v2_api_key",
        "SHIPSTATION_V1_API_KEY": "your_v1_api_key",
        "SHIPSTATION_V1_API_SECRET": "your_v1_api_secret"
      }
    }
  }
}
```

### v2-Only Mode (unchanged, backward compatible)
```json
{
  "mcpServers": {
    "shipstation": {
      "command": "node",
      "args": ["/path/to/shipstation-mcp/src/mcp-server.js"],
      "env": {
        "SHIPSTATION_API_KEY": "your_v2_api_key"
      }
    }
  }
}
```

### Docker Dual-Client Mode
```json
{
  "mcpServers": {
    "shipstation": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env", "SHIPSTATION_API_KEY=your_v2_api_key",
        "--env", "SHIPSTATION_V1_API_KEY=your_v1_api_key",
        "--env", "SHIPSTATION_V1_API_SECRET=your_v1_api_secret",
        "shipstation-api-mcp"
      ]
    }
  }
}
```

---

## Acceptance Criteria

- [ ] When only `SHIPSTATION_API_KEY` is set, server starts in v2-only mode — **zero regressions**, all existing tools work
- [ ] When `SHIPSTATION_V1_API_KEY` + `SHIPSTATION_V1_API_SECRET` are also set, server starts in dual-client mode — both v1 and v2 tools are registered
- [ ] v1 client authenticates via Basic Auth against `https://ssapi.shipstation.com`
- [ ] v2 client continues to authenticate via `api-key` header against `https://api.shipstation.com`
- [ ] Both clients can be called in the same session without interference
- [ ] `v1_list_orders` returns filtered results matching query parameters
- [ ] `v1_list_customers`, `v1_list_products`, `v1_list_stores`, `v1_list_fulfillments` all return paginated results
- [ ] v1 rate limiting is handled gracefully (no crash on 429, auto-retry after reset)
- [ ] All v1 tools are prefixed with `v1_` and have clear descriptions
- [ ] README documents dual-client configuration with examples
- [ ] All existing v2 tests continue to pass unchanged
- [ ] Startup log clearly indicates which mode is active
