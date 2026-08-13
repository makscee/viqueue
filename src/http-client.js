export class HttpApplicationClient {
  constructor({ server = process.env.VIQ_URL ?? 'http://127.0.0.1:7373', operatorToken } = {}) {
    this.server = server.replace(/\/$/, '');
    this.operatorToken = operatorToken;
  }

  async request(method, route, body, { takeover = false } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (takeover && this.operatorToken) headers.authorization = `Bearer ${this.operatorToken}`;
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
