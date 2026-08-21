import { useEffect, useState } from 'react';
import { useCompany } from '../lib/CompanyContext';

const emptyForm = { full_name: '', national_id: '', tax_pin: '', bank_name: '', bank_account: '', gross_pay: '' };

export default function Employees() {
  const { company } = useCompany();
  const [employees, setEmployees] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function loadEmployees() {
    if (!company) return;
    const list = await window.mikaju.employees.list(company.id);
    setEmployees(list);
  }

  useEffect(() => { loadEmployees(); }, [company]);

  function startEdit(emp) {
    setEditingId(emp.id);
    setForm({
      full_name: emp.full_name,
      national_id: emp.national_id || '',
      tax_pin: emp.tax_pin || '',
      bank_name: emp.bank_name || '',
      bank_account: emp.bank_account || '',
      gross_pay: String(emp.gross_pay),
    });
  }

  function resetForm() {
    setEditingId(null);
    setForm(emptyForm);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    const grossPay = Number(form.gross_pay);
    if (!form.full_name.trim()) { setError('Full name is required.'); return; }
    if (!Number.isFinite(grossPay) || grossPay <= 0) { setError('Gross pay must be a positive number.'); return; }

    setSubmitting(true);
    try {
      const payload = { ...form, gross_pay: grossPay, company_id: company.id };
      if (editingId) {
        await window.mikaju.employees.update({ id: editingId, ...payload });
      } else {
        await window.mikaju.employees.create(payload);
      }
      resetForm();
      await loadEmployees();
    } catch (err) {
      setError(err.message || 'Could not save employee.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!company) return null;

  return (
    <div>
      <h2>Employees — {company.name}</h2>

      <table className="mk-table" style={{ marginBottom: 28 }}>
        <thead>
          <tr><th>Name</th><th>Gross pay</th><th>Bank</th><th></th></tr>
        </thead>
        <tbody>
          {employees.map((emp) => (
            <tr key={emp.id}>
              <td>{emp.full_name}</td>
              <td>{emp.gross_pay.toLocaleString()}</td>
              <td>{emp.bank_name || '—'}</td>
              <td><button className="mk-btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => startEdit(emp)}>Edit</button></td>
            </tr>
          ))}
          {employees.length === 0 && (
            <tr><td colSpan={4} style={{ color: '#7a8a80' }}>No employees yet — add your first one below.</td></tr>
          )}
        </tbody>
      </table>

      <form className="mk-card" onSubmit={handleSubmit}>
        <h3>{editingId ? 'Edit employee' : 'Add employee'}</h3>
        {error && <div className="mk-error">{error}</div>}

        <div className="mk-field">
          <label htmlFor="full_name">Full name</label>
          <input id="full_name" required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </div>
        <div className="mk-field">
          <label htmlFor="national_id">National ID</label>
          <input id="national_id" value={form.national_id} onChange={(e) => setForm({ ...form, national_id: e.target.value })} />
        </div>
        <div className="mk-field">
          <label htmlFor="tax_pin">Tax PIN</label>
          <input id="tax_pin" value={form.tax_pin} onChange={(e) => setForm({ ...form, tax_pin: e.target.value })} />
        </div>
        <div className="mk-field">
          <label htmlFor="gross_pay">Gross pay (monthly, {company.currency_hint || ''})</label>
          <input id="gross_pay" type="number" min="0" step="0.01" required value={form.gross_pay} onChange={(e) => setForm({ ...form, gross_pay: e.target.value })} />
        </div>
        <div className="mk-field">
          <label htmlFor="bank_name">Bank name</label>
          <input id="bank_name" value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} />
        </div>
        <div className="mk-field">
          <label htmlFor="bank_account">Bank account</label>
          <input id="bank_account" value={form.bank_account} onChange={(e) => setForm({ ...form, bank_account: e.target.value })} />
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button className="mk-btn" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : editingId ? 'Save changes' : 'Add employee'}
          </button>
          {editingId && <button type="button" className="mk-btn" style={{ background: '#7a8a80' }} onClick={resetForm}>Cancel</button>}
        </div>
      </form>
    </div>
  );
}
