import { useEffect, useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { useCompany } from '../lib/CompanyContext';
import { PAYSTACK_PUBLIC_KEY, PLANS } from '../lib/paystack';

// Lazily injects Paystack's script only when someone actually opens this
// screen — an offline-first payroll app shouldn't make an external network
// call on every launch just in case someone might upgrade today.
function loadPaystackScript() {
  return new Promise((resolve, reject) => {
    if (window.PaystackPop) return resolve();
    const existing = document.getElementById('paystack-inline-js');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Paystack — check your internet connection.')));
      return;
    }
    const script = document.createElement('script');
    script.id = 'paystack-inline-js';
    script.src = 'https://js.paystack.co/v2/inline.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Paystack — check your internet connection.'));
    document.head.appendChild(script);
  });
}

export default function Upgrade() {
  const { session } = useAuth();
  const { company, entitlement, refresh } = useCompany();
  const [billingCycle, setBillingCycle] = useState('monthly');
  const [error, setError] = useState(null);
  const [paying, setPaying] = useState(null); // which plan key is mid-checkout
  const [justPaid, setJustPaid] = useState(false);

  // If a plan was picked on the website before this account had a company
  // yet, it's stored in the user's own auth metadata (see the website's
  // sign-up flow) and carries through automatically once they sign in here.
  const pendingPlan = session?.user?.user_metadata?.pending_plan_tier;

  useEffect(() => {
    if (pendingPlan && PLANS[pendingPlan]) {
      setBillingCycle(session?.user?.user_metadata?.pending_billing_cycle || 'monthly');
    }
  }, [pendingPlan]);

  async function handleUpgrade(planKey) {
    setError(null);
    if (!company) return;
    if (!session?.user?.email) {
      setError('Your session looks signed out — please sign in again before upgrading.');
      return;
    }

    setPaying(planKey);
    try {
      await loadPaystackScript();
      const plan = PLANS[planKey];
      const amountUsd = billingCycle === 'yearly' ? plan.yearly : plan.monthly;

      const paystack = new window.PaystackPop();
      paystack.newTransaction({
        key: PAYSTACK_PUBLIC_KEY,
        email: session.user.email,
        amount: Math.round(amountUsd * 100), // Paystack wants the smallest currency unit (cents for USD)
        currency: 'USD',
        // paystack-webhook's handleActivePayment reads exactly these three
        // keys from data.metadata — company_id is what makes checkout safe
        // to do here (inside the app, where it's known) and NOT on the
        // public website (where it isn't). See conversation history for
        // why this matters: without it, the webhook silently no-ops.
        metadata: {
          company_id: company.id,
          plan_tier: planKey,
          billing_cycle: billingCycle,
        },
        onSuccess: async () => {
          setPaying(null);
          setJustPaid(true);
          // The webhook processes this asynchronously — give it a moment,
          // then pull the refreshed entitlement rather than claim success
          // before the plan has actually changed server-side.
          setTimeout(async () => {
            await window.mikaju.sync.now();
            await refresh();
          }, 4000);
        },
        onCancel: () => {
          setPaying(null);
        },
      });
    } catch (err) {
      setPaying(null);
      setError(err.message || 'Could not start checkout.');
    }
  }

  if (!company) return null;

  const currentPlan = entitlement?.plan || 'free';

  return (
    <div>
      <h2>Upgrade Mikaju</h2>

      {pendingPlan && PLANS[pendingPlan] && currentPlan !== pendingPlan && (
        <div className="mk-card" style={{ background: '#eaf3ef', borderColor: '#0f6b47', marginBottom: 20, maxWidth: 480 }}>
          You selected the <strong>{PLANS[pendingPlan].label}</strong> plan on our website — pick it below to finish setting it up.
        </div>
      )}

      {justPaid && (
        <div className="mk-card" style={{ background: '#eaf3ef', borderColor: '#0f6b47', marginBottom: 20, maxWidth: 480 }}>
          Payment received. Your plan updates automatically within about a minute as we confirm it — no need to do anything else.
        </div>
      )}

      {error && <div className="mk-error">{error}</div>}

      <div style={{ marginBottom: 20 }}>
        <button
          className="mk-btn"
          style={{ background: billingCycle === 'monthly' ? undefined : '#d8e0dc', color: billingCycle === 'monthly' ? undefined : '#14201b', marginRight: 8 }}
          onClick={() => setBillingCycle('monthly')}
        >
          Monthly
        </button>
        <button
          className="mk-btn"
          style={{ background: billingCycle === 'yearly' ? undefined : '#d8e0dc', color: billingCycle === 'yearly' ? undefined : '#14201b' }}
          onClick={() => setBillingCycle('yearly')}
        >
          Yearly
        </button>
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        {Object.entries(PLANS).map(([key, plan]) => (
          <div key={key} className="mk-card" style={{ width: 240 }}>
            <h3>{plan.label}</h3>
            <p style={{ fontSize: 28, fontWeight: 700, margin: '8px 0' }}>
              ${billingCycle === 'yearly' ? plan.yearly : plan.monthly}
              <span style={{ fontSize: 13, fontWeight: 400, color: '#7a8a80' }}> / {billingCycle === 'yearly' ? 'year' : 'month'}</span>
            </p>
            <p style={{ fontSize: 13, color: '#5a685f', marginBottom: 16 }}>
              {plan.employeeLimit === null ? 'Unlimited employees' : `Up to ${plan.employeeLimit} employees`}
            </p>
            <button
              className="mk-btn"
              style={{ width: '100%' }}
              disabled={currentPlan === key || paying === key}
              onClick={() => handleUpgrade(key)}
            >
              {currentPlan === key ? 'Current plan' : paying === key ? 'Opening checkout…' : `Upgrade to ${plan.label}`}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
