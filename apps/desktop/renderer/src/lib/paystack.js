// Paystack public key — safe to embed client-side by design (this is the
// "publishable" half of the keypair; the secret half stays server-side in
// Supabase Edge Function secrets, never here). This IS the live key, not
// a test key — every successful checkout here is a real charge.
export const PAYSTACK_PUBLIC_KEY = 'pk_live_598132f0ebe09cef45d6f7f7286f87db57f8429e';

// Mirrors the landing page's pricing exactly (index.html, pricing section)
// and license-issue's EMPLOYEE_LIMITS map — keep all three in sync by hand
// if pricing ever changes, since none of these read from a shared source.
export const PLANS = {
  basic: {
    label: 'Basic',
    employeeLimit: 5,
    monthly: 0.99,
    yearly: 9.99,
  },
  enterprise: {
    label: 'Enterprise',
    employeeLimit: null, // unlimited
    monthly: 9.99,
    yearly: 99.99,
  },
};
