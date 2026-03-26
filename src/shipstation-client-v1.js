import axios from 'axios';

class ShipStationClientV1 {
  constructor(apiKey, apiSecret, customUrl = null) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseURL = customUrl || 'https://ssapi.shipstation.com';

    // Rate limit tracking
    this.rateLimitRemaining = null;
    this.rateLimitReset = null;

    const credentials = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64');

    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    // Response interceptor: track rate limits and handle errors
    this.client.interceptors.response.use(
      (response) => {
        this._updateRateLimits(response);
        return response;
      },
      async (error) => {
        if (error.response) {
          this._updateRateLimits(error.response);

          // Auto-retry on 429
          if (error.response.status === 429) {
            const waitMs = this._getRetryDelay();
            console.warn(`ShipStation v1 rate limit hit. Waiting ${waitMs}ms before retry...`);
            await this._sleep(waitMs);
            return this.client.request(error.config);
          }

          const { status, data } = error.response;
          console.error('ShipStation v1 API Error Details:', {
            status,
            data,
            url: error.config?.url,
            method: error.config?.method,
            requestData: error.config?.data
          });
          throw new Error(`ShipStation v1 API Error ${status}: ${JSON.stringify(data)}`);
        }
        throw error;
      }
    );
  }

  _updateRateLimits(response) {
    const remaining = response.headers['x-rate-limit-remaining'];
    const reset = response.headers['x-rate-limit-reset'];
    if (remaining !== undefined) {
      this.rateLimitRemaining = parseInt(remaining, 10);
    }
    if (reset !== undefined) {
      this.rateLimitReset = parseInt(reset, 10);
    }
  }

  _getRetryDelay() {
    // X-Rate-Limit-Reset is seconds until the rate limit window resets
    if (this.rateLimitReset && this.rateLimitReset > 0) {
      return (this.rateLimitReset * 1000) + 500; // add 500ms buffer
    }
    return 60000; // default: wait 60 seconds
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getRateLimitStatus() {
    return {
      remaining: this.rateLimitRemaining,
      resetSeconds: this.rateLimitReset
    };
  }

  // ─── Orders ──────────────────────────────────────────────────────────

  async listOrders(params = {}) {
    const response = await this.client.get('/orders', { params });
    return response.data;
  }

  async getOrder(orderId) {
    const response = await this.client.get(`/orders/${orderId}`);
    return response.data;
  }

  async createOrder(orderData) {
    const response = await this.client.post('/orders/createorder', orderData);
    return response.data;
  }

  async createMultipleOrders(ordersData) {
    const response = await this.client.post('/orders/createorders', ordersData);
    return response.data;
  }

  async deleteOrder(orderId) {
    const response = await this.client.delete(`/orders/${orderId}`);
    return response.data;
  }

  async holdOrder(holdData) {
    const response = await this.client.post('/orders/holduntil', holdData);
    return response.data;
  }

  async restoreOrder(restoreData) {
    const response = await this.client.post('/orders/restorefromhold', restoreData);
    return response.data;
  }

  async markOrderShipped(shipData) {
    const response = await this.client.post('/orders/markasshipped', shipData);
    return response.data;
  }

  async addOrderTag(tagData) {
    const response = await this.client.post('/orders/addtag', tagData);
    return response.data;
  }

  async removeOrderTag(tagData) {
    const response = await this.client.post('/orders/removetag', tagData);
    return response.data;
  }

  async assignOrderUser(assignData) {
    const response = await this.client.post('/orders/assignuser', assignData);
    return response.data;
  }

  async createOrderLabel(labelData) {
    const response = await this.client.post('/orders/createlabelfororder', labelData);
    return response.data;
  }

  // ─── Customers ───────────────────────────────────────────────────────

  async listCustomers(params = {}) {
    const response = await this.client.get('/customers', { params });
    return response.data;
  }

  async getCustomer(customerId) {
    const response = await this.client.get(`/customers/${customerId}`);
    return response.data;
  }

  // ─── Stores ──────────────────────────────────────────────────────────

  async listStores(params = {}) {
    const response = await this.client.get('/stores', { params });
    return response.data;
  }

  async getStore(storeId) {
    const response = await this.client.get(`/stores/${storeId}`);
    return response.data;
  }

  async updateStore(storeId, storeData) {
    const response = await this.client.put(`/stores/${storeId}`, storeData);
    return response.data;
  }

  async deactivateStore(storeData) {
    const response = await this.client.post('/stores/deactivate', storeData);
    return response.data;
  }

  async reactivateStore(storeData) {
    const response = await this.client.post('/stores/reactivate', storeData);
    return response.data;
  }

  async listMarketplaces() {
    const response = await this.client.get('/stores/marketplaces');
    return response.data;
  }

  // ─── Fulfillments ────────────────────────────────────────────────────

  async listFulfillments(params = {}) {
    const response = await this.client.get('/fulfillments', { params });
    return response.data;
  }

  // ─── Products ────────────────────────────────────────────────────────

  async listProducts(params = {}) {
    const response = await this.client.get('/products', { params });
    return response.data;
  }

  async getProduct(productId) {
    const response = await this.client.get(`/products/${productId}`);
    return response.data;
  }

  async updateProduct(productId, productData) {
    const response = await this.client.put(`/products/${productId}`, productData);
    return response.data;
  }

  // ─── Shipments ───────────────────────────────────────────────────────

  async listShipments(params = {}) {
    const response = await this.client.get('/shipments', { params });
    return response.data;
  }

  async getRates(rateData) {
    const response = await this.client.post('/shipments/getrates', rateData);
    return response.data;
  }

  async createLabel(labelData) {
    const response = await this.client.post('/shipments/createlabel', labelData);
    return response.data;
  }

  async voidLabel(voidData) {
    const response = await this.client.post('/shipments/voidlabel', voidData);
    return response.data;
  }

  // ─── Carriers ────────────────────────────────────────────────────────

  async listCarriers() {
    const response = await this.client.get('/carriers');
    return response.data;
  }

  async listCarrierServices(params = {}) {
    const response = await this.client.get('/carriers/listservices', { params });
    return response.data;
  }

  async listCarrierPackages(params = {}) {
    const response = await this.client.get('/carriers/listpackages', { params });
    return response.data;
  }

  // ─── Warehouses ──────────────────────────────────────────────────────

  async listWarehouses() {
    const response = await this.client.get('/warehouses');
    return response.data;
  }

  async getWarehouse(warehouseId) {
    const response = await this.client.get(`/warehouses/${warehouseId}`);
    return response.data;
  }

  async createWarehouse(warehouseData) {
    const response = await this.client.post('/warehouses/createwarehouse', warehouseData);
    return response.data;
  }

  async updateWarehouse(warehouseId, warehouseData) {
    const response = await this.client.put(`/warehouses/${warehouseId}`, warehouseData);
    return response.data;
  }

  async deleteWarehouse(warehouseId) {
    const response = await this.client.delete(`/warehouses/${warehouseId}`);
    return response.data;
  }

  // ─── Webhooks ────────────────────────────────────────────────────────

  async listWebhooks() {
    const response = await this.client.get('/webhooks');
    return response.data;
  }

  async subscribeWebhook(webhookData) {
    const response = await this.client.post('/webhooks/subscribe', webhookData);
    return response.data;
  }

  async unsubscribeWebhook(webhookId) {
    const response = await this.client.delete(`/webhooks/${webhookId}`);
    return response.data;
  }

  // ─── Tags ────────────────────────────────────────────────────────────

  async listTags() {
    const response = await this.client.get('/accounts/listtags');
    return response.data;
  }
}

export default ShipStationClientV1;
