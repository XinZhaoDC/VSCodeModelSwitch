// Licensed under PolyForm Noncommercial License 1.0.0; see THIRD_PARTY_NOTICES.md.
// Required Notice: Copyright (c) 2026 abdurrehmandaudi — justdowork-proxy — https://github.com/abdurrehmandaudi/justdowork-proxy
import { ProxyOptions } from '../types';
import { Json } from './protocol';
import { HttpReply, requestHttp } from './transport';

function htmlText(html: string): string {
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff))).replace(/\s+/g, ' ').trim();
}

async function getPage(url: string, signal: AbortSignal): Promise<{ reply: HttpReply; url: string }> {
  for (let redirects = 0; redirects < 6; redirects++) {
    const reply = await requestHttp(url, 'GET', { 'user-agent': 'Mozilla/5.0 VSCodeModelSwitch', accept: '*/*' }, undefined, signal);
    if ([301, 302, 303, 307, 308].includes(reply.status) && reply.headers.location) { url = new URL(reply.headers.location, url).href; continue; }
    if (reply.status >= 400) throw new Error(`Web fetch HTTP ${reply.status}`);
    return { reply, url };
  }
  throw new Error('Web fetch exceeded the redirect limit');
}

export async function executeWebTool(name: string, input: Json, options: ProxyOptions, signal: AbortSignal): Promise<Json[]> {
  try {
    if (name === 'WebSearch' || name === 'web_search') {
      const query = String(input.query ?? '').trim();
      if (!query) throw new Error('WebSearch requires a query');
      const { reply } = await getPage('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), signal);
      const html = reply.body.toString('utf8');
      const found = [...html.matchAll(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
      const results = found.slice(0, options.webSearchResults).map((m, i) => {
        const link = new URL(m[1].replace(/&amp;/g, '&'), 'https://duckduckgo.com');
        return `${i + 1}. ${htmlText(m[2])}\n${link.searchParams.get('uddg') ?? link.href}`;
      });
      return [{ type: 'text', text: results.length ? `Search results for ${query}:\n${results.join('\n\n')}` : 'WebSearch returned no results.' }];
    }
    const target = String(input.url ?? '').trim();
    if (!target) throw new Error(`${name} requires a URL`);
    const { reply, url } = await getPage(target, signal);
    const type = String(reply.headers['content-type'] ?? '').split(';')[0];
    if (name === 'fetch_image') {
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(type)) throw new Error('URL did not return a supported image');
      return [{ type: 'text', text: `Image from ${url}` }, { type: 'image', source: { type: 'base64', media_type: type, data: reply.body.toString('base64') } }];
    }
    let text = reply.body.toString('utf8');
    if (type.includes('html')) text = htmlText(text);
    if (options.webFetchMaxChars && text.length > options.webFetchMaxChars) text = text.slice(0, options.webFetchMaxChars) + '\n[WebFetch content truncated.]';
    return [{ type: 'text', text: `Content from ${url}:\n${text}` }];
  } catch (error) {
    if (signal.aborted) throw error;
    return [{ type: 'text', text: `[${name} failed: ${error instanceof Error ? error.message : 'unknown error'}]` }];
  }
}
