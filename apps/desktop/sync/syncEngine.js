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
 * Conflict rule (Phase 1): last-write-wins by `version`. A row is only
 * applied locally if its remote `version` is >= the local `version`. This is
 * intentionally simple for Phase 1 — Phase 2 adds a conflict-resolution UI
 * for the case where both sides changed the same employee between syncs.
 */

const SYNCED_TABLES = ['companies', 'employees', 'payroll_runs', 'payslips'];
const MAX_PUSH_ATTEMPTS = 5;

async function pushOutbox(supabase) {
  const { getDb } = require('../db');
  const db = getDb();
  const rows = db.prepare('select * from sync_queue order by id asc').all();

  const results = { pushed: 0, failed: 0 };

  for (const row of rows) {
    const payload = JSON.parse(row.payload_json);
    let error = null;

    if (row.op === 'delete') {
      ({ error } = await supabase.from(row.table_name).delete().eq('id', row.record_id));
    } else {
      // insert and update both resolve to an upsert remotely — the local op
      // already enforced insert-vs-update semantics against SQLite.
      ({ error } = await supabase.from(row.table_name).upsert(payload));
    }

    if (error) {
      results.failed++;
      const attempts = row.attempts + 1;
      if (attempts >= MAX_PUSH_ATTEMPTS) {
        // Give up on this row so it doesn't block the rest of the queue
        // forever; surface it for the user to see in a sync-status screen.
        db.prepare('update sync_queue set attempts = ?, last_error = ? where id = ?')
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
    const filterCol = table === 'companies' ? 'id' : 'company_id';
    const filterVal = table === 'companies' ? companyId : companyId;

    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq(filterCol, filterVal)
      .gt('updated_at', since);

    if (error) {
      results[table] = { error: error.message };
      continue;
    }

    let applied = 0;
    const upsertTx = db.transaction((records) => {
      for (const remote of records) {
        const local = db.prepare(`select version from ${table} where id = ?`).get(remote.id);
        if (local && local.version > remote.version) continue; // local is newer, skip

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
