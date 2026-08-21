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

  const periodEnd = new Date();
  billing_cycle === 'yearly'
    ? periodEnd.setFullYear(periodEnd.getFullYear() + 1)
    : periodEnd.setMonth(periodEnd.getMonth() + 1);

  await supabase.from('subscriptions').upsert({
    company_id, plan_tier, billing_cycle,
    paystack_subscription_code: data.subscription_code ?? null,
    paystack_customer_code: data.customer?.customer_code ?? null,
    status: 'active',
    current_period_end: periodEnd.toISOString(),
  }, { onConflict: 'company_id' });

  await supabase.from('companies').update({
    plan_tier, billing_cycle, subscription_status: 'active',
  }).eq('id', company_id);
}

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
