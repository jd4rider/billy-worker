/**
 * Billy.sh Cloudflare Worker
 * Handles Lemon Squeezy webhooks, promo code validation, and admin endpoints.
 *
 * Required CF secrets (set via wrangler secret put):
 *   BILLY_PRIVATE_KEY    - Ed25519 private key base64
 *   LEMON_SQUEEZY_SECRET - webhook signing secret
 *   RESEND_API_KEY       - for sending email
 *   ADMIN_SECRET         - for /admin/* endpoints
 */

const VARIANT_TIERS: Record<string, string> = {
  "pro_monthly":     "pro",
  "pro_onetime":     "pro",
  "premium_monthly": "premium",
  "premium_onetime": "premium",
  "team_5":          "team",
  "team_10":         "team",
  "team_25":         "team",
};

const VARIANT_SEATS: Record<string, number> = {
  "team_5":  5,
  "team_10": 10,
  "team_25": 25,
};

interface Env {
  BILLY_PRIVATE_KEY: string;
  LEMON_SQUEEZY_SECRET: string;
  RESEND_API_KEY: string;
  ADMIN_SECRET: string;
  BILLY_KV: KVNamespace;
}

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'https://jd4rider.github.io',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
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

    // Admin: create promo code (protected by X-Admin-Secret header)
    if (url.pathname === '/admin/promo' && request.method === 'POST') {
      const adminSecret = request.headers.get('X-Admin-Secret');
      if (adminSecret !== env.ADMIN_SECRET) {
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

    // Lemon Squeezy webhook handler
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const body = await request.text();

    // Verify Lemon Squeezy signature
    const sig = request.headers.get('X-Signature');
    if (!sig || !(await verifySignature(body, sig, env.LEMON_SQUEEZY_SECRET))) {
      return new Response('Invalid signature', { status: 401 });
    }

    const event = JSON.parse(body);
    const eventName = event.meta?.event_name;

    if (eventName !== 'order_created' && eventName !== 'subscription_created') {
      return new Response('Ignored', { status: 200 });
    }

    const data = event.data?.attributes;
    const email = data?.user_email;
    const variantName =
      data?.first_order_item?.variant_name?.toLowerCase().replace(/\s+/g, '_') ||
      data?.variant_name?.toLowerCase().replace(/\s+/g, '_') ||
      'pro_onetime';

    const tier = VARIANT_TIERS[variantName] ?? 'pro';
    const seats = VARIANT_SEATS[variantName] ?? 0;

    const key = await generateLicenseKey(env.BILLY_PRIVATE_KEY, email, tier, seats);
    await sendEmail(env.RESEND_API_KEY, email, tier, key);

    return new Response('OK', { status: 200 });
  },
};

async function verifySignature(body: string, sig: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const sigBytes = hexToBytes(sig);
  return crypto.subtle.verify("HMAC", cryptoKey, sigBytes, encoder.encode(body));
}

async function generateLicenseKey(
  privKeyB64: string,
  email: string,
  tier: string,
  seats: number
): Promise<string> {
  const privBytes = base64ToBytes(privKeyB64);
  // Ed25519 private key: first 32 bytes = seed, import as raw
  const seed = privBytes.slice(0, 32);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    seed,
    { name: "Ed25519" },
    false,
    ["sign"]
  );

  const payload: Record<string, unknown> = {
    email,
    tier,
    issued_at: new Date().toISOString(),
    expiry: "", // empty = lifetime for one-time; set date for subscriptions
  };
  if (seats > 0) payload.seats = seats;

  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("Ed25519", cryptoKey, payloadBytes);

  const combined = new Uint8Array(sig.byteLength + payloadBytes.length);
  combined.set(new Uint8Array(sig));
  combined.set(payloadBytes, sig.byteLength);

  return "BILLY-" + bytesToBase64Url(combined);
}

async function sendEmail(
  apiKey: string,
  email: string,
  tier: string,
  key: string
): Promise<void> {
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Billy.sh <noreply@billy.sh>",
      to: email,
      subject: `Your Billy.sh ${tierLabel} License Key`,
      html: `
        <h2>Welcome to Billy.sh ${tierLabel}! 🐐</h2>
        <p>Your license key:</p>
        <pre style="background:#0d1117;color:#38bdf8;padding:16px;border-radius:8px;font-size:14px;">${key}</pre>
        <p>Activate in your terminal:</p>
        <pre style="background:#0d1117;color:#f8f8f2;padding:16px;border-radius:8px;">/license ${key}</pre>
        <p>Thank you for supporting Billy.sh!</p>
        <hr>
        <small>Need help? Reply to this email.</small>
      `,
    }),
  });
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
