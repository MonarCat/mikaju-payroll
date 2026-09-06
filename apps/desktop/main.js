/**
 * Electron main process — Mikaju Payroll.
 *
 * Owns: BrowserWindow, local SQLite database, Supabase client, sync engine.
 * The renderer never touches any of these directly — everything crosses
 * through preload.js via contextBridge IPC.
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getSupabaseClient } = require('./supabaseClient');
const { initDatabase, getDb, newId, writeRecord, writeRecordsAtomic } = require('./db');
const { getOrCreateDbKey } = require('./db/keyManager');
const { runSync, registerPeriodicSync } = require('./sync/syncEngine');
const { getCurrentEntitlement } = require('./license/licenseManager');
const { calculatePayroll, COUNTRIES } = require('@mikaju/tax-engine');
const { generatePayslipPdf } = require('./pdf/payslipGenerator');

function round2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * employees.other_allowances is stored as a JSON array of
 * { label, amount } (or similar) objects, matching the cloud schema's
 * jsonb column. Sums the amounts for use as part of gross pay. Returns
 * 0 for anything that isn't a clean array — a malformed value here
 * should never block payroll calculation.
 */
function safeParseAmountList(jsonText) {
  try {
    const list = JSON.parse(jsonText || '[]');
    if (!Array.isArray(list)) return 0;
    return list.reduce((sum, item) => sum + (Number(item?.amount) || 0), 0);
  } catch {
    return 0;
  }
}

/**
 * Unpacks a calculatePayroll() breakdown into the payslips table's
 * structured columns (matching the cloud schema, which breaks each
 * statutory deduction into its own column rather than one JSON blob).
 * This assumes the Kenya-shaped breakdown
 * (statutoryDeductions.{nssf,shif,ahl,paye}) — the only country this
 * product currently issues real payroll for. Every structured field
 * defaults to 0 if a different country module's breakdown doesn't use
 * that shape, but calculation_snapshot always keeps the FULL original
 * breakdown regardless, so nothing is lost even then — see the matching
 * note in db/migrations.js's payslips migration.
 */
function buildPayslipRecord(payrollRunId, employeeId, breakdown, now) {
  const sd = breakdown.statutoryDeductions || {};
  return {
    id: newId(),
    payroll_run_id: payrollRunId,
    employee_id: employeeId,
    gross_pay: breakdown.grossPay,
    pensionable_pay: breakdown.grossPay,
    nssf_employee: sd.nssf?.totalEmployee ?? 0,
    nssf_employer: sd.nssf?.totalEmployer ?? 0,
    shif: sd.shif?.employee ?? 0,
    housing_levy_employee: sd.ahl?.employee ?? 0,
    housing_levy_employer: sd.ahl?.employer ?? 0,
    paye: sd.paye?.employee ?? 0,
    other_deductions: JSON.stringify(breakdown.otherDeductions || []),
    net_pay: breakdown.netPay,
    employer_cost: breakdown.employerCost,
    calculation_snapshot: JSON.stringify(breakdown),
    created_at: now,
  };
}

const isDev = !app.isPackaged;
let mainWindow;
let activeCompanyId = null;
let activeUserId = null;
let periodicSyncHandle = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1024, minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
  }
}

