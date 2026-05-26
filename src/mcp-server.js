#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import ShipStationClient from './shipstation-client.js';
import ShipStationClientV1 from './shipstation-client-v1.js';
import { startLifecycleWatchdog, wrapWithActivityBump } from './watchdog.js';

dotenv.config();

const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_API_URL = process.env.SHIPSTATION_API_URL;
const SHIPSTATION_V1_API_KEY = process.env.SHIPSTATION_V1_API_KEY;
const SHIPSTATION_V1_API_SECRET = process.env.SHIPSTATION_V1_API_SECRET;
const SHIPSTATION_V1_API_URL = process.env.SHIPSTATION_V1_API_URL;

if (!SHIPSTATION_API_KEY) {
  console.error('Error: SHIPSTATION_API_KEY environment variable is required');
  process.exit(1);
}

const shipstation = new ShipStationClient(SHIPSTATION_API_KEY, SHIPSTATION_API_URL);

// Instantiate v1 client if both key and secret are provided
let shipstationV1 = null;
if (SHIPSTATION_V1_API_KEY && SHIPSTATION_V1_API_SECRET) {
  shipstationV1 = new ShipStationClientV1(SHIPSTATION_V1_API_KEY, SHIPSTATION_V1_API_SECRET, SHIPSTATION_V1_API_URL);
  console.error('ShipStation v1 API enabled — dual-client mode active');
} else {
  console.error('ShipStation v1 API not configured — v2 only mode');
}

// ─── v2 Tool Definitions ───────────────────────────────────────────────────────

