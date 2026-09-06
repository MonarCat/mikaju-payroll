import { useEffect, useState } from 'react';

// Fields that always differ by design (version bumps on every write,
// timestamps change on every write) or aren't meaningful to a payroll
// admin comparing two versions of a record. Hiding them keeps the diff
// focused on what actually changed in substance.
const NOISE_FIELDS = new Set(['id', 'version', 'created_at', 'updated_at', 'company_id']);

const TABLE_LABELS = {
  employees: 'Employee',
  payroll_runs: 'Payroll run',
  companies: 'Company',
  payslips: 'Payslip',
};

function describeRecord(tableName, payload) {
  if (!payload) return null;
  if (tableName === 'employees') return payload.full_name;
  if (tableName === 'payroll_runs') return `${payload.period_month}/${payload.period_year} payroll run`;
  if (tableName === 'companies') return payload.name;
  return null;
}

function diffFields(localPayload, remotePayload) {
  const keys = new Set([...Object.keys(localPayload || {}), ...Object.keys(remotePayload || {})]);
  const rows = [];
  for (const key of keys) {
    if (NOISE_FIELDS.has(key)) continue;
    const localVal = localPayload?.[key];
    const remoteVal = remotePayload?.[key];
    if (JSON.stringify(localVal) !== JSON.stringify(remoteVal)) {
      rows.push({ key, localVal, remoteVal });
    }
  }
  return rows;
}

function formatValue(v) {
  if (v === undefined) return '—';
  if (v === null) return 'empty';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function SyncConflicts() {
  const [conflicts, setConflicts] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [resolvingId, setResolvingId] = useState(null);

  async function load() {
    try {
      const list = await window.mikaju.sync.listConflicts();
      setConflicts(list);
    } catch (err) {
      setError(err.message || 'Could not load sync conflicts.');
      setConflicts([]);
    }
  }

  useEffect(() => { load(); }, []);

  async function resolve(conflictId, strategy) {
    setResolvingId(conflictId);
    setError(null);
    try {
      await window.mikaju.sync.resolveConflict({ conflictId, strategy });
      await load();
    } catch (err) {
      setError(err.message || 'Could not resolve this conflict.');
    } finally {
      setResolvingId(null);
    }
  }

  if (conflicts === null) return <p style={{ color: '#7a8a80' }}>Loading…</p>;

  return (
    <div>
      <h2>Sync conflicts</h2>
      <p style={{ color: '#7a8a80', marginTop: -8, marginBottom: 24, maxWidth: 640 }}>
        These records were changed on this device and on another device (or the web) while offline,
        before either side saw the other's change. Nothing has been overwritten — pick which version
        to keep for each one below.
      </p>

      {error && <div className="mk-error">{error}</div>}

      {conflicts.length === 0 && (
        <p style={{ color: '#7a8a80' }}>No unresolved conflicts. Everything is in sync.</p>
      )}

      {conflicts.map((conflict) => {
        const localPayload = JSON.parse(conflict.local_payload);
        const remotePayload = conflict.remote_payload ? JSON.parse(conflict.remote_payload) : null;
        const rows = diffFields(localPayload, remotePayload);
        const title = describeRecord(conflict.table_name, localPayload) || describeRecord(conflict.table_name, remotePayload);
        const isResolving = resolvingId === conflict.id;

        return (
          <div key={conflict.id} className="mk-card mk-card-wide" style={{ marginBottom: 20 }}>
            <h3 style={{ marginTop: 0 }}>
              {TABLE_LABELS[conflict.table_name] || conflict.table_name}
              {title ? `: ${title}` : ''}
            </h3>
            <p style={{ color: '#7a8a80', fontSize: 13, marginTop: -8 }}>
              Detected {new Date(conflict.detected_at).toLocaleString()}
            </p>

            {!remotePayload && (
              <p style={{ color: 'var(--mikaju-danger)', fontSize: 13 }}>
                This record was deleted elsewhere since your last sync.
              </p>
            )}

            {rows.length > 0 ? (
              <table className="mk-table" style={{ marginBottom: 16 }}>
                <thead>
                  <tr><th>Field</th><th>Your version</th><th>Their version</th></tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key}>
                      <td>{row.key}</td>
                      <td>{formatValue(row.localVal)}</td>
                      <td>{remotePayload ? formatValue(row.remoteVal) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ color: '#7a8a80', fontSize: 13 }}>
                No field differences to show — the conflict was on a field not listed above.
              </p>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                className="mk-btn"
                disabled={isResolving}
                onClick={() => resolve(conflict.id, 'keepLocal')}
              >
                {isResolving ? 'Working…' : remotePayload ? 'Keep my version' : 'Recreate my version'}
              </button>
              <button
                className="mk-btn mk-btn-secondary"
                disabled={isResolving}
                onClick={() => resolve(conflict.id, 'acceptRemote')}
              >
                {isResolving ? 'Working…' : remotePayload ? 'Use their version' : 'Delete my version too'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
