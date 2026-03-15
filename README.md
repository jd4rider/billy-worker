# Billy Worker

Cloudflare Worker that handles Lemon Squeezy payment webhooks and emails signed Billy.sh license keys.

## Setup

1. Install wrangler: `npm i -g wrangler`
2. `npm install`
3. Set secrets:
   ```bash
   wrangler secret put BILLY_PRIVATE_KEY
   wrangler secret put LEMON_SQUEEZY_SECRET
   wrangler secret put RESEND_API_KEY
   ```
4. `npm run deploy`

## Lemon Squeezy Setup

1. Create products: Billy Pro ($19), Billy Premium ($49), Billy Team (5/10/25 seats)
2. In Lemon Squeezy dashboard → Webhooks → add your Worker URL
3. Select event: `order_created`, `subscription_created`
4. Copy the signing secret → `wrangler secret put LEMON_SQUEEZY_SECRET`

## Testing locally

```bash
npm run dev
# In another terminal:
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -d '{"meta":{"event_name":"order_created"},"data":{"attributes":{"user_email":"test@example.com","first_order_item":{"variant_name":"pro_onetime"}}}}'
```