const v2Tools = [
  // Shipment tools
  {
    name: 'get_shipments',
    description: 'List shipments with optional filtering parameters',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number for pagination' },
        page_size: { type: 'number', description: 'Number of items per page' },
        status: { type: 'string', description: 'Filter by shipment status' },
        external_shipment_id: { type: 'string', description: 'Filter by external shipment ID' }
      }
    }
  },
  {
    name: 'create_shipment',
    description: 'Create a new shipment (IMPORTANT: Use either warehouse_id OR ship_from address, not both. Prefer warehouse_id when available)',
    inputSchema: {
      type: 'object',
      properties: {
        shipment: {
          type: 'object',
          required: ['ship_to', 'ship_from', 'packages'],
          properties: {
            carrier_id: { type: 'string', description: 'Carrier ID' },
            service_code: { type: 'string', description: 'Service code' },
            external_shipment_id: { type: 'string', description: 'External shipment ID' },
            ship_date: { type: 'string', description: 'Ship date (YYYY-MM-DD)' },
            create_sales_order: { type: 'boolean', description: 'Whether to create a sales order for this shipment', default: false },
            store_id: { type: 'string', description: 'Store ID associated with the shipment' },
            notes_from_buyer: { type: 'string', description: 'Notes from the buyer' },
            notes_for_gift: { type: 'string', description: 'Gift notes' },
            is_gift: { type: 'boolean', description: 'Indicates if the shipment is a gift', default: false },
            validate_address: { type: 'string', description: 'Address validation option', enum: ['no_validation', 'validate_only', 'validate_and_clean'] },
            warehouse_id: { type: 'string', description: 'The warehouse that the shipment is being shipped from (PREFERRED: Use this instead of ship_from when shipping from a warehouse)' },
            ship_to: {
              type: 'object',
              required: ['name', 'address_line1', 'city_locality', 'state_province', 'postal_code', 'country_code'],
              properties: {
                name: { type: 'string' },
                address_line1: { type: 'string' },
                address_line2: { type: 'string' },
                city_locality: { type: 'string' },
                state_province: { type: 'string' },
                postal_code: { type: 'string' },
                country_code: { type: 'string' }
              }
            },
            ship_from: {
              type: 'object',
              description: 'Ship from address (NOTE: Cannot be used with warehouse_id - use warehouse_id when available)',
              required: ['name', 'address_line1', 'city_locality', 'state_province', 'postal_code', 'country_code'],
              properties: {
                name: { type: 'string' },
                address_line1: { type: 'string' },
                address_line2: { type: 'string' },
                city_locality: { type: 'string' },
                state_province: { type: 'string' },
                postal_code: { type: 'string' },
                country_code: { type: 'string' }
              }
            },
            packages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  weight: {
                    type: 'object',
                    properties: {
                      value: { type: 'number' },
                      unit: { type: 'string', enum: ['pound', 'ounce', 'kilogram', 'gram'] }
                    }
                  },
                  dimensions: {
                    type: 'object',
                    properties: {
                      unit: { type: 'string', enum: ['inch', 'centimeter'] },
                      length: { type: 'number' },
                      width: { type: 'number' },
                      height: { type: 'number' }
                    }
                  }
                }
              }
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Item name' },
                  sku: { type: 'string', description: 'Item SKU' },
                  quantity: { type: 'number', description: 'Item quantity' },
                  unit_price: {
                    type: 'number',
                    description: 'Unit price of the item'
                  }
                }
              },
              description: 'Items in the shipment (useful for sales orders)'
            }
          }
        }
      },
      required: ['shipment']
    }
  },
  {
    name: 'get_shipment_by_id',
    description: 'Get a shipment by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        shipment_id: { type: 'string', description: 'The shipment ID' }
      },
      required: ['shipment_id']
    }
  },
  {
    name: 'cancel_shipment',
    description: 'Cancel a shipment',
    inputSchema: {
      type: 'object',
      properties: {
        shipment_id: { type: 'string', description: 'The shipment ID to cancel' }
      },
      required: ['shipment_id']
    }
  },
  {
    name: 'get_shipment_by_external_id',
    description: 'Get a shipment by its external ID',
    inputSchema: {
      type: 'object',
      properties: {
        external_shipment_id: { type: 'string', description: 'The external shipment ID' }
      },
      required: ['external_shipment_id']
    }
  },
  {
    name: 'get_shipment_rates',
    description: 'Get rates for an existing shipment',
    inputSchema: {
      type: 'object',
      properties: {
        shipment_id: { type: 'string', description: 'The shipment ID' }
      },
      required: ['shipment_id']
    }
  },
  {
    name: 'tag_shipment',
    description: 'Add a tag to a shipment',
    inputSchema: {
      type: 'object',
      properties: {
        shipment_id: { type: 'string', description: 'The shipment ID' },
        tag_name: { type: 'string', description: 'The tag name to add' }
      },
      required: ['shipment_id', 'tag_name']
    }
  },
  {
    name: 'untag_shipment',
    description: 'Remove a tag from a shipment',
    inputSchema: {
      type: 'object',
      properties: {
        shipment_id: { type: 'string', description: 'The shipment ID' },
        tag_name: { type: 'string', description: 'The tag name to remove' }
      },
      required: ['shipment_id', 'tag_name']
    }
  },
  {
    name: 'create_shipments_bulk',
    description: 'Create multiple shipments in a single API call for bulk processing (IMPORTANT: Use either warehouse_id OR ship_from address per shipment, not both)',
    inputSchema: {
      type: 'object',
      properties: {
        shipments: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            required: ['ship_to', 'ship_from', 'packages'],
            properties: {
              carrier_id: { type: 'string', description: 'Carrier ID' },
              service_code: { type: 'string', description: 'Service code' },
              external_shipment_id: { type: 'string', description: 'External shipment ID' },
              ship_date: { type: 'string', description: 'Ship date (YYYY-MM-DD)' },
              create_sales_order: { type: 'boolean', description: 'Whether to create a sales order for this shipment', default: false },
              store_id: { type: 'string', description: 'Store ID associated with the shipment' },
              notes_from_buyer: { type: 'string', description: 'Notes from the buyer' },
              notes_for_gift: { type: 'string', description: 'Gift notes' },
              is_gift: { type: 'boolean', description: 'Indicates if the shipment is a gift', default: false },
              validate_address: { type: 'string', description: 'Address validation option', enum: ['no_validation', 'validate_only', 'validate_and_clean'] },
              warehouse_id: { type: 'string', description: 'The warehouse that the shipment is being shipped from (PREFERRED: Use this instead of ship_from when shipping from a warehouse)' },
              ship_to: {
                type: 'object',
                required: ['name', 'address_line1', 'city_locality', 'state_province', 'postal_code', 'country_code'],
                properties: {
                  name: { type: 'string' },
                  address_line1: { type: 'string' },
                  address_line2: { type: 'string' },
                  city_locality: { type: 'string' },
                  state_province: { type: 'string' },
                  postal_code: { type: 'string' },
                  country_code: { type: 'string' }
                }
              },
              ship_from: {
                type: 'object',
                description: 'Ship from address (NOTE: Cannot be used with warehouse_id - use warehouse_id when available)',
                required: ['name', 'address_line1', 'city_locality', 'state_province', 'postal_code', 'country_code'],
                properties: {
                  name: { type: 'string' },
                  address_line1: { type: 'string' },
                  address_line2: { type: 'string' },
                  city_locality: { type: 'string' },
                  state_province: { type: 'string' },
                  postal_code: { type: 'string' },
                  country_code: { type: 'string' }
                }
              },
              packages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    weight: {
                      type: 'object',
                      properties: {
                        value: { type: 'number' },
                        unit: { type: 'string', enum: ['pound', 'ounce', 'kilogram', 'gram'] }
                      }
                    },
                    dimensions: {
                      type: 'object',
                      properties: {
                        unit: { type: 'string', enum: ['inch', 'centimeter'] },
                        length: { type: 'number' },
                        width: { type: 'number' },
                        height: { type: 'number' }
                      }
                    }
                  }
                }
              },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Item name' },
                    sku: { type: 'string', description: 'Item SKU' },
                    quantity: { type: 'number', description: 'Item quantity' },
                    unit_price: {
                      type: 'number',
                      description: 'Unit price of the item'
                    }
                  }
                },
                description: 'Items in the shipment (useful for sales orders)'
              }
            }
          },
          description: 'Array of shipments to create (1-100 shipments)'
        }
      },
      required: ['shipments']
    }
  },
  {
    name: 'update_shipment',
    description: 'Update a shipment by its ID (IMPORTANT: Requires complete shipment data - partial updates not supported. Use either warehouse_id OR ship_from, not both)',
    inputSchema: {
      type: 'object',
      properties: {
        shipment_id: { type: 'string', description: 'The shipment ID to update' },
        shipment_data: {
          type: 'object',
          description: 'Complete shipment data for update (REQUIRED: Must include all shipment fields, not just changed ones)',
          properties: {
            carrier_id: { type: 'string', description: 'The carrier account that is billed for the shipping charges' },
            service_code: { type: 'string', description: 'The carrier service used to ship the package' },
            shipping_rule_id: { type: 'string', description: 'ID of the shipping rule for automation' },
            external_order_id: { type: 'string', description: 'ID that the Order Source assigned' },
            external_shipment_id: { type: 'string', description: 'A unique user-defined key to identify a shipment' },
            shipment_number: { type: 'string', description: 'A non-unique user-defined number used to identify a shipment' },
            ship_date: { type: 'string', description: 'The date that the shipment was (or will be) shipped (YYYY-MM-DD)' },
            warehouse_id: { type: 'string', description: 'The warehouse that the shipment is being shipped from (PREFERRED: Use this instead of ship_from when shipping from a warehouse)' },
            is_return: { type: 'boolean', description: 'An optional indicator if the shipment is intended to be a return', default: false },
            confirmation: {
              type: 'string',
              description: 'The type of delivery confirmation required',
              enum: ['none', 'delivery', 'signature', 'adult_signature', 'direct_signature', 'delivery_mailed', 'verbal_confirmation'],
              default: 'none'
            },
            insurance_provider: {
              type: 'string',
              description: 'The insurance provider to use',
              enum: ['none', 'shipsurance', 'carrier', 'third_party'],
              default: 'none'
            },
            order_source_code: {
              type: 'string',
              description: 'The order source',
              enum: ['amazon_ca', 'amazon_us', 'brightpearl', 'channel_advisor', 'cratejoy', 'ebay', 'etsy', 'jane', 'groupon_goods', 'magento', 'paypal', 'seller_active', 'shopify', 'stitch_labs', 'squarespace', 'three_dcart', 'tophatter', 'walmart', 'woo_commerce', 'volusion']
            },
            comparison_rate_type: { type: 'string', description: 'Calculate a rate with a different ratecard' },
            validate_address: {
              type: 'string',
              description: 'Address validation option',
              enum: ['no_validation', 'validate_only', 'validate_and_clean'],
              default: 'no_validation'
            },
            ship_to: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                address_line1: { type: 'string' },
                address_line2: { type: 'string' },
                city_locality: { type: 'string' },
                state_province: { type: 'string' },
                postal_code: { type: 'string' },
                country_code: { type: 'string' }
              }
            },
            ship_from: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                address_line1: { type: 'string' },
                address_line2: { type: 'string' },
                city_locality: { type: 'string' },
                state_province: { type: 'string' },
                postal_code: { type: 'string' },
                country_code: { type: 'string' }
              }
            },
            return_to: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                address_line1: { type: 'string' },
                address_line2: { type: 'string' },
                city_locality: { type: 'string' },
                state_province: { type: 'string' },
                postal_code: { type: 'string' },
                country_code: { type: 'string' }
              }
            },
            packages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  weight: {
                    type: 'object',
                    properties: {
                      value: { type: 'number' },
                      unit: { type: 'string', enum: ['pound', 'ounce', 'kilogram', 'gram'] }
                    }
                  },
                  dimensions: {
                    type: 'object',
                    properties: {
                      unit: { type: 'string', enum: ['inch', 'centimeter'] },
                      length: { type: 'number' },
                      width: { type: 'number' },
                      height: { type: 'number' }
                    }
                  }
                }
              }
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Item name' },
                  sku: { type: 'string', description: 'Item SKU' },
                  quantity: { type: 'number', description: 'Item quantity' },
                  unit_price: { type: 'number', description: 'Unit price of the item' }
                }
              },
              description: 'Items in the shipment'
            },
            customs: {
              type: 'object',
              description: 'Customs information for international shipments'
            },
            advanced_options: {
              type: 'object',
              description: 'Advanced shipment options'
            },
            tax_identifiers: {
              type: 'array',
              items: { type: 'object' },
              description: 'Tax identifiers'
            }
          }
        }
      },
      required: ['shipment_id', 'shipment_data']
    }
  },
  // Label tools
  {
    name: 'get_labels',
    description: 'List labels with optional filtering parameters',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number for pagination' },
        page_size: { type: 'number', description: 'Number of items per page' },
        status: { type: 'string', description: 'Filter by label status' },
        shipment_id: { type: 'string', description: 'Filter by shipment ID' }
      }
    }
  },
  {
    name: 'create_label',
    description: 'Create a new shipping label (NOTE: For multiple labels, consider using batches for better performance)',
    inputSchema: {
      type: 'object',
      properties: {
        shipment: {
          type: 'object',
          required: ['ship_to', 'ship_from', 'packages'],
          properties: {
            carrier_id: { type: 'string', description: 'Carrier ID' },
            service_code: { type: 'string', description: 'Service code' },
            external_shipment_id: { type: 'string', description: 'External shipment ID' },
            ship_date: { type: 'string', description: 'Ship date (YYYY-MM-DD)' },
            create_sales_order: { type: 'boolean', description: 'Whether to create a sales order for this label', default: false },
            store_id: { type: 'string', description: 'Store ID associated with the label' },
            validate_address: { type: 'string', description: 'Address validation option', enum: ['no_validation', 'validate_only', 'validate_and_clean'] },
            ship_to: {
              type: 'object',
              required: ['name', 'address_line1', 'city_locality', 'state_province', 'postal_code', 'country_code'],
              properties: {
                name: { type: 'string' },
                address_line1: { type: 'string' },
                address_line2: { type: 'string' },
                city_locality: { type: 'string' },
                state_province: { type: 'string' },
                postal_code: { type: 'string' },
                country_code: { type: 'string' }
              }
            },
            ship_from: {
              type: 'object',
              required: ['name', 'address_line1', 'city_locality', 'state_province', 'postal_code', 'country_code'],
              properties: {
                name: { type: 'string' },
                address_line1: { type: 'string' },
                address_line2: { type: 'string' },
                city_locality: { type: 'string' },
                state_province: { type: 'string' },
                postal_code: { type: 'string' },
                country_code: { type: 'string' }
              }
            },
            packages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  weight: {
                    type: 'object',
                    properties: {
                      value: { type: 'number' },
                      unit: { type: 'string', enum: ['pound', 'ounce', 'kilogram', 'gram'] }
                    }
                  },
                  dimensions: {
                    type: 'object',
                    properties: {
                      unit: { type: 'string', enum: ['inch', 'centimeter'] },
                      length: { type: 'number' },
                      width: { type: 'number' },
                      height: { type: 'number' }
                    }
                  }
                }
              }
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Item name' },
                  sku: { type: 'string', description: 'Item SKU' },
                  quantity: { type: 'number', description: 'Item quantity' },
                  unit_price: {
                    type: 'number',
                    description: 'Unit price of the item'
                  }
                }
              },
              description: 'Items in the label (useful for sales orders)'
            }
          }
        },
        label_format: { type: 'string', description: 'Label format (pdf, png, zpl)', enum: ['pdf', 'png', 'zpl'] },
        label_layout: { type: 'string', description: 'Label layout' }
      },
      required: ['shipment']
    }
  },
  {
    name: 'get_label_by_id',
    description: 'Get a label by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        label_id: { type: 'string', description: 'The label ID' }
      },
      required: ['label_id']
    }
  },
  {
    name: 'void_label',
    description: 'Void a shipping label',
    inputSchema: {
      type: 'object',
      properties: {
        label_id: { type: 'string', description: 'The label ID to void' }
      },
      required: ['label_id']
    }
  },
  {
    name: 'track_package',
    description: 'Track a package using label ID',
    inputSchema: {
      type: 'object',
      properties: {
        label_id: { type: 'string', description: 'The label ID to track' }
      },
      required: ['label_id']
    }
  },
  {
    name: 'create_label_from_rate',
    description: 'Create a label from an existing rate',
    inputSchema: {
      type: 'object',
      properties: {
        rate_id: { type: 'string', description: 'The rate ID' },
        label_format: { type: 'string', description: 'Label format', enum: ['pdf', 'png', 'zpl'] },
        label_layout: { type: 'string', description: 'Label layout' }
      },
      required: ['rate_id']
    }
  },
  {
    name: 'create_label_from_shipment',
    description: 'Create a label from an existing shipment',
    inputSchema: {
      type: 'object',
      properties: {
        shipment_id: { type: 'string', description: 'The shipment ID' },
        label_format: { type: 'string', description: 'Label format', enum: ['pdf', 'png', 'zpl'] },
        label_layout: { type: 'string', description: 'Label layout' }
      },
      required: ['shipment_id']
    }
  },
  {
    name: 'create_return_label',
    description: 'Create a return label for an existing label',
    inputSchema: {
      type: 'object',
      properties: {
        label_id: { type: 'string', description: 'The original label ID' },
        label_format: { type: 'string', description: 'Label format', enum: ['pdf', 'png', 'zpl'] },
        label_layout: { type: 'string', description: 'Label layout' }
      },
      required: ['label_id']
    }
  },
  // Rate tools
  {
    name: 'calculate_rates',
    description: 'Calculate shipping rates for a shipment',
    inputSchema: {
      type: 'object',
      properties: {
        rate_options: {
          type: 'object',
          properties: {
            carrier_ids: { type: 'array', items: { type: 'string' }, description: 'Array of carrier IDs to get rates from' }
          }
        },
        shipment: {
          type: 'object',
          required: ['ship_to', 'ship_from', 'packages'],
          properties: {
            ship_to: {
              type: 'object',
              required: ['name', 'address_line1', 'city_locality', 'state_province', 'postal_code', 'country_code'],
              properties: {
                name: { type: 'string' },
                address_line1: { type: 'string' },
                address_line2: { type: 'string' },
                city_locality: { type: 'string' },
                state_province: { type: 'string' },
                postal_code: { type: 'string' },
                country_code: { type: 'string' }
              }
            },
            ship_from: {
              type: 'object',
              required: ['name', 'address_line1', 'city_locality', 'state_province', 'postal_code', 'country_code'],
              properties: {
                name: { type: 'string' },
                address_line1: { type: 'string' },
                address_line2: { type: 'string' },
                city_locality: { type: 'string' },
                state_province: { type: 'string' },
                postal_code: { type: 'string' },
                country_code: { type: 'string' }
              }
            },
            packages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  weight: {
                    type: 'object',
                    properties: {
                      value: { type: 'number' },
                      unit: { type: 'string' }
                    }
                  },
                  dimensions: {
                    type: 'object',
                    properties: {
                      unit: { type: 'string' },
                      length: { type: 'number' },
                      width: { type: 'number' },
                      height: { type: 'number' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      required: ['shipment']
    }
  },
  {
    name: 'estimate_rates',
    description: 'Estimate shipping rates with minimal address information',
    inputSchema: {
      type: 'object',
      properties: {
        rate_options: {
          type: 'object',
          properties: {
            carrier_ids: { type: 'array', items: { type: 'string' }, description: 'Array of carrier IDs' }
          }
        },
        shipment: {
          type: 'object',
          required: ['ship_to', 'ship_from', 'packages'],
          properties: {
            ship_to: {
              type: 'object',
              required: ['country_code'],
              properties: {
                country_code: { type: 'string' },
                postal_code: { type: 'string' },
                city_locality: { type: 'string' },
                state_province: { type: 'string' }
              }
            },
            ship_from: {
              type: 'object',
              required: ['country_code'],
              properties: {
                country_code: { type: 'string' },
                postal_code: { type: 'string' },
                city_locality: { type: 'string' },
                state_province: { type: 'string' }
              }
            },
            packages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  weight: {
                    type: 'object',
                    properties: {
                      value: { type: 'number' },
                      unit: { type: 'string' }
                    }
                  },
                  dimensions: {
                    type: 'object',
                    properties: {
                      unit: { type: 'string' },
                      length: { type: 'number' },
                      width: { type: 'number' },
                      height: { type: 'number' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      required: ['shipment']
    }
  },
  {
    name: 'get_rate_by_id',
    description: 'Get a rate by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        rate_id: { type: 'string', description: 'The rate ID' }
      },
      required: ['rate_id']
    }
  },
  // Carrier tools
  {
    name: 'get_carriers',
    description: 'List available carriers',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number for pagination' },
        page_size: { type: 'number', description: 'Number of items per page' }
      }
    }
  },
  {
    name: 'get_carrier_services',
    description: 'Get services for a specific carrier',
    inputSchema: {
      type: 'object',
      properties: {
        carrier_id: { type: 'string', description: 'The carrier ID' }
      },
      required: ['carrier_id']
    }
  },
  {
    name: 'get_carrier_by_id',
    description: 'Get a carrier by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        carrier_id: { type: 'string', description: 'The carrier ID' }
      },
      required: ['carrier_id']
    }
  },
  {
    name: 'get_carrier_options',
    description: 'Get carrier-specific options',
    inputSchema: {
      type: 'object',
      properties: {
        carrier_id: { type: 'string', description: 'The carrier ID' }
      },
      required: ['carrier_id']
    }
  },
  {
    name: 'get_carrier_package_types',
    description: 'Get package types for a specific carrier',
    inputSchema: {
      type: 'object',
      properties: {
        carrier_id: { type: 'string', description: 'The carrier ID' }
      },
      required: ['carrier_id']
    }
  },
  // Warehouse tools
  {
    name: 'get_warehouses',
    description: 'List warehouses',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number for pagination' },
        page_size: { type: 'number', description: 'Number of items per page' }
      }
    }
  },
  {
    name: 'get_warehouse_by_id',
    description: 'Get a warehouse by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        warehouse_id: { type: 'string', description: 'The warehouse ID' }
      },
      required: ['warehouse_id']
    }
  },
  // Inventory tools
  {
    name: 'get_inventory',
    description: 'Get inventory levels',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Filter by SKU' },
        inventory_warehouse_id: { type: 'string', description: 'Filter by inventory warehouse ID' },
        inventory_location_id: { type: 'string', description: 'Filter by inventory location ID' },
        group_by: { type: 'string', description: 'Group by warehouse or location', enum: ['warehouse', 'location'] },
        limit: { type: 'number', description: 'Number of items to return' }
      }
    }
  },
  {
    name: 'update_inventory',
    description: 'Update SKU stock levels',
    inputSchema: {
      type: 'object',
      properties: {
        transaction_type: {
          type: 'string',
          description: 'Type of update (increment, decrement, adjust, modify)',
          enum: ['increment', 'decrement', 'adjust', 'modify']
        },
        sku: { type: 'string', description: 'SKU to update' },
        quantity: { type: 'number', description: 'Quantity to update' },
        inventory_location_id: { type: 'string', description: 'Inventory location ID' },
        cost: {
          type: 'object',
          properties: {
            amount: { type: 'number' },
            currency: { type: 'string' }
          },
          description: 'Cost information'
        },
        condition: {
          type: 'string',
          enum: ['sellable', 'damaged', 'expired', 'qa_hold'],
          description: 'Inventory condition'
        },
        reason: { type: 'string', description: 'Reason for update' },
        notes: { type: 'string', description: 'Additional notes' }
      },
      required: ['transaction_type', 'sku', 'quantity', 'inventory_location_id']
    }
  },
  {
    name: 'get_inventory_warehouses',
    description: 'Get inventory warehouses',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of items to return' }
      }
    }
  },
  {
    name: 'create_inventory_warehouse',
    description: 'Create a new inventory warehouse',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Warehouse name' }
      },
      required: ['name']
    }
  },
  {
    name: 'get_inventory_locations',
    description: 'Get inventory locations',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of items to return' }
      }
    }
  },
  {
    name: 'create_inventory_location',
    description: 'Create a new inventory location',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Location name' },
        inventory_warehouse_id: { type: 'string', description: 'Warehouse ID' }
      },
      required: ['name', 'inventory_warehouse_id']
    }
  },
  {
    name: 'get_inventory_warehouse_by_id',
    description: 'Get an inventory warehouse by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        warehouse_id: { type: 'string', description: 'The inventory warehouse ID' }
      },
      required: ['warehouse_id']
    }
  },
  {
    name: 'update_inventory_warehouse',
    description: 'Update an inventory warehouse',
    inputSchema: {
      type: 'object',
      properties: {
        warehouse_id: { type: 'string', description: 'The inventory warehouse ID' },
        warehouse_data: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Warehouse name' }
          }
        }
      },
      required: ['warehouse_id', 'warehouse_data']
    }
  },
  {
    name: 'delete_inventory_warehouse',
    description: 'Delete an inventory warehouse',
    inputSchema: {
      type: 'object',
      properties: {
        warehouse_id: { type: 'string', description: 'The inventory warehouse ID to delete' }
      },
      required: ['warehouse_id']
    }
  },
  {
    name: 'get_inventory_location_by_id',
    description: 'Get an inventory location by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'The inventory location ID' }
      },
      required: ['location_id']
    }
  },
  {
    name: 'update_inventory_location',
    description: 'Update an inventory location',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'The inventory location ID' },
        location_data: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Location name' },
            inventory_warehouse_id: { type: 'string', description: 'Warehouse ID' }
          }
        }
      },
      required: ['location_id', 'location_data']
    }
  },
  {
    name: 'delete_inventory_location',
    description: 'Delete an inventory location',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', description: 'The inventory location ID to delete' }
      },
      required: ['location_id']
    }
  },
  // Batch tools
  {
    name: 'get_batches',
    description: 'List batches with optional filtering parameters',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number for pagination' },
        page_size: { type: 'number', description: 'Number of items per page' },
        batch_number: { type: 'string', description: 'Filter by batch number' },
        external_batch_id: { type: 'string', description: 'Filter by external batch ID' },
        batch_status: { type: 'string', description: 'Filter by batch status' }
      }
    }
  },
  {
    name: 'create_batch',
    description: 'Create a new batch for bulk label processing (RECOMMENDED: Use batches for efficient bulk label creation instead of individual label calls)',
    inputSchema: {
      type: 'object',
      properties: {
        batch_number: { type: 'string', description: 'Batch number' },
        external_batch_id: { type: 'string', description: 'External batch ID' },
        batch_notes: { type: 'string', description: 'Notes for the batch' }
      }
    }
  },
  {
    name: 'get_batch_by_id',
    description: 'Get a batch by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: { type: 'string', description: 'The batch ID' }
      },
      required: ['batch_id']
    }
  },
  {
    name: 'get_batch_by_external_id',
    description: 'Get a batch by its external ID',
    inputSchema: {
      type: 'object',
      properties: {
        external_batch_id: { type: 'string', description: 'The external batch ID' }
      },
      required: ['external_batch_id']
    }
  },
  {
    name: 'update_batch',
    description: 'Update batch information',
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: { type: 'string', description: 'The batch ID' },
        batch_data: {
          type: 'object',
          properties: {
            batch_number: { type: 'string', description: 'Batch number' },
            external_batch_id: { type: 'string', description: 'External batch ID' },
            batch_notes: { type: 'string', description: 'Notes for the batch' }
          }
        }
      },
      required: ['batch_id', 'batch_data']
    }
  },
  {
    name: 'delete_batch',
    description: 'Delete a batch',
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: { type: 'string', description: 'The batch ID to delete' }
      },
      required: ['batch_id']
    }
  },
  {
    name: 'add_to_batch',
    description: 'Add shipments to an existing batch (BEST PRACTICE: Use batches for bulk operations to avoid rate limits. IMPORTANT: All shipments must have the same warehouse_id)',
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: { type: 'string', description: 'The batch ID' },
        shipment_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of shipment IDs to add to the batch (NOTE: All shipments must belong to the same warehouse)'
        },
        rate_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of rate IDs to add to the batch'
        }
      },
      required: ['batch_id']
    }
  },
  {
    name: 'remove_from_batch',
    description: 'Remove items from a batch',
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: { type: 'string', description: 'The batch ID' },
        shipment_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of shipment IDs to remove from the batch'
        },
        rate_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of rate IDs to remove from the batch'
        }
      },
      required: ['batch_id']
    }
  },
  {
    name: 'get_batch_errors',
    description: 'Get validation errors for a batch',
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: { type: 'string', description: 'The batch ID' }
      },
      required: ['batch_id']
    }
  },
  {
    name: 'process_batch',
    description: 'Process a batch to create labels for all items (BEST PRACTICE: This is the most efficient method for bulk label creation - avoids rate limits and creates all labels in one operation)',
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: { type: 'string', description: 'The batch ID' },
        label_format: { type: 'string', description: 'Label format', enum: ['pdf', 'png', 'zpl'] },
        label_layout: { type: 'string', description: 'Label layout' }
      },
      required: ['batch_id']
    }
  },
  // Manifest tools
  {
    name: 'get_manifests',
    description: 'List manifests with optional filtering parameters',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number for pagination' },
        page_size: { type: 'number', description: 'Number of items per page' },
        carrier_id: { type: 'string', description: 'Filter by carrier ID' },
        warehouse_id: { type: 'string', description: 'Filter by warehouse ID' },
        ship_date_start: { type: 'string', description: 'Filter by ship date start (YYYY-MM-DD)' },
        ship_date_end: { type: 'string', description: 'Filter by ship date end (YYYY-MM-DD)' },
        created_at_start: { type: 'string', description: 'Filter by creation date start (YYYY-MM-DD)' },
        created_at_end: { type: 'string', description: 'Filter by creation date end (YYYY-MM-DD)' }
      }
    }
  },
  {
    name: 'create_manifest',
    description: 'Create a new manifest for end-of-day processing',
    inputSchema: {
      type: 'object',
      properties: {
        carrier_id: { type: 'string', description: 'Carrier ID for the manifest' },
        warehouse_id: { type: 'string', description: 'Warehouse ID for the manifest' },
        ship_date: { type: 'string', description: 'Ship date for the manifest (YYYY-MM-DD)' },
        label_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of label IDs to include in the manifest'
        },
        excluded_label_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of label IDs to exclude from the manifest'
        }
      },
      required: ['carrier_id']
    }
  },
  {
    name: 'get_manifest_by_id',
    description: 'Get a manifest by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        manifest_id: { type: 'string', description: 'The manifest ID' }
      },
      required: ['manifest_id']
    }
  }
];

