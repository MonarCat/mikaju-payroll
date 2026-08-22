import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Note: MIKAJU_ prefix used throughout — SUPABASE_ is reserved by the CLI.
const MIKAJU_PAYSTACK_SECRET   = Deno.env.get('MIKAJU_PAYSTACK_SECRET')!;
const MIKAJU_DB_URL            = Deno.env.get('MIKAJU_DB_URL')!;
const MIKAJU_SERVICE_ROLE_KEY  = Deno.env.get('MIKAJU_SERVICE_ROLE_KEY')!;

// Service-role client writes to the mikaju schema bypassing RLS
// (subscriptions and license_tokens are written here, not by end users).
const supabase = createClient(MIKAJU_DB_URL, MIKAJU_SERVICE_ROLE_KEY, {
  db: { schema: 'mikaju' },
});

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const rawBody  = await req.text();
  const sig      = req.headers.get('x-paystack-signature') ?? '';
  const isValid  = await verifySignature(rawBody, sig, MIKAJU_PAYSTACK_SECRET);
  if (!isValid) return new Response('Invalid signature', { status: 401 });

  const event = JSON.parse(rawBody);

  try {
    switch (event.event) {
      case 'subscription.create':
      case 'charge.success':
        await handleActivePayment(event.data);
        break;
      case 'subscription.disable':
        await handleDisabled(event.data);
        break;
      case 'invoice.payment_failed':
        await handleFailed(event.data);
        break;
    }
  } catch (err) {
    console.error('paystack-webhook error', err);
  }

  return new Response('OK', { status: 200 });
});

async function handleActivePayment(data: any) {
  const { company_id, plan_tier, billing_cycle } = data.metadata ?? {};
  if (!company_id || !plan_tier || !billing_cycle) return;

  // FIX: paystack_subscription_code and paystack_customer_code are both
  // NOT NULL on the subscriptions table. The checkout this webhook
  // actually receives events from (Upgrade.jsx, Paystack Popup V2
  // newTransaction()) creates a ONE-TIME charge, not a true Paystack
  // Subscription object - so data.subscription_code is normally absent
  // on the charge.success events this fires for. Previously this fell
  // through to `?? null`, which the DB then rejected outright: the
  // upsert threw, was swallowed by the outer try/catch, and Paystack
  // still got a 200 - meaning a real customer could be charged and never
  // upgraded, with no visible error anywhere.
  //
  // data.reference (Paystack's transaction reference) IS always present
  // on every charge.success event, real and unique per transaction - not
  // a placeholder, genuinely traceable back to that specific payment.
  const subscriptionCode = data.subscription_code ?? data.reference;
  const customerCode = data.customer?.customer_code;

  if (!subscriptionCode || !customerCode) {
    console.error(
      'paystack-webhook: cannot record subscription - missing required fields',
      { company_id, hasSubscriptionCode: !!subscriptionCode, hasCustomerCode: !!customerCode, event: data }
    );
    return;
  }

  const periodEnd = new Date();
  billing_cycle === 'yearly'
    ? periodEnd.setFullYear(periodEnd.getFullYear() + 1)
    : periodEnd.setMonth(periodEnd.getMonth() + 1);

  await supabase.from('subscriptions').upsert({
    company_id, plan_tier, billing_cycle,
    paystack_subscription_code: subscriptionCode,
    paystack_customer_code: customerCode,
    status: 'active',
    current_period_end: periodEnd.toISOString(),
  }, { onConflict: 'company_id' });

  await supabase.from('companies').update({
    plan_tier, billing_cycle, subscription_status: 'active',
  }).eq('id', company_id);
}

// NOTE: these two handlers respond to Paystack's TRUE recurring-
// subscription lifecycle events (subscription.disable, invoice.payment_
// failed), which Paystack only emits for Subscription objects created via
// its dedicated Subscriptions/Plans API. The current checkout flow does
// NOT create those - it's one-time charges per billing period - so these
// two events will not fire for payments made through this app today.
// Renewal is currently manual: a customer's access naturally lapses once
// current_period_end passes and license-issue's grace period runs out,
// and they return to the in-app Upgrade screen to pay again. If/when true
// auto-recurring billing is wanted, it needs actual Paystack Plan codes
// (created via the Paystack dashboard or API with the secret key) and
// Upgrade.jsx would need to initialize a subscription against a plan
// rather than a one-time newTransaction() charge - a separate, larger
// piece of work, not a quick addition to this fix.
async function handleDisabled(data: any) {
  await updateBySubCode(data.subscription_code, 'cancelled');
}
async function handleFailed(data: any) {
  await updateBySubCode(data.subscription?.subscription_code, 'past_due');
}
async function updateBySubCode(code: string | undefined, status: string) {
  if (!code) return;
  await supabase.from('subscriptions').update({ status }).eq('paystack_subscription_code', code);
  await supabase.from('companies').update({ subscription_status: status }).eq('paystack_subscription_code', code);
}

async function verifySignature(body: string, sig: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2,'0')).join('');
  return hex === sig;
}
