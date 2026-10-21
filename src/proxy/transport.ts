import * as http from 'http';

export interface HttpReply { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

/**
 * Shared transport for relay requests and web tools.
 * The extension host's global fetch follows the same host-proxy route as the
 * plugin's Network/Models checks. A separate Node http client can bypass it.
 */
export function requestHttp(url: string, method: string, headers: Record<string, string>, body: Buffer | undefined, signal: AbortSignal): Promise<HttpReply> {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) return Promise.reject(new Error('Only HTTP and HTTPS URLs are supported'));
  // HTTP-only local/container relays (such as the current clawcode endpoint)
  // do not need the host HTTPS proxy and are kept on the old byte-for-byte
  // Node transport. This also avoids gateways that reject fetch's streaming
  // framing for large HTTP bodies. HTTPS relays use extension-host fetch below
  // so they follow the VS Code Server host-proxy route.
  if (target.protocol === 'http:') return requestNodeHttp(target, method, headers, body, signal);
  const requestHeaders = { ...headers };
  // The previous Node http client emitted a fixed Content-Length. Some relay
  // gateways reject a chunked request body even though the JSON is valid.
  // Preserve the old wire shape when using fetch.
  if (body && !Object.keys(requestHeaders).some(key => key.toLowerCase() === 'content-length')) {
    requestHeaders['content-length'] = String(body.byteLength);
  }
  return fetch(target, {
    method,
    headers: requestHeaders,
    body: body ? new Uint8Array(body) : undefined,
    signal,
    redirect: 'manual'
  }).then(async response => {
    const responseHeaders: http.IncomingHttpHeaders = {};
    response.headers.forEach((value, name) => { responseHeaders[name.toLowerCase()] = value; });
    return { status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) };
  });
}

function requestNodeHttp(target: URL, method: string, headers: Record<string, string>, body: Buffer | undefined, signal: AbortSignal): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = http.request(target, { method, headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) }, signal }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function upstreamUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '') + path;
}
