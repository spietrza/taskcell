-- Orders recorded by stripe-webhook.js. Apply with: pnpm dlx wrangler@4 d1 execute taskcell-orders --remote --file orders.sql
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
