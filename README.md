# ShipStation API MCP Server

An MCP (Model Context Protocol) server for interacting with the ShipStation API. Supports **v2 (always active)** and **v1 (optional dual-client mode)** simultaneously, giving AI assistants full coverage of the ShipStation platform including shipments, labels, rates, carriers, inventory, warehouses, batches, manifests, orders, customers, stores, and fulfillments.

## Features

- **Shipments**: Create, list, get, cancel shipments and retrieve rates
- **Labels**: Create, list, get, void labels and track packages
- **Rates**: Calculate and estimate shipping rates
- **Carriers**: List carriers, services, and package types
- **Inventory**: Get inventory levels and update stock
- **Warehouses**: List and get warehouse information
- **Batches**: Create and manage batches for bulk label processing
- **Manifests**: Create and manage manifests for end-of-day processing

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Set up environment variables**:
   ```bash
   cp .env.example .env
   # Edit .env and add your ShipStation API key
   # NEVER commit .env to git - it contains sensitive API keys
   #
   # Optional: add v1 credentials to enable dual-client mode
   # SHIPSTATION_V1_API_KEY=your_v1_api_key
   # SHIPSTATION_V1_API_SECRET=your_v1_api_secret
   ```

3. **Start the MCP server**:
   ```bash
   npm start
   # or for development with auto-reload:
   npm run dev
   ```

## Dual API Mode (v1 + v2)

The server supports running both ShipStation API versions in parallel:

- **v2 is always active** — requires `SHIPSTATION_API_KEY` (existing behavior, no changes)
- **v1 activates automatically** when both `SHIPSTATION_V1_API_KEY` and `SHIPSTATION_V1_API_SECRET` are set
- **v1 tools are prefixed with `v1_`** to avoid naming collisions (e.g., `v1_list_orders`, `v1_list_customers`)
- **Both clients operate independently** — separate auth, separate base URLs, separate rate limits
- **v1 rate limit is 40 requests/minute**, handled automatically with backoff on HTTP 429

When v1 credentials are absent, the server runs in v2-only mode with zero regressions.

**Why both?** v1 has endpoints v2 lacks (orders, customers, stores, fulfillments, product search). v2 has capabilities v1 lacks (batches, manifests, inventory, return labels). Running both means full coverage.

## MCP Integration

To use this server with an MCP-compatible AI assistant (like Claude Desktop), add one of the following configurations:

### Direct Node.js Execution

**v2-only mode:**

```json
{
  "mcpServers": {
    "shipstation": {
      "command": "node",
      "args": ["/path/to/shipstation-api-mcp/src/mcp-server.js"],
      "env": {
        "SHIPSTATION_API_KEY": "your_api_key_here",
        "SHIPSTATION_API_URL": "https://custom-api.example.com"
      }
    }
  }
}
```

**Dual-client mode (v1 + v2):**

```json
{
  "mcpServers": {
    "shipstation": {
      "command": "node",
      "args": ["/path/to/shipstation-api-mcp/src/mcp-server.js"],
      "env": {
        "SHIPSTATION_API_KEY": "your_v2_api_key",
        "SHIPSTATION_V1_API_KEY": "your_v1_api_key",
        "SHIPSTATION_V1_API_SECRET": "your_v1_api_secret"
      }
    }
  }
}
```

**Note:** The `SHIPSTATION_API_URL` environment variable is optional. If not provided, it defaults to the standard ShipStation API URL.

### Docker Container

**v2-only mode:**

```json
{
  "mcpServers": {
    "shipstation": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "--env",
        "SHIPSTATION_API_KEY=your_api_key_here",
        "--env",
        "SHIPSTATION_API_URL=https://custom-api.example.com",
        "shipstation-api-mcp"
      ]
    }
  }
}
```

**Dual-client mode (v1 + v2):**

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

### Docker Compose

```json
{
  "mcpServers": {
    "shipstation": {
      "command": "docker-compose",
      "args": [
        "run",
        "--rm",
        "shipstation-mcp"
      ],
      "cwd": "/path/to/shipstation-api-mcp"
    }
  }
}
```

**Docker Setup:**
1. **Build the image first:**
   ```bash
   cd /path/to/shipstation-api-mcp
   docker build -t shipstation-api-mcp .
   ```
2. Set your API key in `.env` file or pass via `--env` flag
3. For Docker Compose: `docker-compose up shipstation-mcp`

**Note**: The Docker image must be built with the tag `shipstation-api-mcp` to match the MCP configuration above.

## Environment Variables

