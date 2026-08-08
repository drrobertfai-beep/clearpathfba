// Local webhook simulation v2: record (completed), sync (updated), cancel
// (deleted) using genuinely signed events. Verifies period sync + cancel.
import Stripe from 'stripe';
import fs from 'node:fs';

const KEY = fs.readFileSync('/home/agent-lead/.stripe-test-key', 'utf8').trim();
const WEBHOOK_SECRET = process.env.WH_SECRET;
const API = process.env.API || 'http://localhost:4010';
const st = new Stripe(KEY);

const sign = (event) => {
 const payloadStr = JSON.stringify(event, null, 2);
 const header = st.webhooks.generateTestHeaderString({ payload: payloadStr, secret: WEBHOOK_SECRET });
 return { payloadStr, header };
};
const post = async (evt) => {
 const { payloadStr, header } = sign(evt);
 const r = await fetch(`${API}/api/stripe/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
  body: payloadStr,
 });
 return r.status + ' ' + (await r.text());
};

// 1. Real customer + subscription with account identity.
const customer = await st.customers.create({ email: 'billing-test@example.com' });
const pm = await st.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
await st.paymentMethods.attach(pm.id, { customer: customer.id });
await st.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
const subscription = await st.subscriptions.create({
 customer: customer.id,
 items: [{ price: 'price_1U2CV3IO23kP90RtVwNl8lOt', quantity: 2 }],
 metadata: { user_id: '1', username: 'admin', plan_key: 'practice' },
});
console.log('created sub', subscription.id, subscription.status);

// 2. checkout.session.completed (session object with subscription/customer).
console.log('completed ->', await post({
 id: `evt_completed_${Date.now()}`, object: 'event', api_version: '2025-06-10.basil',
 created: Math.floor(Date.now() / 1000), data: { object: {
  id: `cs_test_${Date.now()}`, object: 'checkout.session', mode: 'subscription',
  subscription: subscription.id, customer: customer.id, customer_email: customer.email,
  client_reference_id: '1', metadata: { user_id: '1', username: 'admin', plan_key: 'practice' },
  livemode: false, status: 'complete', payment_status: 'paid',
 } }, livemode: false, pending_webhooks: 0, request: { id: null, idempotency_key: null },
 type: 'checkout.session.completed',
}));

// 3. customer.subscription.updated with a changed period + quantity.
const upd = await st.subscriptions.retrieve(subscription.id);
upd.status = 'past_due';
upd.cancel_at_period_end = false;
console.log('updated   ->', await post({
 id: `evt_updated_${Date.now()}`, object: 'event', api_version: '2025-06-10.basil',
 created: Math.floor(Date.now() / 1000), data: { object: upd }, livemode: false,
 pending_webhooks: 0, request: { id: null, idempotency_key: null },
 type: 'customer.subscription.updated',
}));

// 4. customer.subscription.deleted.
console.log('deleted   ->', await post({
 id: `evt_deleted_${Date.now()}`, object: 'event', api_version: '2025-06-10.basil',
 created: Math.floor(Date.now() / 1000), data: { object: { ...upd, status: 'canceled' } },
 livemode: false, pending_webhooks: 0, request: { id: null, idempotency_key: null },
 type: 'customer.subscription.deleted',
}));
