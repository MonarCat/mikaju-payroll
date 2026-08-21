import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

export default function Signup() {
  const { session, authError, signUp } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localError, setLocalError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  if (session) return <Navigate to="/" replace />;

  async function handleSubmit(e) {
    e.preventDefault();
    setLocalError(null);

    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setLocalError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    const ok = await signUp(email, password);
    setSubmitting(false);
    if (ok) {
      // Supabase Auth sends a confirmation email by default; only route
      // straight into onboarding if email confirmation is disabled and a
      // session already exists (handled by the <Navigate> above on re-render).
      setCheckEmail(true);
    }
  }

  if (checkEmail) {
    return (
      <div className="mk-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="mk-auth-card">
          <h2>Check your email</h2>
          <p>We sent a confirmation link to <strong>{email}</strong>. Follow it, then come back and sign in.</p>
          <Link to="/login">Back to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mk-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <form className="mk-auth-card" onSubmit={handleSubmit}>
        <h2>Create your Mikaju account</h2>
        {(localError || authError) && <div className="mk-error">{localError || authError}</div>}
        <div className="mk-field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <div className="mk-field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="mk-field">
          <label htmlFor="confirmPassword">Confirm password</label>
          <input id="confirmPassword" type="password" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
        </div>
        <button className="mk-btn" type="submit" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
        <p style={{ fontSize: 13, marginTop: 16 }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