// ─── v1 Tool Definitions ───────────────────────────────────────────────────────

const v1Tools = [
  // ── Orders (v1-exclusive) ──────────────────────────────────────────────────
  {
    name: 'v1_list_orders',
    description: '[ShipStation v1 API] Search/filter orders by customer name, item keyword, order number, status, date ranges, store ID. Supports sorting and pagination (max 500/page)',
    inputSchema: {
      type: 'object',
      properties: {
        customerName: { type: 'string', description: 'Filter by customer name (contains match)' },
        itemKeyword: { type: 'string', description: 'Filter by item keyword (searches item names and SKUs)' },
        createDateStart: { type: 'string', description: 'Filter by create date start (YYYY-MM-DD HH:MM:SS)' },
        createDateEnd: { type: 'string', description: 'Filter by create date end (YYYY-MM-DD HH:MM:SS)' },
        modifyDateStart: { type: 'string', description: 'Filter by modify date start (YYYY-MM-DD HH:MM:SS)' },
        modifyDateEnd: { type: 'string', description: 'Filter by modify date end (YYYY-MM-DD HH:MM:SS)' },
        orderDateStart: { type: 'string', description: 'Filter by order date start (YYYY-MM-DD HH:MM:SS)' },
        orderDateEnd: { type: 'string', description: 'Filter by order date end (YYYY-MM-DD HH:MM:SS)' },
        orderNumber: { type: 'string', description: 'Filter by order number' },
        orderStatus: { type: 'string', description: 'Filter by order status (awaiting_payment, awaiting_shipment, shipped, on_hold, cancelled)' },
        paymentDateStart: { type: 'string', description: 'Filter by payment date start (YYYY-MM-DD HH:MM:SS)' },
        paymentDateEnd: { type: 'string', description: 'Filter by payment date end (YYYY-MM-DD HH:MM:SS)' },
        storeId: { type: 'number', description: 'Filter by store ID' },
        sortBy: { type: 'string', description: 'Sort by field (OrderDate, ModifyDate, CreateDate)', enum: ['OrderDate', 'ModifyDate', 'CreateDate'] },
        sortDir: { type: 'string', description: 'Sort direction', enum: ['ASC', 'DESC'] },
        page: { type: 'number', description: 'Page number (default 1)' },
        pageSize: { type: 'number', description: 'Items per page (max 500, default 100)' }
      }
    }
  },
  {
    name: 'v1_get_order',
    description: '[ShipStation v1 API] Get full order detail by order ID — includes items, addresses, tags, shipping preferences',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'number', description: 'The order ID' }
      },
      required: ['orderId']
    }
  },
  {
    name: 'v1_create_order',
    description: '[ShipStation v1 API] Create or update an order with full item, address, and shipping details',
    inputSchema: {
      type: 'object',
      properties: {
        orderNumber: { type: 'string', description: 'Order number (required)' },
        orderDate: { type: 'string', description: 'Order date (YYYY-MM-DDTHH:MM:SS.0000000)' },
        paymentDate: { type: 'string', description: 'Payment date' },
        orderStatus: { type: 'string', description: 'Order status (awaiting_payment, awaiting_shipment, shipped, on_hold, cancelled)' },
        customerUsername: { type: 'string', description: 'Customer username' },
        customerEmail: { type: 'string', description: 'Customer email' },
        billTo: { type: 'object', description: 'Billing address object (name, street1, street2, city, state, postalCode, country, phone)' },
        shipTo: { type: 'object', description: 'Shipping address object (name, street1, street2, city, state, postalCode, country, phone)' },
        items: {
          type: 'array',
          description: 'Array of order items',
          items: {
            type: 'object',
            properties: {
              lineItemKey: { type: 'string', description: 'Line item key' },
              sku: { type: 'string', description: 'Item SKU' },
              name: { type: 'string', description: 'Item name' },
              quantity: { type: 'number', description: 'Quantity' },
              unitPrice: { type: 'number', description: 'Unit price' },
              weight: { type: 'object', description: 'Weight object (value, units)' }
            }
          }
        },
        amountPaid: { type: 'number', description: 'Amount paid' },
        taxAmount: { type: 'number', description: 'Tax amount' },
        shippingAmount: { type: 'number', description: 'Shipping amount' },
        customerNotes: { type: 'string', description: 'Customer notes' },
        internalNotes: { type: 'string', description: 'Internal notes' },
        gift: { type: 'boolean', description: 'Is gift' },
        giftMessage: { type: 'string', description: 'Gift message' },
        requestedShippingService: { type: 'string', description: 'Requested shipping service' },
        carrierCode: { type: 'string', description: 'Carrier code' },
        serviceCode: { type: 'string', description: 'Service code' },
        packageCode: { type: 'string', description: 'Package code' },
        confirmation: { type: 'string', description: 'Delivery confirmation (none, delivery, signature, adult_signature, direct_signature)' },
        shipDate: { type: 'string', description: 'Ship date (YYYY-MM-DD)' },
        weight: { type: 'object', description: 'Total weight object (value, units)' },
        dimensions: { type: 'object', description: 'Dimensions object (length, width, height, units)' },
        insuranceOptions: { type: 'object', description: 'Insurance options object' },
        internationalOptions: { type: 'object', description: 'International options object' },
        advancedOptions: { type: 'object', description: 'Advanced options object (storeId, warehouseId, customField1, customField2, customField3, etc.)' },
        tagIds: { type: 'array', items: { type: 'number' }, description: 'Array of tag IDs' }
      },
      required: ['orderNumber', 'orderDate', 'orderStatus', 'billTo', 'shipTo']
    }
  },
  {
    name: 'v1_create_orders',
    description: '[ShipStation v1 API] Bulk create/update multiple orders in a single request',
    inputSchema: {
      type: 'object',
      properties: {
        orders: {
          type: 'array',
          description: 'Array of order objects (same shape as v1_create_order)',
          items: { type: 'object' }
        }
      },
      required: ['orders']
    }
  },
  {
    name: 'v1_delete_order',
    description: '[ShipStation v1 API] Delete an order by ID',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'number', description: 'The order ID to delete' }
      },
      required: ['orderId']
    }
  },
  {
    name: 'v1_hold_order',
    description: '[ShipStation v1 API] Place an order on hold until a specified date',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'number', description: 'The order ID to hold' },
        holdUntilDate: { type: 'string', description: 'Date to hold until (YYYY-MM-DD)' }
      },
      required: ['orderId', 'holdUntilDate']
    }
  },
  {
    name: 'v1_restore_order',
    description: '[ShipStation v1 API] Restore an order from hold status',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'number', description: 'The order ID to restore from hold' }
      },
      required: ['orderId']
    }
  },
  {
    name: 'v1_mark_order_shipped',
    description: '[ShipStation v1 API] Mark an order as shipped with carrier, service, tracking number, and ship date',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'number', description: 'The order ID to mark as shipped' },
        carrierCode: { type: 'string', description: 'Carrier code' },
        shipDate: { type: 'string', description: 'Ship date (YYYY-MM-DD)' },
        trackingNumber: { type: 'string', description: 'Tracking number' },
        notifyCustomer: { type: 'boolean', description: 'Whether to notify customer' },
        notifySalesChannel: { type: 'boolean', description: 'Whether to notify the sales channel' }
      },
      required: ['orderId', 'carrierCode']
    }
  },
  {
    name: 'v1_add_order_tag',
    description: '[ShipStation v1 API] Add a tag to an order',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'number', description: 'The order ID' },
        tagId: { type: 'number', description: 'The tag ID to add' }
      },
      required: ['orderId', 'tagId']
    }
  },
  {
    name: 'v1_remove_order_tag',
    description: '[ShipStation v1 API] Remove a tag from an order',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'number', description: 'The order ID' },
        tagId: { type: 'number', description: 'The tag ID to remove' }
      },
      required: ['orderId', 'tagId']
    }
  },
  {
    name: 'v1_assign_order_user',
    description: '[ShipStation v1 API] Assign a user to an order',
    inputSchema: {
      type: 'object',
      properties: {
        orderIds: { type: 'array', items: { type: 'number' }, description: 'Array of order IDs to assign' },
        userId: { type: 'string', description: 'The user ID to assign' }
      },
      required: ['orderIds', 'userId']
    }
  },
  {
    name: 'v1_create_order_label',
    description: '[ShipStation v1 API] Create a shipping label directly for an order',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'number', description: 'The order ID' },
        carrierCode: { type: 'string', description: 'Carrier code' },
        serviceCode: { type: 'string', description: 'Service code' },
        packageCode: { type: 'string', description: 'Package code' },
        confirmation: { type: 'string', description: 'Delivery confirmation type (none, delivery, signature, adult_signature, direct_signature)' },
        shipDate: { type: 'string', description: 'Ship date (YYYY-MM-DD)' },
        weight: { type: 'object', description: 'Weight object (value, units)' },
        dimensions: { type: 'object', description: 'Dimensions object (length, width, height, units)' },
        insuranceOptions: { type: 'object', description: 'Insurance options' },
        internationalOptions: { type: 'object', description: 'International/customs options' },
        advancedOptions: { type: 'object', description: 'Advanced options' },
        testLabel: { type: 'boolean', description: 'Create a test label' }
      },
      required: ['orderId', 'carrierCode', 'serviceCode', 'confirmation', 'shipDate', 'weight']
    }
  },
  // ── Customers (v1-exclusive) ───────────────────────────────────────────────
  {
    name: 'v1_list_customers',
    description: '[ShipStation v1 API] Search customers by state, country, marketplace, tag. Supports sorting and pagination',
    inputSchema: {
      type: 'object',
      properties: {
        stateCode: { type: 'string', description: 'Filter by state/province code' },
        countryCode: { type: 'string', description: 'Filter by country code (2-letter ISO)' },
        marketplaceId: { type: 'number', description: 'Filter by marketplace ID' },
        tagId: { type: 'number', description: 'Filter by tag ID' },
        sortBy: { type: 'string', description: 'Sort by field (Name, ModifyDate, CreateDate)', enum: ['Name', 'ModifyDate', 'CreateDate'] },
        sortDir: { type: 'string', description: 'Sort direction', enum: ['ASC', 'DESC'] },
        page: { type: 'number', description: 'Page number (default 1)' },
        pageSize: { type: 'number', description: 'Items per page (max 500, default 100)' }
      }
    }
  },
  {
    name: 'v1_get_customer',
    description: '[ShipStation v1 API] Get customer detail by customer ID',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'number', description: 'The customer ID' }
      },
      required: ['customerId']
    }
  },
  // ── Stores (v1-exclusive) ──────────────────────────────────────────────────
  {
    name: 'v1_list_stores',
    description: '[ShipStation v1 API] List connected marketplace stores. Filter by marketplace ID and active status',
    inputSchema: {
      type: 'object',
      properties: {
        showInactive: { type: 'boolean', description: 'Include inactive stores (default false)' },
        marketplaceId: { type: 'number', description: 'Filter by marketplace ID' }
      }
    }
  },
  {
    name: 'v1_get_store',
    description: '[ShipStation v1 API] Get store detail by store ID',
    inputSchema: {
      type: 'object',
      properties: {
        storeId: { type: 'number', description: 'The store ID' }
      },
      required: ['storeId']
    }
  },
  {
    name: 'v1_update_store',
    description: '[ShipStation v1 API] Update store configuration',
    inputSchema: {
      type: 'object',
      properties: {
        storeId: { type: 'number', description: 'The store ID to update' },
        storeName: { type: 'string', description: 'Store name' },
        marketplaceId: { type: 'number', description: 'Marketplace ID' },
        marketplaceName: { type: 'string', description: 'Marketplace name' },
        accountName: { type: 'string', description: 'Account name' },
        email: { type: 'string', description: 'Email address' },
        integrationUrl: { type: 'string', description: 'Integration URL' },
        active: { type: 'boolean', description: 'Active status' },
        companyName: { type: 'string', description: 'Company name' },
        phone: { type: 'string', description: 'Phone number' },
        publicEmail: { type: 'string', description: 'Public email' },
        website: { type: 'string', description: 'Website URL' },
        refreshDate: { type: 'string', description: 'Refresh date' },
        createDate: { type: 'string', description: 'Create date' },
        modifyDate: { type: 'string', description: 'Modify date' },
        autoRefresh: { type: 'boolean', description: 'Auto refresh enabled' },
        statusMappings: { type: 'array', description: 'Status mappings array' }
      },
      required: ['storeId']
    }
  },
  {
    name: 'v1_deactivate_store',
    description: '[ShipStation v1 API] Deactivate a connected store',
    inputSchema: {
      type: 'object',
      properties: {
        storeId: { type: 'number', description: 'The store ID to deactivate' }
      },
      required: ['storeId']
    }
  },
  {
    name: 'v1_reactivate_store',
    description: '[ShipStation v1 API] Reactivate a previously deactivated store',
    inputSchema: {
      type: 'object',
      properties: {
        storeId: { type: 'number', description: 'The store ID to reactivate' }
      },
      required: ['storeId']
    }
  },
  {
    name: 'v1_list_marketplaces',
    description: '[ShipStation v1 API] List all available marketplace integrations',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  // ── Fulfillments (v1-exclusive) ────────────────────────────────────────────
  {
    name: 'v1_list_fulfillments',
    description: '[ShipStation v1 API] Search fulfillments by order ID, order number, tracking number, recipient name, date ranges',
    inputSchema: {
      type: 'object',
      properties: {
        fulfillmentId: { type: 'number', description: 'Filter by fulfillment ID' },
        orderId: { type: 'number', description: 'Filter by order ID' },
        orderNumber: { type: 'string', description: 'Filter by order number' },
        trackingNumber: { type: 'string', description: 'Filter by tracking number' },
        recipientName: { type: 'string', description: 'Filter by recipient name' },
        createDateStart: { type: 'string', description: 'Filter by create date start (YYYY-MM-DD HH:MM:SS)' },
        createDateEnd: { type: 'string', description: 'Filter by create date end (YYYY-MM-DD HH:MM:SS)' },
        shipDateStart: { type: 'string', description: 'Filter by ship date start (YYYY-MM-DD HH:MM:SS)' },
        shipDateEnd: { type: 'string', description: 'Filter by ship date end (YYYY-MM-DD HH:MM:SS)' },
        sortBy: { type: 'string', description: 'Sort by field (ShipDate, CreateDate)', enum: ['ShipDate', 'CreateDate'] },
        sortDir: { type: 'string', description: 'Sort direction', enum: ['ASC', 'DESC'] },
        page: { type: 'number', description: 'Page number (default 1)' },
        pageSize: { type: 'number', description: 'Items per page (max 500, default 100)' }
      }
    }
  },
  // ── Products (enhanced search via v1) ──────────────────────────────────────
  {
    name: 'v1_list_products',
    description: '[ShipStation v1 API] Search products by SKU, name, UPC, category, type, tag, date range, active status',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Filter by SKU (contains match)' },
        name: { type: 'string', description: 'Filter by product name (contains match)' },
        productCategoryId: { type: 'number', description: 'Filter by product category ID' },
        productTypeId: { type: 'number', description: 'Filter by product type ID' },
        tagId: { type: 'number', description: 'Filter by tag ID' },
        startDate: { type: 'string', description: 'Filter by start date (YYYY-MM-DD HH:MM:SS)' },
        endDate: { type: 'string', description: 'Filter by end date (YYYY-MM-DD HH:MM:SS)' },
        showInactive: { type: 'boolean', description: 'Include inactive products (default false)' },
        sortBy: { type: 'string', description: 'Sort by field (SKU, ModifyDate, CreateDate)', enum: ['SKU', 'ModifyDate', 'CreateDate'] },
        sortDir: { type: 'string', description: 'Sort direction', enum: ['ASC', 'DESC'] },
        page: { type: 'number', description: 'Page number (default 1)' },
        pageSize: { type: 'number', description: 'Items per page (max 500, default 100)' }
      }
    }
  },
  {
    name: 'v1_get_product',
    description: '[ShipStation v1 API] Get product detail by product ID',
    inputSchema: {
      type: 'object',
      properties: {
        productId: { type: 'number', description: 'The product ID' }
      },
      required: ['productId']
    }
  },
  {
    name: 'v1_update_product',
    description: '[ShipStation v1 API] Update product details (aliases, defaults, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        productId: { type: 'number', description: 'The product ID to update' },
        aliases: { type: 'array', description: 'Product aliases' },
        productName: { type: 'string', description: 'Product name' },
        sku: { type: 'string', description: 'Product SKU' },
        price: { type: 'number', description: 'Product price' },
        defaultCost: { type: 'number', description: 'Default cost' },
        length: { type: 'number', description: 'Product length' },
        width: { type: 'number', description: 'Product width' },
        height: { type: 'number', description: 'Product height' },
        weightOz: { type: 'number', description: 'Product weight in ounces' },
        internalNotes: { type: 'string', description: 'Internal notes' },
        fulfillmentSku: { type: 'string', description: 'Fulfillment SKU' },
        active: { type: 'boolean', description: 'Active status' },
        productCategory: { type: 'object', description: 'Product category object' },
        productType: { type: 'object', description: 'Product type object' },
        tags: { type: 'array', description: 'Product tags array' },
        customsDescription: { type: 'string', description: 'Customs description' },
        customsValue: { type: 'number', description: 'Customs value' },
        customsTariffNo: { type: 'string', description: 'Customs tariff number' },
        customsCountryCode: { type: 'string', description: 'Customs country code' },
        noCustoms: { type: 'boolean', description: 'No customs required' }
      },
      required: ['productId']
    }
  },
  // ── Shipments (enhanced filters via v1) ────────────────────────────────────
  {
    name: 'v1_list_shipments',
    description: '[ShipStation v1 API] Search shipments by recipient name, order number, tracking number, carrier, service, date ranges, store ID',
    inputSchema: {
      type: 'object',
      properties: {
        recipientName: { type: 'string', description: 'Filter by recipient name' },
        recipientCountryCode: { type: 'string', description: 'Filter by recipient country code' },
        orderNumber: { type: 'string', description: 'Filter by order number' },
        orderId: { type: 'number', description: 'Filter by order ID' },
        carrierCode: { type: 'string', description: 'Filter by carrier code' },
        serviceCode: { type: 'string', description: 'Filter by service code' },
        trackingNumber: { type: 'string', description: 'Filter by tracking number' },
        createDateStart: { type: 'string', description: 'Filter by create date start (YYYY-MM-DD HH:MM:SS)' },
        createDateEnd: { type: 'string', description: 'Filter by create date end (YYYY-MM-DD HH:MM:SS)' },
        shipDateStart: { type: 'string', description: 'Filter by ship date start (YYYY-MM-DD HH:MM:SS)' },
        shipDateEnd: { type: 'string', description: 'Filter by ship date end (YYYY-MM-DD HH:MM:SS)' },
        voidDateStart: { type: 'string', description: 'Filter by void date start (YYYY-MM-DD HH:MM:SS)' },
        voidDateEnd: { type: 'string', description: 'Filter by void date end (YYYY-MM-DD HH:MM:SS)' },
        storeId: { type: 'number', description: 'Filter by store ID' },
        includeShipmentItems: { type: 'boolean', description: 'Include shipment items in response' },
        sortBy: { type: 'string', description: 'Sort by field (ShipDate, CreateDate)', enum: ['ShipDate', 'CreateDate'] },
        sortDir: { type: 'string', description: 'Sort direction', enum: ['ASC', 'DESC'] },
        page: { type: 'number', description: 'Page number (default 1)' },
        pageSize: { type: 'number', description: 'Items per page (max 500, default 100)' }
      }
    }
  },
  {
    name: 'v1_get_rates',
    description: '[ShipStation v1 API] Get shipping rates for a carrier with origin/destination postal codes and weight',
    inputSchema: {
      type: 'object',
      properties: {
        carrierCode: { type: 'string', description: 'Carrier code (required)' },
        serviceCode: { type: 'string', description: 'Service code (optional, omit for all services)' },
        packageCode: { type: 'string', description: 'Package code (optional)' },
        fromPostalCode: { type: 'string', description: 'Origin postal code (required)' },
        toState: { type: 'string', description: 'Destination state' },
        toCountry: { type: 'string', description: 'Destination country code (required)' },
        toPostalCode: { type: 'string', description: 'Destination postal code (required)' },
        toCity: { type: 'string', description: 'Destination city' },
        weight: {
          type: 'object',
          description: 'Package weight (required)',
          properties: {
            value: { type: 'number', description: 'Weight value' },
            units: { type: 'string', description: 'Weight units (ounces, pounds)', enum: ['ounces', 'pounds'] }
          }
        },
        dimensions: {
          type: 'object',
          description: 'Package dimensions (optional)',
          properties: {
            units: { type: 'string', description: 'Dimension units (inches, centimeters)', enum: ['inches', 'centimeters'] },
            length: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' }
          }
        },
        confirmation: { type: 'string', description: 'Delivery confirmation (none, delivery, signature, adult_signature, direct_signature)' },
        residential: { type: 'boolean', description: 'Is residential address' }
      },
      required: ['carrierCode', 'fromPostalCode', 'toCountry', 'toPostalCode', 'weight']
    }
  },
  {
    name: 'v1_create_label',
    description: '[ShipStation v1 API] Create a shipping label',
    inputSchema: {
      type: 'object',
      properties: {
        carrierCode: { type: 'string', description: 'Carrier code (required)' },
        serviceCode: { type: 'string', description: 'Service code (required)' },
        packageCode: { type: 'string', description: 'Package code (required)' },
        confirmation: { type: 'string', description: 'Delivery confirmation (none, delivery, signature, adult_signature, direct_signature)' },
        shipDate: { type: 'string', description: 'Ship date (YYYY-MM-DD) (required)' },
        weight: {
          type: 'object',
          description: 'Package weight (required)',
          properties: {
            value: { type: 'number' },
            units: { type: 'string', enum: ['ounces', 'pounds'] }
          }
        },
        dimensions: {
          type: 'object',
          description: 'Package dimensions',
          properties: {
            units: { type: 'string', enum: ['inches', 'centimeters'] },
            length: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' }
          }
        },
        shipFrom: {
          type: 'object',
          description: 'Ship from address (required)',
          properties: {
            name: { type: 'string' },
            company: { type: 'string' },
            street1: { type: 'string' },
            street2: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            postalCode: { type: 'string' },
            country: { type: 'string' },
            phone: { type: 'string' }
          }
        },
        shipTo: {
          type: 'object',
          description: 'Ship to address (required)',
          properties: {
            name: { type: 'string' },
            company: { type: 'string' },
            street1: { type: 'string' },
            street2: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            postalCode: { type: 'string' },
            country: { type: 'string' },
            phone: { type: 'string' }
          }
        },
        insuranceOptions: { type: 'object', description: 'Insurance options' },
        internationalOptions: { type: 'object', description: 'International/customs options' },
        advancedOptions: { type: 'object', description: 'Advanced options' },
        testLabel: { type: 'boolean', description: 'Create a test label (default false)' }
      },
      required: ['carrierCode', 'serviceCode', 'packageCode', 'shipDate', 'weight', 'shipFrom', 'shipTo']
    }
  },
  {
    name: 'v1_void_label',
    description: '[ShipStation v1 API] Void a shipping label by shipment ID',
    inputSchema: {
      type: 'object',
      properties: {
        shipmentId: { type: 'number', description: 'The shipment ID of the label to void' }
      },
      required: ['shipmentId']
    }
  },
  // ── Carriers ───────────────────────────────────────────────────────────────
  {
    name: 'v1_list_carriers',
    description: '[ShipStation v1 API] List all connected carrier accounts',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'v1_list_carrier_services',
    description: '[ShipStation v1 API] List available services for a carrier code',
    inputSchema: {
      type: 'object',
      properties: {
        carrierCode: { type: 'string', description: 'The carrier code (e.g., stamps_com, ups, fedex)' }
      },
      required: ['carrierCode']
    }
  },
  {
    name: 'v1_list_carrier_packages',
    description: '[ShipStation v1 API] List available package types for a carrier code',
    inputSchema: {
      type: 'object',
      properties: {
        carrierCode: { type: 'string', description: 'The carrier code (e.g., stamps_com, ups, fedex)' }
      },
      required: ['carrierCode']
    }
  },
  // ── Warehouses ─────────────────────────────────────────────────────────────
  {
    name: 'v1_list_warehouses',
    description: '[ShipStation v1 API] List all warehouses (ship-from locations)',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'v1_get_warehouse',
    description: '[ShipStation v1 API] Get warehouse detail by ID',
    inputSchema: {
      type: 'object',
      properties: {
        warehouseId: { type: 'number', description: 'The warehouse ID' }
      },
      required: ['warehouseId']
    }
  },
  {
    name: 'v1_create_warehouse',
    description: '[ShipStation v1 API] Create a new warehouse/ship-from location',
    inputSchema: {
      type: 'object',
      properties: {
        warehouseName: { type: 'string', description: 'Warehouse name (required)' },
        originAddress: {
          type: 'object',
          description: 'Origin address for the warehouse (required)',
          properties: {
            name: { type: 'string' },
            company: { type: 'string' },
            street1: { type: 'string' },
            street2: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            postalCode: { type: 'string' },
            country: { type: 'string' },
            phone: { type: 'string' }
          }
        },
        returnAddress: {
          type: 'object',
          description: 'Return address for the warehouse (optional, defaults to origin address)',
          properties: {
            name: { type: 'string' },
            company: { type: 'string' },
            street1: { type: 'string' },
            street2: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            postalCode: { type: 'string' },
            country: { type: 'string' },
            phone: { type: 'string' }
          }
        },
        isDefault: { type: 'boolean', description: 'Set as default warehouse' }
      },
      required: ['warehouseName', 'originAddress']
    }
  },
  {
    name: 'v1_update_warehouse',
    description: '[ShipStation v1 API] Update warehouse details',
    inputSchema: {
      type: 'object',
      properties: {
        warehouseId: { type: 'number', description: 'The warehouse ID to update (required)' },
        warehouseName: { type: 'string', description: 'Warehouse name' },
        originAddress: { type: 'object', description: 'Origin address object' },
        returnAddress: { type: 'object', description: 'Return address object' },
        isDefault: { type: 'boolean', description: 'Set as default warehouse' }
      },
      required: ['warehouseId']
    }
  },
  {
    name: 'v1_delete_warehouse',
    description: '[ShipStation v1 API] Delete a warehouse',
    inputSchema: {
      type: 'object',
      properties: {
        warehouseId: { type: 'number', description: 'The warehouse ID to delete' }
      },
      required: ['warehouseId']
    }
  },
  // ── Webhooks ───────────────────────────────────────────────────────────────
  {
    name: 'v1_list_webhooks',
    description: '[ShipStation v1 API] List all registered webhooks',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'v1_subscribe_webhook',
    description: '[ShipStation v1 API] Subscribe to a webhook event',
    inputSchema: {
      type: 'object',
      properties: {
        target_url: { type: 'string', description: 'The URL to receive webhook events (required)' },
        event: { type: 'string', description: 'The event to subscribe to (required). Values: ORDER_NOTIFY, ITEM_ORDER_NOTIFY, SHIP_NOTIFY, ITEM_SHIP_NOTIFY' },
        store_id: { type: 'number', description: 'Store ID to filter events (optional)' },
        friendly_name: { type: 'string', description: 'Friendly name for the webhook (optional)' }
      },
      required: ['target_url', 'event']
    }
  },
  {
    name: 'v1_unsubscribe_webhook',
    description: '[ShipStation v1 API] Unsubscribe from a webhook',
    inputSchema: {
      type: 'object',
      properties: {
        webhookId: { type: 'number', description: 'The webhook ID to unsubscribe' }
      },
      required: ['webhookId']
    }
  },
  // ── Tags ───────────────────────────────────────────────────────────────────
  {
    name: 'v1_list_tags',
    description: '[ShipStation v1 API] List all account tags',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

// ─── MCP Server Class ──────────────────────────────────────────────────────────

class ShipStationMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'shipstation-api-server',
        version: '1.0.0',
        description: 'MCP server for interacting with ShipStation API v2' + (shipstationV1 ? ' and v1' : '')
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.setupHandlers();
  }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, wrapWithActivityBump(async () => {
      const tools = [...v2Tools];
      if (shipstationV1) {
        tools.push(...v1Tools);
      }
      return { tools };
    }));

    this.server.setRequestHandler(CallToolRequestSchema, wrapWithActivityBump(async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let result;

        switch (name) {
          // ── v2 Tool Handlers ─────────────────────────────────────────────
          case 'get_shipments':
            result = await shipstation.getShipments(args || {});
            break;

          case 'create_shipment': {
            const shipmentRequest = {
              shipments: [args.shipment]
            };
            result = await shipstation.createShipment(shipmentRequest);
            break;
          }

          case 'create_shipments_bulk': {
            const bulkRequest = {
              shipments: args.shipments
            };
            result = await shipstation.createShipment(bulkRequest);
            break;
          }

          case 'get_shipment_by_id':
            result = await shipstation.getShipmentById(args.shipment_id);
            break;

          case 'cancel_shipment':
            result = await shipstation.cancelShipment(args.shipment_id);
            break;

          case 'get_shipment_by_external_id':
            result = await shipstation.getShipmentByExternalId(args.external_shipment_id);
            break;

          case 'get_shipment_rates':
            result = await shipstation.getShipmentRates(args.shipment_id);
            break;

          case 'tag_shipment':
            result = await shipstation.tagShipment(args.shipment_id, args.tag_name);
            break;

          case 'untag_shipment':
            result = await shipstation.untagShipment(args.shipment_id, args.tag_name);
            break;

          case 'update_shipment':
            result = await shipstation.updateShipment(args.shipment_id, args.shipment_data);
            break;

          case 'get_labels':
            result = await shipstation.getLabels(args || {});
            break;

          case 'create_label':
            result = await shipstation.createLabel(args);
            break;

          case 'get_label_by_id':
            result = await shipstation.getLabelById(args.label_id);
            break;

          case 'void_label':
            result = await shipstation.voidLabel(args.label_id);
            break;

          case 'track_package':
            result = await shipstation.trackLabel(args.label_id);
            break;

          case 'create_label_from_rate': {
            const rateData = {};
            if (args.label_format) rateData.label_format = args.label_format;
            if (args.label_layout) rateData.label_layout = args.label_layout;
            result = await shipstation.createLabelFromRate(args.rate_id, rateData);
            break;
          }

          case 'create_label_from_shipment': {
            const shipmentData = {};
            if (args.label_format) shipmentData.label_format = args.label_format;
            if (args.label_layout) shipmentData.label_layout = args.label_layout;
            result = await shipstation.createLabelFromShipment(args.shipment_id, shipmentData);
            break;
          }

          case 'create_return_label': {
            const returnData = {};
            if (args.label_format) returnData.label_format = args.label_format;
            if (args.label_layout) returnData.label_layout = args.label_layout;
            result = await shipstation.createReturnLabel(args.label_id, returnData);
            break;
          }

          case 'calculate_rates': {
            const rateRequest = {
              rate_options: args.rate_options || {},
              shipment: args.shipment
            };
            result = await shipstation.calculateRates(rateRequest);
            break;
          }

          case 'estimate_rates': {
            const estimateRequest = {
              rate_options: args.rate_options || {},
              shipment: args.shipment
            };
            result = await shipstation.estimateRates(estimateRequest);
            break;
          }

          case 'get_rate_by_id':
            result = await shipstation.getRateById(args.rate_id);
            break;

          case 'get_carriers':
            result = await shipstation.getCarriers(args || {});
            break;

          case 'get_carrier_services':
            result = await shipstation.getCarrierServices(args.carrier_id);
            break;

          case 'get_carrier_by_id':
            result = await shipstation.getCarrierById(args.carrier_id);
            break;

          case 'get_carrier_options':
            result = await shipstation.getCarrierOptions(args.carrier_id);
            break;

          case 'get_carrier_package_types':
            result = await shipstation.getCarrierPackageTypes(args.carrier_id);
            break;

          case 'get_warehouses':
            result = await shipstation.getWarehouses(args || {});
            break;

          case 'get_warehouse_by_id':
            result = await shipstation.getWarehouseById(args.warehouse_id);
            break;

          case 'get_inventory':
            result = await shipstation.getInventoryLevels(args || {});
            break;

          case 'update_inventory':
            result = await shipstation.updateInventory(args);
            break;

          case 'get_inventory_warehouses':
            result = await shipstation.getInventoryWarehouses(args || {});
            break;

          case 'create_inventory_warehouse':
            result = await shipstation.createInventoryWarehouse(args);
            break;

          case 'get_inventory_locations':
            result = await shipstation.getInventoryLocations(args || {});
            break;

          case 'create_inventory_location':
            result = await shipstation.createInventoryLocation(args);
            break;

          case 'get_inventory_warehouse_by_id':
            result = await shipstation.getInventoryWarehouseById(args.warehouse_id);
            break;

          case 'update_inventory_warehouse':
            result = await shipstation.updateInventoryWarehouse(args.warehouse_id, args.warehouse_data);
            break;

          case 'delete_inventory_warehouse':
            result = await shipstation.deleteInventoryWarehouse(args.warehouse_id);
            break;

          case 'get_inventory_location_by_id':
            result = await shipstation.getInventoryLocationById(args.location_id);
            break;

          case 'update_inventory_location':
            result = await shipstation.updateInventoryLocation(args.location_id, args.location_data);
            break;

          case 'delete_inventory_location':
            result = await shipstation.deleteInventoryLocation(args.location_id);
            break;

          // Batch operations
          case 'get_batches':
            result = await shipstation.getBatches(args || {});
            break;

          case 'create_batch':
            result = await shipstation.createBatch(args);
            break;

          case 'get_batch_by_id':
            result = await shipstation.getBatchById(args.batch_id);
            break;

          case 'get_batch_by_external_id':
            result = await shipstation.getBatchByExternalId(args.external_batch_id);
            break;

          case 'update_batch':
            result = await shipstation.updateBatch(args.batch_id, args.batch_data);
            break;

          case 'delete_batch':
            result = await shipstation.deleteBatch(args.batch_id);
            break;

          case 'add_to_batch': {
            const addData = {};
            if (args.shipment_ids) addData.shipment_ids = args.shipment_ids;
            if (args.rate_ids) addData.rate_ids = args.rate_ids;
            result = await shipstation.addToBatch(args.batch_id, addData);
            break;
          }

          case 'remove_from_batch': {
            const removeData = {};
            if (args.shipment_ids) removeData.shipment_ids = args.shipment_ids;
            if (args.rate_ids) removeData.rate_ids = args.rate_ids;
            result = await shipstation.removeFromBatch(args.batch_id, removeData);
            break;
          }

          case 'get_batch_errors':
            result = await shipstation.getBatchErrors(args.batch_id);
            break;

          case 'process_batch': {
            const processData = {};
            if (args.label_format) processData.label_format = args.label_format;
            if (args.label_layout) processData.label_layout = args.label_layout;
            result = await shipstation.processBatch(args.batch_id, processData);
            break;
          }

          // Manifest operations
          case 'get_manifests':
            result = await shipstation.getManifests(args || {});
            break;

          case 'create_manifest':
            result = await shipstation.createManifest(args);
            break;

          case 'get_manifest_by_id':
            result = await shipstation.getManifestById(args.manifest_id);
            break;

          // ── v1 Tool Handlers ─────────────────────────────────────────────

          // v1 Orders
          case 'v1_list_orders':
            result = await shipstationV1.listOrders(args || {});
            break;

          case 'v1_get_order':
            result = await shipstationV1.getOrder(args.orderId);
            break;

          case 'v1_create_order':
            result = await shipstationV1.createOrder(args);
            break;

          case 'v1_create_orders':
            result = await shipstationV1.createMultipleOrders(args.orders);
            break;

          case 'v1_delete_order':
            result = await shipstationV1.deleteOrder(args.orderId);
            break;

          case 'v1_hold_order':
            result = await shipstationV1.holdOrder(args);
            break;

          case 'v1_restore_order':
            result = await shipstationV1.restoreOrder(args);
            break;

          case 'v1_mark_order_shipped':
            result = await shipstationV1.markOrderShipped(args);
            break;

          case 'v1_add_order_tag':
            result = await shipstationV1.addOrderTag(args);
            break;

          case 'v1_remove_order_tag':
            result = await shipstationV1.removeOrderTag(args);
            break;

          case 'v1_assign_order_user':
            result = await shipstationV1.assignOrderUser(args);
            break;

          case 'v1_create_order_label':
            result = await shipstationV1.createOrderLabel(args);
            break;

          // v1 Customers
          case 'v1_list_customers':
            result = await shipstationV1.listCustomers(args || {});
            break;

          case 'v1_get_customer':
            result = await shipstationV1.getCustomer(args.customerId);
            break;

          // v1 Stores
          case 'v1_list_stores':
            result = await shipstationV1.listStores(args || {});
            break;

          case 'v1_get_store':
            result = await shipstationV1.getStore(args.storeId);
            break;

          case 'v1_update_store': {
            const { storeId, ...storeData } = args;
            result = await shipstationV1.updateStore(storeId, storeData);
            break;
          }

          case 'v1_deactivate_store':
            result = await shipstationV1.deactivateStore(args);
            break;

          case 'v1_reactivate_store':
            result = await shipstationV1.reactivateStore(args);
            break;

          case 'v1_list_marketplaces':
            result = await shipstationV1.listMarketplaces();
            break;

          // v1 Fulfillments
          case 'v1_list_fulfillments':
            result = await shipstationV1.listFulfillments(args || {});
            break;

          // v1 Products
          case 'v1_list_products':
            result = await shipstationV1.listProducts(args || {});
            break;

          case 'v1_get_product':
            result = await shipstationV1.getProduct(args.productId);
            break;

          case 'v1_update_product': {
            const { productId, ...productData } = args;
            result = await shipstationV1.updateProduct(productId, productData);
            break;
          }

          // v1 Shipments
          case 'v1_list_shipments':
            result = await shipstationV1.listShipments(args || {});
            break;

          case 'v1_get_rates':
            result = await shipstationV1.getRates(args);
            break;

          case 'v1_create_label':
            result = await shipstationV1.createLabel(args);
            break;

          case 'v1_void_label':
            result = await shipstationV1.voidLabel(args);
            break;

          // v1 Carriers
          case 'v1_list_carriers':
            result = await shipstationV1.listCarriers();
            break;

          case 'v1_list_carrier_services':
            result = await shipstationV1.listCarrierServices(args);
            break;

          case 'v1_list_carrier_packages':
            result = await shipstationV1.listCarrierPackages(args);
            break;

          // v1 Warehouses
          case 'v1_list_warehouses':
            result = await shipstationV1.listWarehouses();
            break;

          case 'v1_get_warehouse':
            result = await shipstationV1.getWarehouse(args.warehouseId);
            break;

          case 'v1_create_warehouse':
            result = await shipstationV1.createWarehouse(args);
            break;

          case 'v1_update_warehouse': {
            const { warehouseId, ...warehouseData } = args;
            result = await shipstationV1.updateWarehouse(warehouseId, warehouseData);
            break;
          }

          case 'v1_delete_warehouse':
            result = await shipstationV1.deleteWarehouse(args.warehouseId);
            break;

          // v1 Webhooks
          case 'v1_list_webhooks':
            result = await shipstationV1.listWebhooks();
            break;

          case 'v1_subscribe_webhook':
            result = await shipstationV1.subscribeWebhook(args);
            break;

          case 'v1_unsubscribe_webhook':
            result = await shipstationV1.unsubscribeWebhook(args.webhookId);
            break;

          // v1 Tags
          case 'v1_list_tags':
            result = await shipstationV1.listTags();
            break;

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`
            }
          ],
          isError: true
        };
      }
    }));
  }

  async run() {
    startLifecycleWatchdog();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('ShipStation MCP server running on stdio');
  }
}

const server = new ShipStationMCPServer();
server.run().catch(console.error);
