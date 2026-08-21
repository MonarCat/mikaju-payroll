import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/AuthContext';
import { CompanyProvider, useCompany } from './lib/CompanyContext';
import Login from './screens/Login';
import Signup from './screens/Signup';
import Onboarding from './screens/Onboarding';
import Employees from './screens/Employees';
import PayrollRunWizard from './screens/PayrollRunWizard';

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
  const { signOut } = useAuth();
  return (
    <div className="mk-shell">
      <nav className="mk-sidebar">
        <div style={{ padding: '0 24px 20px', fontWeight: 700 }}>Mikaju</div>
        <NavLink to="/employees" className={({ isActive }) => isActive ? 'active' : ''}>Employees</NavLink>
        <NavLink to="/payroll/new" className={({ isActive }) => isActive ? 'active' : ''}>New payroll run</NavLink>
        <a href="#" onClick={(e) => { e.preventDefault(); signOut(); }} style={{ marginTop: 24, color: '#7a8a80' }}>Sign out</a>
      </nav>
      <main className="mk-main">{children}</main>
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
