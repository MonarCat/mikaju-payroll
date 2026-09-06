/**
 * Sync engine — Mikaju Payroll.
 *
 * Offline-first: the desktop app always writes to local SQLite first
 * (db.writeRecord), and this module reconciles that with Supabase whenever
 * a connection is available. Three phases, always in this order:
 *
 *   1. PUSH   — drain sync_queue to Supabase (oldest first)
 *   2. PULL   — fetch remote rows changed since last pull, upsert locally
 *   3. LICENSE — refresh the signed entitlement token via license-issue
 *
 * Conflict handling (Phase 1): real optimistic concurrency for tables
 * that carry a `version` column on both sides (VERSIONED_TABLES below).
 * An update only applies remotely if the row is still at the version
 * this device last saw — `UPDATE ... WHERE id = ? AND version = ?`. If
 * zero rows match, someone else changed it first: the conflict is
 * recorded in sync_conflicts with both payloads, and the queue entry is
 * marked 'conflict', not silently retried and not silently overwritten.
 * A duplicate-key error on an insert (two devices creating the same
 * payroll period offline, for instance) is handled the same way.
 *
 * Tables without a version column (companies, payslips) fall back to a
 * plain upsert — there's no structural way to detect a conflict without
 * one. This is a deliberate, documented limit, not an oversight:
 * companies is single-record-per-install and rarely edited concurrently
 * in practice; payslips are immutable snapshots regenerated wholesale
 * (never partially edited), so the only real conflict there is two
 * devices generating for the same run offline — which the duplicate-key
 * handling below already catches.
 */

const SYNCED_TABLES = ['companies', 'employees', 'payroll_runs', 'payslips'];
const MAX_PUSH_ATTEMPTS = 5;

// Tables with a `version` column on BOTH sides — local SQLite (see
// db/migrations.js v2/v4) and the cloud `mikaju` schema. Only these
// support the version-match conditional update below; the others are
// covered by the class doc comment above.
const VERSIONED_TABLES = new Set(['employees', 'payroll_runs']);

function isUniqueViolation(error) {
  return !!error && /duplicate key value violates unique constraint/.test(error.message);
}

/**
 * Records a push conflict durably and marks the queue row so it's never
 * silently retried or silently dropped. remotePayload may be null if the
 * remote row couldn't be re-fetched (network hiccup right after the
 * conflict was detected) — the local payload alone is still enough for a
 * person to see that a conflict happened and decide what to do.
 */
function recordConflict(db, newId, row, remotePayload) {
  db.prepare(
    `insert into sync_conflicts (id, table_name, record_id, local_payload, remote_payload, detected_at)
     values (?,?,?,?,?,?)`
  ).run(newId(), row.table_name, row.record_id, row.payload_json, remotePayload ? JSON.stringify(remotePayload) : null, new Date().toISOString());

  db.prepare("update sync_queue set status = 'conflict', last_error = ? where id = ?").run(
    'This record was changed elsewhere since your last sync. See Sync Conflicts to resolve.',
    row.id
  );
}

async function pushOutbox(supabase) {
  const { getDb, newId } = require('../db');
  const db = getDb();
  // 'failed' rows have already exhausted MAX_PUSH_ATTEMPTS and 'conflict'
  // rows are waiting on a person to resolve them — neither should be
  // retried automatically. Before this status column existed, this query
  // had no filter at all, so a row that had supposedly "given up" kept
  // being retried on every single sync regardless.
  const rows = db.prepare("select * from sync_queue where status = 'pending' order by id asc").all();

  const results = { pushed: 0, failed: 0, conflicts: 0 };

  for (const row of rows) {
    const payload = JSON.parse(row.payload_json);
    let error = null;
    let conflicted = false;

    if (row.op === 'delete') {
      ({ error } = await supabase.from(row.table_name).delete().eq('id', row.record_id));
    } else if (row.op === 'insert') {
      ({ error } = await supabase.from(row.table_name).insert(payload));
      if (isUniqueViolation(error)) conflicted = true;
    } else if (VERSIONED_TABLES.has(row.table_name)) {
      // Real optimistic concurrency: local writes always increment
      // `version` (see main.js), so payload.version - 1 is exactly the
      // version this device last knew the row to be at. Only apply the
      // update if the remote row is still at that version.
      const expectedPriorVersion = payload.version - 1;
      const { data: updatedRows, error: updateError } = await supabase
        .from(row.table_name)
        .update(payload)
        .eq('id', row.record_id)
        .eq('version', expectedPriorVersion)
        .select('id');
      error = updateError;
      if (!error && (!updatedRows || updatedRows.length === 0)) conflicted = true;
    } else {
      // No version column on this table (see class doc comment above) —
      // no structural way to detect a conflict, so this is a plain
      // last-write-wins upsert.
      ({ error } = await supabase.from(row.table_name).upsert(payload));
    }

    if (conflicted) {
      const { data: remoteRow } = await supabase.from(row.table_name).select('*').eq('id', row.record_id).maybeSingle();
      recordConflict(db, newId, row, remoteRow || null);
      results.conflicts++;
      continue;
    }

    if (error) {
      results.failed++;
      const attempts = row.attempts + 1;
      if (attempts >= MAX_PUSH_ATTEMPTS) {
        // Actually excluded from the next retry now (see the query at
        // the top of this function) — not just labeled as given-up while
        // still being retried anyway.
        db.prepare("update sync_queue set attempts = ?, status = 'failed', last_error = ? where id = ?")
          .run(attempts, `Gave up after ${attempts} attempts: ${error.message}`, row.id);
      } else {
        db.prepare('update sync_queue set attempts = ?, last_error = ? where id = ?')
          .run(attempts, error.message, row.id);
      }
    } else {
      results.pushed++;
      db.prepare('delete from sync_queue where id = ?').run(row.id);
    }
  }

  return results;
}

