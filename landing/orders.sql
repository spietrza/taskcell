-- Orders recorded by stripe-webhook.js. A database made before the payout columns needs, once:
-- ALTER TABLE orders ADD COLUMN paid_amount INTEGER; ALTER TABLE orders ADD COLUMN payout_amount INTEGER; ALTER TABLE orders ADD COLUMN payout_currency TEXT;
-- Apply with: pnpm dlx wrangler@4 d1 execute taskcell-orders --remote --file orders.sql
CREATE TABLE IF NOT EXISTS orders (
  session_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  livemode INTEGER NOT NULL,
  customer TEXT,
  email TEXT,
  price TEXT,
  subscription TEXT,
  amount_total INTEGER,
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'paid',
  pass_credited INTEGER NOT NULL DEFAULT 0,
  -- Charged after any credit, in `currency`; then what Stripe pays out, after its fee, and in which currency.
  paid_amount INTEGER,
  payout_amount INTEGER,
  payout_currency TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