- `SHIPSTATION_API_KEY` - Your ShipStation v2 API key (required)
- `SHIPSTATION_API_URL` - Custom ShipStation v2 API base URL (optional, defaults to `https://api.shipstation.com`)
- `SHIPSTATION_V1_API_KEY` - Your ShipStation v1 API key (optional, enables dual-client mode)
- `SHIPSTATION_V1_API_SECRET` - Your ShipStation v1 API secret (required if v1 key is set)
- `SHIPSTATION_V1_API_URL` - Custom ShipStation v1 API base URL (optional, defaults to `https://ssapi.shipstation.com`)
- `MCP_IDLE_TIMEOUT_SECONDS` - Idle-exit threshold for the lifecycle watchdog (optional, default `1800` = 30 min, capped at 24h). The watchdog also self-exits within ~20s if the parent process dies (prevents orphan accumulation on shared MCP hosts).
- `MCP_DISABLE_WATCHDOG` - Set to `1` to disable the lifecycle watchdog (debug only; leaves orphan-process risk in place).
- `MCP_SHARED_MUX_CHILD` - Set to `1` (by mcp-mux) to skip ONLY the idle-timeout exit; absent or any other value leaves the idle kill on. The parent-death exit is unaffected.

⚠️ **Security Note**: Never commit your `.env` file to git. The `.env` file contains sensitive API keys and should only exist locally or in secure deployment environments.

## MCP Tools

The MCP server provides the following tools for AI assistants:

### Shipment Tools
- `get_shipments` - List shipments with optional filtering
- `create_shipment` - Create a new shipment (use warehouse_id OR ship_from, not both)
- `create_shipments_bulk` - Create multiple shipments in a single API call for bulk processing
- `get_shipment_by_id` - Get shipment details by ID
- `get_shipment_by_external_id` - Get shipment by external ID
- `update_shipment` - Update a shipment by its ID (requires complete shipment data)
- `cancel_shipment` - Cancel a shipment
- `get_shipment_rates` - Get rates for an existing shipment
- `tag_shipment` - Add a tag to a shipment
- `untag_shipment` - Remove a tag from a shipment

### Label Tools
- `get_labels` - List shipping labels
- `create_label` - Create a new shipping label
- `create_label_from_rate` - Create a label from an existing rate
- `create_label_from_shipment` - Create a label from an existing shipment
- `create_return_label` - Create a return label for an existing label
- `get_label_by_id` - Get label details by ID
- `void_label` - Void a shipping label
- `track_package` - Track a package using label ID

### Rate Tools
- `calculate_rates` - Calculate shipping rates for a shipment
- `estimate_rates` - Estimate shipping rates with minimal address information
- `get_rate_by_id` - Get rate details by ID

### Carrier Tools
- `get_carriers` - List available carriers
- `get_carrier_by_id` - Get carrier details by ID
- `get_carrier_services` - Get services for a specific carrier
- `get_carrier_options` - Get carrier-specific options
- `get_carrier_package_types` - Get package types for a specific carrier

### Warehouse & Inventory Tools
- `get_warehouses` - List warehouses
- `get_warehouse_by_id` - Get warehouse details by ID
- `get_inventory` - Get inventory levels
- `update_inventory` - Update SKU stock levels
- `get_inventory_warehouses` - Get inventory warehouses
- `create_inventory_warehouse` - Create a new inventory warehouse
- `get_inventory_warehouse_by_id` - Get inventory warehouse by ID
- `update_inventory_warehouse` - Update inventory warehouse
- `delete_inventory_warehouse` - Delete inventory warehouse
- `get_inventory_locations` - Get inventory locations
- `create_inventory_location` - Create a new inventory location
- `get_inventory_location_by_id` - Get inventory location by ID
- `update_inventory_location` - Update inventory location
- `delete_inventory_location` - Delete inventory location

### Batch Tools ⭐ **RECOMMENDED for Bulk Operations**
- `get_batches` - List batches with filtering parameters
- `create_batch` - Create a new batch for bulk label processing
- `get_batch_by_id` - Get batch details by ID
- `get_batch_by_external_id` - Get batch by external batch ID
- `update_batch` - Update batch information
- `delete_batch` - Delete a batch
- `add_to_batch` - Add shipments to an existing batch (all shipments must have same warehouse_id)
- `remove_from_batch` - Remove items from a batch
- `get_batch_errors` - Get validation errors for a batch
- `process_batch` - Process a batch to create labels (BEST METHOD for bulk label creation)

> **💡 Best Practice**: Use batches for creating multiple labels efficiently. The `process_batch` tool is the most efficient method for bulk label creation - it avoids rate limits and creates all labels in one operation instead of individual API calls.

