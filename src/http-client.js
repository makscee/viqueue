export class HttpApplicationClient {
  constructor({ server = process.env.VIQ_URL ?? 'http://127.0.0.1:17373', deviceToken = process.env.VIQ_DEVICE_TOKEN, sessionCapability = process.env.VIQ_SESSION_CAPABILITY } = {}) {
    this.server = server.replace(/\/$/, '');
    this.deviceToken = deviceToken;
    this.sessionCapability = sessionCapability;
  }

  async request(method, route, body) {
    const headers = { 'content-type': 'application/json' };
    if (this.deviceToken) headers.authorization = `Bearer ${this.deviceToken}`;
    if (this.sessionCapability) headers['x-viq-session-capability'] = this.sessionCapability;
    let response;
    try {
      response = await fetch(`${this.server}${route}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw { code: 'transport_error', message: error.message, http_status: null };
    }
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : { ticket: null }; }
    catch { throw { code: 'invalid_response', message: 'viqueue returned invalid JSON', http_status: response.status }; }
    if (!response.ok) {
      throw {
        code: payload.error?.code ?? 'http_error',
        message: payload.error?.message ?? `HTTP ${response.status}`,
        http_status: response.status
      };
    }
    return payload;
  }
}
