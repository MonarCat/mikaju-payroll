import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/AuthContext';
import { CompanyProvider, useCompany } from './lib/CompanyContext';
import { PLANS } from './lib/paystack';
import Login from './screens/Login';
import Signup from './screens/Signup';
import Onboarding from './screens/Onboarding';
import Employees from './screens/Employees';
import PayrollRunWizard from './screens/PayrollRunWizard';
import Upgrade from './screens/Upgrade';

function RequireAuth({ children }) {
  const { session } = useAuth();
  if (session === undefined) return <FullPageLoading />;
  if (session === null) return <Navigate to="/login" replace />;
  return children;
}

function RequireCompany({ children }) {
  const { company } = useCompany();
  if (company === undefined) return <FullPageLoading />;
  if (company === null) return <Navigate to="/onboarding" replace />;
  return children;
}

function FullPageLoading() {
  return <div className="mk-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>Loading…</div>;
}

function AppShell({ children }) {
  const { signOut, session } = useAuth();
  const { entitlement } = useCompany();
  const pendingPlan = session?.user?.user_metadata?.pending_plan_tier;
  const showPendingBanner = pendingPlan && PLANS[pendingPlan] && entitlement?.plan !== pendingPlan;

  return (
    <div className="mk-shell">
      <nav className="mk-sidebar">
        <div style={{ padding: '0 24px 20px', fontWeight: 700 }}>Mikaju</div>
        <NavLink to="/employees" className={({ isActive }) => isActive ? 'active' : ''}>Employees</NavLink>
        <NavLink to="/payroll/new" className={({ isActive }) => isActive ? 'active' : ''}>New payroll run</NavLink>
        <NavLink to="/upgrade" className={({ isActive }) => isActive ? 'active' : ''}>Upgrade plan</NavLink>
        <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }} style={{ marginTop: 24, color: '#7a8a80' }}>Sign out</a>
      </nav>
      <main className="mk-main">
        {showPendingBanner && (
          <div className="mk-card" style={{ background: '#eaf3ef', borderColor: '#0f6b47', marginBottom: 20 }}>
            You selected the <strong>{PLANS[pendingPlan].label}</strong> plan on our website —{' '}
            <NavLink to="/upgrade" style={{ color: '#0a4f34', fontWeight: 600 }}>finish setting it up here</NavLink>.
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <CompanyProvider>
              <Routes>
                <Route path="/onboarding" element={<Onboarding />} />
                <Route
                  path="/*"
                  element={
                    <RequireCompany>
                      <AppShell>
                        <Routes>
                          <Route path="/employees" element={<Employees />} />
                          <Route path="/payroll/new" element={<PayrollRunWizard />} />
                          <Route path="/upgrade" element={<Upgrade />} />
                          <Route path="/" element={<Navigate to="/employees" replace />} />
                          <Route path="*" element={<Navigate to="/employees" replace />} />
                        </Routes>
                      </AppShell>
                    </RequireCompany>
                  }
                />
              </Routes>
            </CompanyProvider>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
