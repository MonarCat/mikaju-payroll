import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCompany } from '../lib/CompanyContext';

export default function Onboarding() {
  const { refresh } = useCompany();
  const navigate = useNavigate();
  const [countries, setCountries] = useState([]);
  const [name, setName] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [kraPin, setKraPin] = useState('');
  const [logoPath, setLogoPath] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    window.mikaju.countries.list().then((list) => {
      setCountries(list);
      if (list.length) setCountryCode(list[0].code);
    });
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Company name is required.'); return; }
    if (!countryCode) { setError('Select a country.'); return; }

    setSubmitting(true);
    try {
      await window.mikaju.companies.create({
        name: name.trim(),
        country_code: countryCode,
        kra_pin: kraPin.trim() || null,
        logo_url: logoPath,
      });
      await refresh();
      navigate('/employees');
    } catch (err) {
      setError(err.message || 'Could not create company. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mk-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <form className="mk-card" onSubmit={handleSubmit} style={{ maxWidth: 480 }}>
        <h2>Set up your company</h2>
        <p style={{ fontSize: 13, color: '#5a685f' }}>
          This tells Mikaju which statutory rules (PAYE, pension, health levy)
          apply to your payroll runs.
        </p>
        {error && <div className="mk-error">{error}</div>}

        <div className="mk-field">
          <label htmlFor="companyName">Company name</label>
          <input id="companyName" required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>

        <div className="mk-field">
          <label htmlFor="country">Country</label>
          <select id="country" value={countryCode} onChange={(e) => setCountryCode(e.target.value)}>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>{c.flag} {c.name} ({c.currency})</option>
            ))}
          </select>
        </div>

        <div className="mk-field">
          <label htmlFor="kraPin">Tax PIN <span style={{ fontWeight: 400 }}>(e.g. KRA PIN — optional for now)</span></label>
          <input id="kraPin" value={kraPin} onChange={(e) => setKraPin(e.target.value)} />
        </div>

        <div className="mk-field">
          <label htmlFor="logo">Logo <span style={{ fontWeight: 400 }}>(shown on payslips — optional)</span></label>
          <input
            id="logo"
            type="file"
            accept="image/png,image/jpeg"
            onChange={(e) => {
              const file = e.target.files?.[0];
              setLogoPath(file ? window.mikaju.files.getPathForFile(file) : null);
            }}
          />
        </div>

        <button className="mk-btn" type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}
