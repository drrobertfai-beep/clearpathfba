// ClearPathFBA — server-side Stripe subscription billing.
//
// TEST MODE ONLY for this milestone: the module is driven entirely by
// STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET environment variables, which are
// the owner's TEST keys until pilot conversion (see docs/billing.md for the
// live-key swap procedure). The secret key never leaves the server and never
// reaches the client — the client only ever talks to /api/billing/*, which
// this module backs.
//
// Pricing (owner-ratified 2026-08-08, published on the landing page):
// recurring monthly subscriptions only, one subscription per account for this
// milestone, admin chooses tier + number of clinician seats (quantity).
import Stripe from 'stripe';

export const PLANS = [
 {
  key: 'solo',
  label: 'Solo',
  description: 'Independent practitioner',
  price_label: '$49/clinician/month',
  amount: 4900,
  product: 'ClearPathFBA Solo',
  lookup_key: 'clearpathfba_solo_monthly',
 },
 {
  key: 'practice',
  label: 'Practice',
  description: 'Small practice team',
  price_label: '$39/clinician/month',
  amount: 3900,
  product: 'ClearPathFBA Practice',
  lookup_key: 'clearpathfba_practice_monthly',
 },
 {
  key: 'organization',
  label: 'Organization',
  description: 'Multi-site organization',
  price_label: '$29/clinician/month',
  amount: 2900,
  product: 'ClearPathFBA Organization',
  lookup_key: 'clearpathfba_organization_monthly',
 },
];
export const PLAN_KEYS = PLANS.map((p) => p.key);
export const planByKey = (key) => PLANS.find((p) => p.key === key);
export const planLabel = (key) => (planByKey(key) || {}).label || key;

const KEY = process.env.STRIPE_SECRET_KEY;
export const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

let _stripe = null;
/** Stripe client, or null when STRIPE_SECRET_KEY is not configured. */
export function stripeClient() {
 if (!KEY) return null;
 if (!_stripe) _stripe = new Stripe(KEY);
 return _stripe;
}

// The account has Stripe Managed Payments enabled by default, which requires
// every product to carry an eligible product tax code. txcd_99999999 is the
// generic "Services" tax code (eligible for software-as-a-service billing).
const PRODUCT_TAX_CODE = 'txcd_99999999';

// Idempotent plan/price provisioning. Prices are looked up by lookup_key (the
// Stripe price-lookup API); a missing price is created. The result is memoized
// per server instance. Callers should `await` — one code path for both modes.
let _plansPromise = null;
export function ensurePlans() {
 if (!_plansPromise) {
  _plansPromise = (async () => {
   const st = stripeClient();
   if (!st) throw new Error('STRIPE_SECRET_KEY is not configured.');
   const out = {};
   for (const plan of PLANS) {
    // Ensure the product exists with the Managed-Payments-eligible tax code
    // (created products from earlier runs may predate the tax_code requirement).
    const products = await st.products.list({ active: true, limit: 100 });
    let product = products.data.find((p) => p.metadata && p.metadata.clearpathfba_plan === plan.key);
    if (!product) {
     product = await st.products.create({
      name: plan.product,
      description: `${plan.description} — ${plan.price_label} (ClearPathFBA)`,
      tax_code: PRODUCT_TAX_CODE,
      metadata: { clearpathfba_plan: plan.key },
     });
    } else if (!product.tax_code) {
     product = await st.products.update(product.id, { tax_code: PRODUCT_TAX_CODE });
    }
    // Look up the monthly recurring price by lookup_key (active prices only).
    const existing = await st.prices.list({ lookup_keys: [plan.lookup_key], limit: 100 });
    const hit = existing.data.find((p) => p.recurring && p.recurring.interval === 'month');
    if (hit) {
     out[plan.key] = hit.id;
     continue;
    }
    let created;
    try {
     created = await st.prices.create({
      product: product.id,
      unit_amount: plan.amount,
      currency: 'usd',
      recurring: { interval: 'month', interval_count: 1 },
      lookup_key: plan.lookup_key,
      metadata: { clearpathfba_plan: plan.key },
     });
    } catch (err) {
     // Duplicate lookup key (e.g. an inactive price already holds it): reuse it.
     const all = await st.prices.list({ limit: 100, active: false });
     const stale = all.data.find((p) => p.lookup_key === plan.lookup_key);
     if (!stale) throw err;
     created = stale;
    }
    out[plan.key] = created.id;
   }
   return out;
  })();
 }
 return _plansPromise;
}

/** The app's own base URL, used for Checkout success/cancel redirects. */
export function appBaseUrl() {
 if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
 if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
 return 'https://clearpathfba-app.vercel.app';
}

/**
 * Create a Stripe Checkout Session (mode: subscription) for one plan + quantity.
 * The account identity rides along in metadata (session + subscription) so the
 * webhook can reconcile the completed checkout back to the user account.
 */