### Manifest Tools
- `get_manifests` - List manifests with filtering parameters
- `create_manifest` - Create a new manifest for end-of-day processing
- `get_manifest_by_id` - Get manifest details by ID

## v1 Tools (Dual-Client Mode)

The following tools are available when `SHIPSTATION_V1_API_KEY` and `SHIPSTATION_V1_API_SECRET` are configured. All are prefixed with `v1_` to distinguish them from v2 tools.

### Orders (v1-exclusive)
- `v1_list_orders` - Search/filter orders by customer name, item keyword, order number, status, date ranges, store ID
- `v1_get_order` - Get full order detail by order ID
- `v1_create_order` - Create or update an order with items, addresses, and shipping details
- `v1_create_orders` - Bulk create/update multiple orders
- `v1_delete_order` - Delete an order by ID
- `v1_hold_order` - Place an order on hold until a specified date
- `v1_restore_order` - Restore an order from hold status
- `v1_mark_order_shipped` - Mark an order as shipped with tracking details
- `v1_add_order_tag` - Add a tag to an order
- `v1_remove_order_tag` - Remove a tag from an order
- `v1_assign_order_user` - Assign a user to an order
- `v1_create_order_label` - Create a shipping label directly for an order

### Customers (v1-exclusive)
- `v1_list_customers` - Search customers by state, country, marketplace, tag
- `v1_get_customer` - Get customer detail by customer ID

### Stores (v1-exclusive)
- `v1_list_stores` - List connected marketplace stores
- `v1_get_store` - Get store detail by store ID
- `v1_update_store` - Update store configuration
- `v1_deactivate_store` - Deactivate a connected store
- `v1_reactivate_store` - Reactivate a previously deactivated store
- `v1_list_marketplaces` - List all available marketplace integrations

### Fulfillments (v1-exclusive)
- `v1_list_fulfillments` - Search fulfillments by order ID, tracking number, recipient name, date ranges

### Products (enhanced search)
- `v1_list_products` - Search products by SKU, name, UPC, category, type, tag, active status
- `v1_get_product` - Get product detail by product ID
- `v1_update_product` - Update product details

### Shipments (enhanced filters)
- `v1_list_shipments` - Search shipments by recipient name, order number, tracking number, carrier, service
- `v1_get_rates` - Get shipping rates with origin/destination and weight
- `v1_create_label` - Create a shipping label
- `v1_void_label` - Void a shipping label by shipment ID

### Carriers
- `v1_list_carriers` - List all connected carrier accounts
- `v1_list_carrier_services` - List available services for a carrier code
- `v1_list_carrier_packages` - List available package types for a carrier code

### Warehouses
- `v1_list_warehouses` - List all warehouses
- `v1_get_warehouse` - Get warehouse detail by ID
- `v1_create_warehouse` - Create a new warehouse
- `v1_update_warehouse` - Update warehouse details
- `v1_delete_warehouse` - Delete a warehouse

### Webhooks
- `v1_list_webhooks` - List all registered webhooks
- `v1_subscribe_webhook` - Subscribe to a webhook event
- `v1_unsubscribe_webhook` - Unsubscribe from a webhook

### Tags
- `v1_list_tags` - List all account tags

## Testing

The project includes comprehensive tests organized by category:

```bash
# Run all tests
npm test

# Run specific test types
npm run test:unit          # Unit tests (fast, no API key needed)
npm run test:integration   # Integration tests (requires API key)
npm run test:e2e          # End-to-end Docker tests

# Watch mode for development
npm run test:watch
```

**Note:** Integration and E2E tests require `SHIPSTATION_API_KEY` environment variable.

## Security

🔒 **API Key Protection**:
- The `.env` file is automatically ignored by git (see `.gitignore`)
- Never commit API keys to version control
- Use environment variables in production deployments
- Rotate API keys if accidentally exposed

🐳 **Docker Security**:
- Containers run as non-root user (`mcp`)
- API keys passed via environment variables only
- No secrets baked into images

## Requirements

- Node.js 16+
- ShipStation API key (Scale-Gold plan or higher)
- Docker (optional, for containerized deployment)

## Notes

- This is an MVP implementation covering core ShipStation API functionality
- Error handling includes proper HTTP status codes and descriptive messages
- All endpoints proxy to the official ShipStation API v2
- v1 endpoints proxy to `https://ssapi.shipstation.com` using Basic Auth
- File downloads are supported for labels, manifests, and other documents
- CORS is enabled for cross-origin requests
- Comprehensive test suite with unit, integration, and E2E tests