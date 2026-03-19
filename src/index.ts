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

// Keyed by numeric Lemon Squeezy variant ID (more reliable than name).
const VARIANT_TIERS: Record<number, string> = {
  // Test-mode variants
  1408429: "pro",      // Billy Pro (test)
  1408393: "premium",  // Billy Premium (test)
  1408425: "team",     // Billy Teams 5 Seat (test)
  1408426: "team",     // Billy Teams 10 Seat (test)
  1408428: "team",     // Billy Teams 25 Seat (test)
  // Live-mode variants
  1420712: "pro",      // Billy Pro (live)
  1420713: "premium",  // Billy Premium (live)
  1420715: "team",     // Billy Teams 5 Seat (live)
  1420716: "team",     // Billy Teams 10 Seat (live)
  1420717: "team",     // Billy Teams 25 Seat (live)
};

const VARIANT_SEATS: Record<number, number> = {
  1408425: 5,
  1408426: 10,
  1408428: 25,
  1420715: 5,
  1420716: 10,
  1420717: 25,
};

interface Env {
  BILLY_PRIVATE_KEY: string;
  LEMON_SQUEEZY_SECRET: string;
  RESEND_API_KEY: string;
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

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', version: '0.1.0' }), {
        status: 200, headers: getCorsHeaders(null),
      });
    }

    // Newsletter subscribe
    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const body2 = await request.json() as { email?: string };
      const subEmail = (body2.email || '').trim().toLowerCase();
      if (!subEmail || !subEmail.includes('@') || !subEmail.includes('.')) {
        return new Response(JSON.stringify({ ok: false, message: 'Please provide a valid email address.' }), {
          status: 400, headers: corsHeaders,
        });
      }
      await env.BILLY_KV.put(`subscriber:${subEmail}`, JSON.stringify({
        email: subEmail,
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
    const testMode: boolean = event.meta?.test_mode === true;

    if (eventName !== 'order_created' && eventName !== 'subscription_created') {
      return new Response('Ignored', { status: 200 });
    }

    const data = event.data?.attributes;
    // In test mode, redirect all emails to the store owner for verification
    const customerEmail = data?.user_email;
    const email = testMode ? 'jd4rider@gmail.com' : customerEmail;
    const variantId: number =
      data?.first_order_item?.variant_id ||
      data?.variant_id ||
      0;

    const tier = VARIANT_TIERS[variantId] ?? 'pro';
    const seats = VARIANT_SEATS[variantId] ?? 0;

    try {
      const key = await generateLicenseKey(env.BILLY_PRIVATE_KEY, email, tier, seats);
      await sendEmail(env.RESEND_API_KEY, email, tier, key, testMode);
      return new Response('OK', { status: 200 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Webhook handler error:', msg);
      return new Response(`Internal error: ${msg}`, { status: 500 });
    }
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
  const seed = privBytes.slice(0, 32);

  // CF Workers WebCrypto requires PKCS8 format for Ed25519 private key import.
  // PKCS8 DER wrapper for Ed25519: 30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 + 32 seed bytes
  const pkcs8Prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = new Uint8Array(pkcs8Prefix.length + seed.length);
  pkcs8.set(pkcs8Prefix);
  pkcs8.set(seed, pkcs8Prefix.length);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
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
  key: string,
  testMode = false
): Promise<void> {
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Billy.sh <onboarding@resend.dev>",
      to: email,
      subject: `${testMode ? '[TEST] ' : ''}Your Billy.sh ${tierLabel} License Key`,
      html: `
        <h2>Welcome to Billy.sh ${tierLabel}! 🐐</h2>
        <p style="background:#fffbeb;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:4px;">
          📬 <strong>This email is from <code>onboarding@resend.dev</code>.</strong><br>
          If you don't see it in your inbox, please check your <strong>spam or junk folder</strong>
          and mark it as "Not Spam" so future emails arrive safely.
        </p>
        <p>Your license key:</p>
        <pre style="background:#0d1117;color:#38bdf8;padding:16px;border-radius:8px;font-size:14px;word-break:break-all;">${key}</pre>
        <p>Activate in your terminal:</p>
        <pre style="background:#0d1117;color:#f8f8f2;padding:16px;border-radius:8px;">1. Run billy in your terminal
2. Type: /activate
3. Paste your key when prompted</pre>
        <p>Thank you for supporting Billy.sh!</p>
        <hr>
        <small>Need help? Reply to this email or visit <a href="https://billy.sh">billy.sh</a>.</small>
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
