/**
 * Billy.sh Cloudflare Worker
 * Handles newsletter signups, promo code validation, and admin endpoints.
 *
 * Required CF secrets (set via wrangler secret put):
 *   ADMIN_SECRET - for /admin/* endpoints
 */

interface Env {
  ADMIN_SECRET: string;
  BILLY_KV: KVNamespace;
}

function getCorsHeaders(origin: string | null) {
  const allowed = [
    'https://jd4rider.github.io',
    'http://localhost:3000',
    'http://localhost:3001',
  ];
  const allowOrigin = (origin && allowed.includes(origin)) ? origin : allowed[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const corsHeaders = getCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', version: '0.1.0' }), {
        status: 200, headers: getCorsHeaders(null),
      });
    }

    // Newsletter subscribe
    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const body = await request.json() as { email?: string };
      const email = (body.email || '').trim().toLowerCase();
      if (!email || !email.includes('@') || !email.includes('.')) {
        return new Response(JSON.stringify({ ok: false, message: 'Please provide a valid email address.' }), {
          status: 400, headers: corsHeaders,
        });
      }
      await env.BILLY_KV.put(`subscriber:${email}`, JSON.stringify({
        email,
        subscribedAt: new Date().toISOString(),
      }));
      return new Response(JSON.stringify({ ok: true, message: "You're subscribed! We'll notify you when Billy ships new features." }), {
        status: 200, headers: corsHeaders,
      });
    }

    // Promo code validation
    if (url.pathname === '/validate-promo' && request.method === 'POST') {
      const { code } = await request.json() as { code: string };
      const storedDiscount = await env.BILLY_KV.get(`promo:${code.toUpperCase()}`);
      if (!storedDiscount) {
        return new Response(JSON.stringify({ valid: false, message: 'Invalid promo code' }), {
          status: 200, headers: corsHeaders,
        });
      }
      return new Response(JSON.stringify({ valid: true, discount: storedDiscount, message: `${storedDiscount}% off applied!` }), {
        status: 200, headers: corsHeaders,
      });
    }

    // Admin: create promo code
    if (url.pathname === '/admin/promo' && request.method === 'POST') {
      if (request.headers.get('X-Admin-Secret') !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const { code, discount, maxUses } = await request.json() as { code: string; discount: number; maxUses?: number };
      await env.BILLY_KV.put(`promo:${code.toUpperCase()}`, String(discount), {
        metadata: { maxUses: maxUses || 999, uses: 0, created: new Date().toISOString() },
      });
      return new Response(JSON.stringify({ created: true, code: code.toUpperCase(), discount }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