function registerIpcHandlers() {
  ipcMain.handle('countries:list', () => COUNTRIES);

  ipcMain.handle('companies:get', () => {
    if (!activeCompanyId) return null;
    return getDb().prepare('select * from companies where id = ?').get(activeCompanyId);
  });

  ipcMain.handle('companies:create', (_e, company) => {
    const now = new Date().toISOString();
    const record = { id: newId(), created_at: now, updated_at: now, ...company };
    writeRecord('companies', 'insert', record);
    activeCompanyId = record.id;
    getDb().prepare(
      "insert into app_meta (key,value) values ('active_company_id',?) on conflict(key) do update set value=excluded.value"
    ).run(record.id);
    return record;
  });

  ipcMain.handle('employees:list', (_e, companyId) =>
    getDb().prepare('select * from employees where company_id = ? and status = ? order by full_name')
      .all(companyId, 'active')
  );

  ipcMain.handle('employees:create', (_e, employee) => {
    const entitlement = getCurrentEntitlement();
    if (entitlement.employeeLimit !== null) {
      const activeCount = getDb()
        .prepare('select count(*) as n from employees where company_id = ? and status = ?')
        .get(employee.company_id, 'active').n;
      if (activeCount >= entitlement.employeeLimit) {
        throw new Error(
          `Your ${entitlement.plan} plan is limited to ${entitlement.employeeLimit} employees. Upgrade to add more.`
        );
      }
    }
    const now = new Date().toISOString();
    const record = { id: newId(), version: 1, created_at: now, updated_at: now, ...employee };
    writeRecord('employees', 'insert', record);
    return record;
  });

  ipcMain.handle('employees:update', (_e, employee) => {
    const record = { ...employee, version: (employee.version || 1) + 1, updated_at: new Date().toISOString() };
    writeRecord('employees', 'update', record);
    return record;
  });

  ipcMain.handle('payrollRuns:list', () => {
    if (!activeCompanyId) return [];
    return getDb().prepare('select * from payroll_runs where company_id = ? order by period_year desc, period_month desc')
      .all(activeCompanyId);
  });

  // company_id is the ACTIVE company tracked by main.js, not whatever the
  // renderer happens to pass — a payroll run for the wrong company is
  // exactly the kind of bug that should be impossible by construction,
  // not just "the UI wouldn't normally do that".
  ipcMain.handle('payrollRuns:create', (_e, { periodMonth, periodYear }) => {
    if (!activeCompanyId) throw new Error('No active company selected.');
    const now = new Date().toISOString();
    const record = {
      id: newId(), company_id: activeCompanyId, period_month: periodMonth, period_year: periodYear,
      status: 'draft', approved_by: null, approved_at: null, version: 1, created_at: now, updated_at: now,
    };
    try {
      writeRecord('payroll_runs', 'insert', record);
    } catch (err) {
      // Translates the raw UNIQUE(company_id, period_year, period_month)
      // constraint (see db/migrations.js) into something a payroll admin
      // can actually act on, instead of a bare SQLite error string.
      if (/UNIQUE constraint failed/.test(err.message)) {
        throw new Error(`A payroll run for ${periodMonth}/${periodYear} already exists for this company.`);
      }
      throw err;
    }
    return record;
  });

  // Runs the versioned tax engine for one employee. Renderer never imports
  // @mikaju/tax-engine directly — it always goes through here, so there is
  // exactly one place in the whole app that produces a payslip breakdown.
  ipcMain.handle('payroll:calculate', (_e, { grossPay, countryCode, options }) => {
    return calculatePayroll({ grossPay, ...options }, countryCode);
  });

  // Generates (or regenerates, while the run isn't locked) a payslip row
  // per active employee for a run, using each employee's current gross
  // pay and the company's country. Does NOT lock the run — that is a
  // separate, explicit approval step so a run can be reviewed first.
  //
  // country_code is looked up from the run's own company record here,
  // never accepted from the renderer: a payroll run belongs to exactly
  // one company, and that company has exactly one country. Letting a
  // caller pass a different countryCode is how you get a Kenyan
  // employee's payslip calculated under Ugandan tax rules.
  //
  // The delete-old / insert-new / mark-reviewed sequence is one atomic
  // transaction (writeRecordsAtomic) — a crash or forced quit partway
  // through leaves the run exactly as it was before this call, never a
  // run with payslips for some employees and not others.
  ipcMain.handle('payslips:generateForRun', (_e, { payrollRunId }) => {
    const db = getDb();
    const run = db.prepare('select * from payroll_runs where id = ?').get(payrollRunId);
    if (!run) throw new Error('Payroll run not found.');
    if (run.company_id !== activeCompanyId) {
      throw new Error('This payroll run does not belong to the active company.');
    }
    if (run.status === 'locked') {
      throw new Error('This payroll run is locked and approved — it cannot be recalculated. Create a new run instead.');
    }

    const company = db.prepare('select * from companies where id = ?').get(run.company_id);
    if (!company) throw new Error('Company record for this payroll run is missing.');
    const countryCode = company.country_code;

    const priorPayslips = db.prepare('select id from payslips where payroll_run_id = ?').all(payrollRunId);
    const employees = db
      .prepare('select * from employees where company_id = ? and status = ?')
      .all(run.company_id, 'active');

    const now = new Date().toISOString();
    const ops = priorPayslips.map((p) => ({ tableName: 'payslips', op: 'delete', record: { id: p.id } }));

    const payslips = employees.map((employee) => {
      // Gross pay is basic salary plus housing allowance plus any other
      // allowances — the tax engine only ever sees one combined number,
      // matching how basic_salary/housing_allowance/other_allowances are
      // split out for record-keeping but taxed together.
      const otherAllowancesTotal = safeParseAmountList(employee.other_allowances);
      const grossPay = round2(employee.basic_salary + employee.housing_allowance + otherAllowancesTotal);

      const breakdown = calculatePayroll({ grossPay }, countryCode);
      const record = buildPayslipRecord(payrollRunId, employee.id, breakdown, now);
      ops.push({ tableName: 'payslips', op: 'insert', record });
      return record;
    });

    // version increments on every write to this row (insert = 1) so the
    // sync engine's optimistic-concurrency check (payload.version - 1 =
    // the version this device last knew about) stays correct even across
    // this delete/insert/status-update batch.
    ops.push({ tableName: 'payroll_runs', op: 'update', record: { id: payrollRunId, status: 'approved', version: run.version + 1, updated_at: now } });

    writeRecordsAtomic(ops);

    return payslips;
  });

  // Approval is the final, irreversible step: it also locks the run.
  // Once locked, payslips.generateForRun refuses to touch that run again
  // (see the guard there) — a locked run's numbers are what got paid.
  //
  // approved_by is the authenticated user id from the Supabase session
  // forwarded via auth:sessionChanged (see below), never a value the
  // renderer supplies — "approved by company X" isn't an audit trail,
  // "approved by user <uuid>, signed in as <email>" is.
  ipcMain.handle('payrollRuns:approve', (_e, { payrollRunId }) => {
    if (!activeUserId) throw new Error('You must be signed in to approve a payroll run.');

    const db = getDb();
    const run = db.prepare('select * from payroll_runs where id = ?').get(payrollRunId);
    if (!run) throw new Error('Payroll run not found.');
    if (run.company_id !== activeCompanyId) {
      throw new Error('This payroll run does not belong to the active company.');
    }
    if (run.status === 'locked') throw new Error('This payroll run is already approved and locked.');
    if (run.status !== 'approved') throw new Error('Calculate this payroll run before approving it.');

    const payslipCount = db.prepare('select count(*) as n from payslips where payroll_run_id = ?').get(payrollRunId).n;
    const activeEmployeeCount = db
      .prepare('select count(*) as n from employees where company_id = ? and status = ?')
      .get(run.company_id, 'active').n;
    if (payslipCount === 0) throw new Error('This payroll run has no payslips yet — calculate it first.');
    if (payslipCount !== activeEmployeeCount) {
      throw new Error(
        `This run has payslips for ${payslipCount} of ${activeEmployeeCount} active employees — ` +
        'recalculate the run before approving (an employee may have been added or reactivated since).'
      );
    }

    const now = new Date().toISOString();
    const record = { id: payrollRunId, status: 'locked', approved_by: activeUserId, approved_at: now, version: run.version + 1, updated_at: now };
    writeRecord('payroll_runs', 'update', record);
    return record;
  });

  ipcMain.handle('license:getEntitlement', () => getCurrentEntitlement());

  // Renders one payslip to a PDF on disk and returns its path. Watermarking
  // is decided entirely inside generatePayslipPdf, based on the caller's
  // CURRENT entitlement — not whatever plan was active when the run was
  // calculated. If someone upgrades mid-month, payslips they (re)download
  // afterward come out clean even for an already-locked run.
  ipcMain.handle('payslips:generatePdf', async (_e, { payslipId }) => {
    const db = getDb();
    const payslip = db.prepare('select * from payslips where id = ?').get(payslipId);
    if (!payslip) throw new Error(`Payslip ${payslipId} not found.`);

    const run = db.prepare('select * from payroll_runs where id = ?').get(payslip.payroll_run_id);
    const employee = db.prepare('select * from employees where id = ?').get(payslip.employee_id);
    const companyRow = db.prepare('select * from companies where id = ?').get(run.company_id);
    const entitlement = getCurrentEntitlement();

    const periodLabel = new Date(run.period_year, run.period_month - 1, 1)
      .toLocaleString('en', { month: 'long', year: 'numeric' });

    const pdfBytes = await generatePayslipPdf({
      company: companyRow,
      employee,
      payslip,
      plan: entitlement.plan,
      periodLabel,
    });

    const outDir = path.join(app.getPath('documents'), 'Mikaju Payslips');
    fs.mkdirSync(outDir, { recursive: true });
    const safeName = employee.full_name.replace(/[^a-z0-9]+/gi, '_');
    const outPath = path.join(outDir, `${safeName}_${run.period_year}-${String(run.period_month).padStart(2, '0')}.pdf`);
    fs.writeFileSync(outPath, pdfBytes);

    return outPath;
  });

  ipcMain.handle('files:openPath', (_e, filePath) => shell.openPath(filePath));

  ipcMain.handle('sync:now', async () => {
    const supabase = getSupabaseClient();
    if (!supabase || !activeCompanyId) return { skipped: true, reason: 'Offline or no active company.' };
    return runSync(supabase, activeCompanyId);
  });

  ipcMain.handle('sync:setActiveCompany', (_e, companyId) => {
    activeCompanyId = companyId;
    getDb().prepare("insert into app_meta (key,value) values ('active_company_id',?) on conflict(key) do update set value=excluded.value").run(companyId);
  });

  // Unresolved conflicts only — once resolved, they stay in sync_conflicts
  // for audit history but shouldn't keep surfacing in a "needs attention" list.
  ipcMain.handle('sync:listConflicts', () => {
    return getDb().prepare('select * from sync_conflicts where resolved_at is null order by detected_at desc').all();
  });

  // Two resolution strategies, both explicit — a conflict on payroll data
  // is never auto-resolved by picking a side for the person.
  //
  //   acceptRemote: discard this device's conflicting change; pull in
  //   whatever is currently on the server for that row.
  //
  //   keepLocal: re-enqueue this device's change as a fresh update
  //   against the row's CURRENT remote version (re-fetched here, not
  //   assumed), so the next sync's version check succeeds instead of
  //   conflicting again on stale information.
  ipcMain.handle('sync:resolveConflict', async (_e, { conflictId, strategy }) => {
    const db = getDb();
    const conflict = db.prepare('select * from sync_conflicts where id = ?').get(conflictId);
    if (!conflict) throw new Error('Conflict not found.');
    if (conflict.resolved_at) throw new Error('This conflict was already resolved.');
    if (!activeUserId) throw new Error('You must be signed in to resolve a sync conflict.');

    const supabase = getSupabaseClient();
    if (!supabase) throw new Error('Cannot resolve a conflict while offline — reconnect first.');

    if (strategy === 'acceptRemote') {
      const { data: remoteRow, error } = await supabase
        .from(conflict.table_name)
        .select('*')
        .eq('id', conflict.record_id)
        .maybeSingle();
      if (error) throw new Error(`Could not fetch the current remote row: ${error.message}`);
      if (remoteRow) {
        const cols = Object.keys(remoteRow);
        const placeholders = cols.map(() => '?').join(',');
        const updateClause = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
        db.prepare(
          `insert into ${conflict.table_name} (${cols.join(',')}) values (${placeholders})
           on conflict(id) do update set ${updateClause}`
        ).run(...cols.map((c) => remoteRow[c]));
      } else {
        // Remote row is gone entirely (deleted by whoever won the race) —
        // remove the local copy too so it doesn't linger as a ghost.
        db.prepare(`delete from ${conflict.table_name} where id = ?`).run(conflict.record_id);
      }
      db.prepare("delete from sync_queue where table_name = ? and record_id = ? and status = 'conflict'")
        .run(conflict.table_name, conflict.record_id);
    } else if (strategy === 'keepLocal') {
      const localPayload = JSON.parse(conflict.local_payload);
      const { data: remoteRow, error } = await supabase
        .from(conflict.table_name)
        .select('version')
        .eq('id', conflict.record_id)
        .maybeSingle();
      if (error) throw new Error(`Could not fetch the current remote version: ${error.message}`);
      const now = new Date().toISOString();
      const requeued = { ...localPayload, version: (remoteRow?.version || 0) + 1, updated_at: now };
      db.prepare("delete from sync_queue where table_name = ? and record_id = ? and status = 'conflict'")
        .run(conflict.table_name, conflict.record_id);
      db.prepare(
        `insert into sync_queue (table_name, op, record_id, payload_json, created_at) values (?,?,?,?,?)`
      ).run(conflict.table_name, 'update', conflict.record_id, JSON.stringify(requeued), now);
      // Reflect the bumped version locally too, so this device's own copy
      // matches what it's about to (re-)push.
      db.prepare(`update ${conflict.table_name} set version = ?, updated_at = ? where id = ?`)
        .run(requeued.version, now, conflict.record_id);
    } else {
      throw new Error(`Unknown resolution strategy "${strategy}". Expected "acceptRemote" or "keepLocal".`);
    }

    db.prepare('update sync_conflicts set resolved_at = ?, resolved_by = ? where id = ?')
      .run(new Date().toISOString(), activeUserId, conflictId);

    return { resolved: true, strategy };
  });

  ipcMain.on('network:statusChanged', (_e, isOnline) => {
    const supabase = getSupabaseClient();
    if (isOnline && supabase && activeCompanyId) {
      runSync(supabase, activeCompanyId).catch(err => console.error('Reconnect sync failed:', err));
    }
  });

  // Forwarded from the renderer's own Supabase Auth session (see preload.js
  // auth.syncSession). Without this, the main process's Supabase client
  // never has a real user JWT, and any RLS-scoped call it makes — most
  // importantly license-issue — fails with 401 every time, silently.
  ipcMain.on('auth:sessionChanged', (_e, session) => {
    activeUserId = session?.user?.id || null;
    const supabase = getSupabaseClient();
    if (!supabase) return;
    if (session?.access_token && session?.refresh_token) {
      supabase.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token })
        .catch(err => console.error('Failed to sync auth session to main process:', err));
    } else {
      supabase.auth.signOut().catch(() => {});
    }
  });
}

app.whenReady().then(() => {
  // Database encryption is a hard prerequisite, not a best-effort feature:
  // if we can't get a key, we refuse to start rather than silently opening
  // (or worse, creating) an unencrypted payroll database.
  let dbKey;
  try {
    dbKey = getOrCreateDbKey(app.getPath('userData'));
    initDatabase(app.getPath('userData'), dbKey);
  } catch (err) {
    dialog.showErrorBox('Mikaju Payroll — cannot start', err.message);
    app.quit();
    return;
  }

  registerIpcHandlers();
  createWindow();

  const stored = getDb().prepare("select value from app_meta where key='active_company_id'").get();
  if (stored) activeCompanyId = stored.value;

  setTimeout(() => {
    const supabase = getSupabaseClient();
    if (supabase && activeCompanyId) {
      runSync(supabase, activeCompanyId).catch(err => console.error('Startup sync failed:', err));
    }
  }, 3000);

  const supabase = getSupabaseClient();
  if (supabase) periodicSyncHandle = registerPeriodicSync(supabase, () => activeCompanyId);
});

app.on('window-all-closed', () => {
  if (periodicSyncHandle) clearInterval(periodicSyncHandle);
  if (process.platform !== 'darwin') app.quit();
});
