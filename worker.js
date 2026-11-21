import { onRequestGet as getConfig } from './functions/api/config.js';
import { onRequestPost as postCare } from './functions/api/care.js';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/config') {
      if (request.method === 'GET') return getConfig({ request, env });
      return new Response(null, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
    }
    if (path === '/api/care') {
      if (request.method === 'POST') return postCare({ request, env });
      return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
    }
    if (path.startsWith('/api/')) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return env.ASSETS.fetch(request);
  }
};
