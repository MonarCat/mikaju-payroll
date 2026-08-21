import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

export default function Login() {
  const { session, authError, signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (session) return <Navigate to="/" replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    const ok = await signIn(email, password);
    setSubmitting(false);
    if (ok) navigate('/');
  }

  return (
    <div className="mk-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <form className="mk-auth-card" onSubmit={handleSubmit}>
        <h2>Sign in to Mikaju</h2>
        {authError && <div className="mk-error">{authError}</div>}
        <div className="mk-field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <div className="mk-field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button className="mk-btn" type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        <p style={{ fontSize: 13, marginTop: 16 }}>
          New to Mikaju? <Link to="/signup">Create an account</Link>
        </p>
      </form>
    </div>
  );
}
