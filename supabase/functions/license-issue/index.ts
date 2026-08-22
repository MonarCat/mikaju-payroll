import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const MIKAJU_DB_URL              = Deno.env.get('MIKAJU_DB_URL')!;
const MIKAJU_DB_ANON_KEY         = Deno.env.get('MIKAJU_DB_ANON_KEY')!;
const MIKAJU_LICENSE_PRIVATE_KEY = Deno.env.get('MIKAJU_LICENSE_PRIVATE_KEY')!;

const GRACE_DAYS: Record<string, number> = {
  active: 7,
  past_due: 2,
  free: 30,
};

const EMPLOYEE_LIMITS: Record<string, number | null> = {
  free: 3,
  basic: 5,
  enterprise: null,
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return new Response(JSON.stringify({ error: 'Missing Authorization header' }), { status: 401 });

  // FIX: the client's "key" parameter is the project's anon key (this is
  // what Supabase's gateway checks to identify the PROJECT), and the
  // calling user's own JWT goes in the Authorization header (this is what
  // PostgREST checks to resolve auth.uid() for RLS policies). These are
  // two separate concerns - which auth JWT for the request, and which
  // key opts to a project - and the previous version conflated them by
  // passing the user's JWT as both. That may have worked by accident in
  // some Supabase versions but is not the documented, guaranteed pattern.
  const supabase = createClient(MIKAJU_DB_URL, MIKAJU_DB_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    db: { schema: 'mikaju' },
  });

  const { company_id } = await req.json();
  if (!company_id) return new Response(JSON.stringify({ error: 'company_id required' }), { status: 400 });

  const { data: company, error } = await supabase
    .from('companies')
    .select('id, plan_tier, subscription_status')
    .eq('id', company_id)
    .single();

  if (error || !company) return new Response(JSON.stringify({ error: 'Company not found or access denied' }), { status: 404 });

  if (company.subscription_status === 'cancelled' && company.plan_tier !== 'free') {
    return new Response(JSON.stringify({ error: 'Subscription cancelled. Renew to continue.' }), { status: 402 });
  }

  const graceDays = GRACE_DAYS[company.subscription_status] ?? GRACE_DAYS.active;
  const issuedAt  = new Date();
  const expiresAt = new Date(issuedAt.getTime() + graceDays * 86400000);

  const payload = {
    company_id: company.id,
    plan_tier: company.plan_tier,
    employee_limit: EMPLOYEE_LIMITS[company.plan_tier] ?? null,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  const signature = await signPayload(payload);

  const serviceKey = Deno.env.get('MIKAJU_SERVICE_ROLE_KEY');
  if (serviceKey) {
    const adminClient = createClient(MIKAJU_DB_URL, serviceKey, { db: { schema: 'mikaju' } });
    await adminClient.from('license_tokens').insert({
      company_id: company.id,
      plan_tier: company.plan_tier,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
    });
  }

  return new Response(JSON.stringify({ payload, signature }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

async function signPayload(payload: Record<string, unknown>): Promise<string> {
  const jwk = JSON.parse(MIKAJU_LICENSE_PRIVATE_KEY);
  const key  = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(JSON.stringify(payload))
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
