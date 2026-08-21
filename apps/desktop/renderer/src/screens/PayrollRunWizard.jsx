import { useEffect, useState } from 'react';
import { useCompany } from '../lib/CompanyContext';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// pick → calculate → review → approve(+lock)
export default function PayrollRunWizard() {
  const { company } = useCompany();
  const now = new Date();
  const [periodMonth, setPeriodMonth] = useState(now.getMonth() + 1);
  const [periodYear, setPeriodYear] = useState(now.getFullYear());
  const [run, setRun] = useState(null);
  const [payslips, setPayslips] = useState([]);
  const [employeesById, setEmployeesById] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!company) return;
    window.mikaju.employees.list(company.id).then((list) => {
      setEmployeesById(Object.fromEntries(list.map((e) => [e.id, e])));
    });
  }, [company]);

  async function handleCreateAndCalculate(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const newRun = await window.mikaju.payrollRuns.create({ companyId: company.id, periodMonth, periodYear });
      const generated = await window.mikaju.payslips.generateForRun({
        payrollRunId: newRun.id,
        companyId: company.id,
        countryCode: company.country_code,
      });
      setRun({ ...newRun, status: 'reviewed' });
      setPayslips(generated);
    } catch (err) {
      setError(err.message || 'Could not calculate this payroll run.');
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    setBusy(true);
    setError(null);
    try {
      const approved = await window.mikaju.payrollRuns.approve({ payrollRunId: run.id, approvedBy: company.id });
      setRun({ ...run, ...approved });
    } catch (err) {
      setError(err.message || 'Could not approve this run.');
    } finally {
      setBusy(false);
    }
  }

  if (!company) return null;

  const totalNet = payslips.reduce((sum, p) => sum + p.net_pay, 0);

  return (
    <div>
      <h2>New payroll run</h2>

      {!run && (
        <form className="mk-card" onSubmit={handleCreateAndCalculate}>
          <div className="mk-field">
            <label htmlFor="month">Period</label>
            <select id="month" value={periodMonth} onChange={(e) => setPeriodMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div className="mk-field">
            <label htmlFor="year">Year</label>
            <input id="year" type="number" value={periodYear} onChange={(e) => setPeriodYear(Number(e.target.value))} />
          </div>
          {error && <div className="mk-error">{error}</div>}
          <button className="mk-btn" type="submit" disabled={busy}>
            {busy ? 'Calculating…' : 'Calculate payroll'}
          </button>
        </form>
      )}

      {run && (
        <div className="mk-card" style={{ maxWidth: 640 }}>
          <h3>
            {MONTHS[periodMonth - 1]} {periodYear} — {run.status === 'locked' ? 'Approved & locked' : 'Review'}
          </h3>
          {error && <div className="mk-error">{error}</div>}

          <table className="mk-table" style={{ marginBottom: 20 }}>
            <thead><tr><th>Employee</th><th>Gross</th><th>Net pay</th><th></th></tr></thead>
            <tbody>
              {payslips.map((p) => (
                <tr key={p.id}>
                  <td>{employeesById[p.employee_id]?.full_name || p.employee_id}</td>
                  <td>{employeesById[p.employee_id]?.gross_pay.toLocaleString()}</td>
                  <td>{p.net_pay.toLocaleString()}</td>
                  <td>
                    <button
                      className="mk-btn"
                      style={{ padding: '4px 10px', fontSize: 12 }}
                      onClick={async () => {
                        const filePath = await window.mikaju.payslips.generatePdf({ payslipId: p.id });
                        window.mikaju.files.openPath(filePath);
                      }}
                    >
                      Payslip PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p><strong>Total net pay: {totalNet.toLocaleString()} {company.currency_hint || ''}</strong></p>

          {run.status !== 'locked' ? (
            <button className="mk-btn" onClick={handleApprove} disabled={busy}>
              {busy ? 'Approving…' : 'Approve & lock this run'}
            </button>
          ) : (
            <p style={{ color: '#0f6b47', fontWeight: 600 }}>
              This run is locked. Payslip PDFs can be generated from the payroll history.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