export async function createCheckoutSession({ userId, username, email, planKey, quantity, baseUrl }) {
 const st = stripeClient();
 if (!st) throw new Error('STRIPE_SECRET_KEY is not configured.');
 const plan = planByKey(planKey);
 if (!plan) throw new Error('Unknown plan key.');
 const qty = Math.max(1, Math.min(500, Math.floor(Number(quantity) || 1)));
 const prices = await ensurePlans();
 const identity = { user_id: String(userId), username: String(username || ''), plan_key: planKey };
 return st.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: prices[planKey], quantity: qty }],
  client_reference_id: String(userId),
  customer_email: email || undefined,
  metadata: identity,
  subscription_data: { metadata: identity },
  // The account has Stripe Managed Payments on by default; without an
  // eligible Managed-Payments product tax code, Checkout rejects the session.
  // This milestone does not use Stripe Tax, so keep the classic Checkout flow.
  managed_payments: { enabled: false },
  success_url: `${baseUrl}/?billing=success`,
  cancel_url: `${baseUrl}/?billing=cancelled`,
 });
}

// Stripe gives unix seconds; the app stores 'YYYY-MM-DD HH:MM:SS' UTC
// (matches both SQLite CURRENT_TIMESTAMP and the PG adapter's timestamptz).
const epochToTs = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString().slice(0, 19).replace('T', ' ') : null);

// On current Stripe API versions the subscription's current_period_end lives on
// the first subscription item rather than the top-level subscription object.
const periodEndOf = (sub) => (sub && sub.current_period_end) || (sub && sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end) || null;

/**
 * Upsert one subscription row (keyed on Stripe's subscription id) from webhook
 * data. All db calls are awaited — one code path for SQLite and Postgres.
 */
export async function upsertSubscription(dbInstance, { userId, customerId, subscriptionId, planKey, planLabel: label, quantity, status, currentPeriodEnd, cancelAtPeriodEnd }) {
 const existing = await dbInstance.prepare('SELECT id FROM subscriptions WHERE subscription_id=?').get(subscriptionId);
 const ts = epochToTs(currentPeriodEnd);
 const qty = Math.max(1, Math.floor(Number(quantity) || 1));
 if (existing) {
  await dbInstance.prepare('UPDATE subscriptions SET user_id=?, customer_id=?, plan_key=?, plan_label=?, quantity=?, status=?, current_period_end=?, cancel_at_period_end=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
   .run(userId, customerId, planKey || 'unknown', label || null, qty, status || 'incomplete', ts, cancelAtPeriodEnd ? 1 : 0, existing.id);
  return existing.id;
 }
 const info = await dbInstance.prepare('INSERT INTO subscriptions (user_id, customer_id, subscription_id, plan_key, plan_label, quantity, status, current_period_end, cancel_at_period_end) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(userId, customerId, subscriptionId, planKey || 'unknown', label || null, qty, status || 'incomplete', ts, cancelAtPeriodEnd ? 1 : 0);
 return Number(info.lastInsertRowid);
}

/** Current subscription for a user account, or null. */
export async function statusForUser(dbInstance, userId) {
 const row = await dbInstance.prepare('SELECT * FROM subscriptions WHERE user_id=? ORDER BY id DESC LIMIT 1').get(userId);
 if (!row) return null;
 return {
  id: row.id,
  plan_key: row.plan_key,
  plan_label: row.plan_label,
  quantity: row.quantity,
  status: row.status,
  current_period_end: row.current_period_end,
  cancel_at_period_end: !!row.cancel_at_period_end,
  customer_id: row.customer_id,
  subscription_id: row.subscription_id,
  created_at: row.created_at,
  updated_at: row.updated_at,
 };
}

/**
 * Dispatch one verified Stripe webhook event. checkout.session.completed
 * records the subscription/customer for the user account (identity came through
 * checkout metadata); customer.subscription.updated/deleted keep status and
 * current_period_end in sync. Returns a short human label for the audit trail.
 */
export async function handleWebhookEvent(event, dbInstance) {
 const obj = event.data && event.data.object;
 switch (event.type) {
  case 'checkout.session.completed': {
   if (!obj || obj.mode !== 'subscription') return `${event.type} (ignored: not a subscription checkout)`;
   const userId = Number(obj.metadata && (obj.metadata.user_id || obj.client_reference_id));
   const subId = obj.subscription;
   if (!userId || !subId) return `${event.type} (ignored: no account identity in metadata)`;
   const st = stripeClient();
   const sub = await st.subscriptions.retrieve(subId);
   await upsertSubscription(dbInstance, {
    userId,
    customerId: obj.customer,
    subscriptionId: subId,
    planKey: (obj.metadata && obj.metadata.plan_key) || (sub.metadata && sub.metadata.plan_key) || 'unknown',
    planLabel: planLabel((obj.metadata && obj.metadata.plan_key) || (sub.metadata && sub.metadata.plan_key)),
    quantity: sub.items && sub.items.data && sub.items.data[0] ? sub.items.data[0].quantity : 1,
    status: sub.status,
    currentPeriodEnd: periodEndOf(sub),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
   });
   return `${event.type} (subscription ${subId} recorded)`;
  }
  case 'customer.subscription.updated':
  case 'customer.subscription.deleted': {
   if (!obj) return `${event.type} (no object)`;
   const row = await dbInstance.prepare('SELECT id FROM subscriptions WHERE subscription_id=?').get(obj.id);
   if (!row) return `${event.type} (ignored: subscription not tracked)`;
   await dbInstance.prepare('UPDATE subscriptions SET status=?, current_period_end=?, cancel_at_period_end=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(obj.status || 'canceled', epochToTs(periodEndOf(obj)), obj.cancel_at_period_end ? 1 : 0, row.id);
   return `${event.type} (subscription ${obj.id} -> ${obj.status || 'canceled'})`;
  }
  default:
   return `${event.type} (unhandled)`;
 }
}