async function pullRemote(supabase, companyId) {
  const { getDb } = require('../db');
  const db = getDb();
  const results = {};

  const lastPullRow = db.prepare("select value from app_meta where key = 'last_pull_at'").get();
  const since = lastPullRow ? lastPullRow.value : '1970-01-01T00:00:00.000Z';

  for (const table of SYNCED_TABLES) {
    let data, error;

    if (table === 'payslips') {
      // payslips has neither a company_id column nor an updated_at
      // column in the cloud schema — it's scoped through payroll_runs,
      // and rows are immutable once created (frozen at generation),
      // so created_at is the right change cursor instead.
      const { data: runRows, error: runError } = await supabase
        .from('payroll_runs')
        .select('id')
        .eq('company_id', companyId);
      if (runError) {
        results[table] = { error: runError.message };
        continue;
      }
      const runIds = (runRows || []).map((r) => r.id);
      if (runIds.length === 0) {
        results[table] = { pulled: 0, applied: 0 };
        continue;
      }
      ({ data, error } = await supabase
        .from(table)
        .select('*')
        .in('payroll_run_id', runIds)
        .gt('created_at', since));
    } else {
      const filterCol = table === 'companies' ? 'id' : 'company_id';
      ({ data, error } = await supabase
        .from(table)
        .select('*')
        .eq(filterCol, companyId)
        .gt('updated_at', since));
    }

    if (error) {
      results[table] = { error: error.message };
      continue;
    }

    let applied = 0;
    const upsertTx = db.transaction((records) => {
      for (const remote of records) {
        if (VERSIONED_TABLES.has(table)) {
          const local = db.prepare(`select version from ${table} where id = ?`).get(remote.id);
          if (local && local.version > remote.version) continue; // local is newer, skip
        }

        const cols = Object.keys(remote);
        const placeholders = cols.map(() => '?').join(',');
        const updateClause = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
        db.prepare(
          `insert into ${table} (${cols.join(',')}) values (${placeholders})
           on conflict(id) do update set ${updateClause}`
        ).run(...cols.map((c) => remote[c]));
        applied++;
      }
    });
    upsertTx(data || []);
    results[table] = { pulled: (data || []).length, applied };
  }

  db.prepare(
    "insert into app_meta (key,value) values ('last_pull_at',?) on conflict(key) do update set value=excluded.value"
  ).run(new Date().toISOString());

  return results;
}

async function refreshLicense(supabase, companyId) {
  const { setCachedEntitlement } = require('../license/licenseManager');
  try {
    // license-issue requires company_id in the body (it 400s without it)
    // and an Authorization header with the calling user's real JWT (it
    // uses that + RLS to confirm this user actually has access to this
    // company). The Authorization header itself is attached automatically
    // by supabase-js IF this client instance has an active session — see
    // main.js's auth:sessionChanged handler, which is what puts one there.
    const { data, error } = await supabase.functions.invoke('license-issue', { body: { company_id: companyId } });
    if (error) return { refreshed: false, reason: error.message };
    setCachedEntitlement(data);
    return { refreshed: true };
  } catch (err) {
    // No connection, or edge function unreachable — not fatal, we keep
    // using the last cached (and still cryptographically valid) token.
    return { refreshed: false, reason: err.message };
  }
}

async function runSync(supabase, companyId) {
  if (!supabase) return { skipped: true, reason: 'No Supabase client (offline mode).' };
  if (!companyId) return { skipped: true, reason: 'No active company set.' };

  const push = await pushOutbox(supabase);
  const pull = await pullRemote(supabase, companyId);
  const license = await refreshLicense(supabase, companyId);

  return { ranAt: new Date().toISOString(), push, pull, license };
}

/**
 * Registers a periodic background sync (every 5 minutes) while the app is
 * open. Returns the interval handle so main.js can clear it on quit.
 */
function registerPeriodicSync(supabase, getActiveCompanyId, intervalMs = 5 * 60 * 1000) {
  return setInterval(() => {
    const companyId = getActiveCompanyId();
    if (companyId) {
      runSync(supabase, companyId).catch((err) => console.error('Periodic sync failed:', err));
    }
  }, intervalMs);
}

module.exports = { runSync, registerPeriodicSync, pushOutbox, pullRemote, refreshLicense };
