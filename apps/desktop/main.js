/**
 * Electron main process — Mikaju Payroll.
 *
 * Owns: BrowserWindow, local SQLite database, Supabase client, sync engine.
 * The renderer never touches any of these directly — everything crosses
 * through preload.js via contextBridge IPC.
 */
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getSupabaseClient } = require('./supabaseClient');
const { initDatabase, getDb, newId, writeRecord } = require('./db');
const { runSync, registerPeriodicSync } = require('./sync/syncEngine');
const { getCurrentEntitlement } = require('./license/licenseManager');
const { calculatePayroll, COUNTRIES } = require('@mikaju/tax-engine');
const { generatePayslipPdf } = require('./pdf/payslipGenerator');

const isDev = !app.isPackaged;
let mainWindow;
let activeCompanyId = null;
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
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
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
    const record = { id: newId(), version: 1, created_at: now, updated_at: now, ...company };
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

  ipcMain.handle('payrollRuns:list', (_e, companyId) =>
    getDb().prepare('select * from payroll_runs where company_id = ? order by period_year desc, period_month desc')
      .all(companyId)
  );

  ipcMain.handle('payrollRuns:create', (_e, { companyId, periodMonth, periodYear }) => {
    const now = new Date().toISOString();
    const record = { id: newId(), company_id: companyId, period_month: periodMonth, period_year: periodYear, status: 'draft', approved_by: null, approved_at: null, created_at: now, updated_at: now };
    writeRecord('payroll_runs', 'insert', record);
    return record;
  });

  // Runs the versioned tax engine for one employee. Renderer never imports
  // @mikaju/tax-engine directly — it always goes through here, so there is
  // exactly one place in the whole app that produces a payslip breakdown.
  ipcMain.handle('payroll:calculate', (_e, { grossPay, countryCode, options }) => {
    return calculatePayroll({ grossPay, ...options }, countryCode);
  });

  // Generates (or regenerates, while the run is still 'draft') a payslip
  // row per active employee for a run, using each employee's current
  // gross pay and the company's country. Does NOT lock the run — that is
  // a separate, explicit approval step so a run can be reviewed first.
  ipcMain.handle('payslips:generateForRun', (_e, { payrollRunId, companyId, countryCode }) => {
    const run = getDb().prepare('select status from payroll_runs where id = ?').get(payrollRunId);
    if (run && run.status === 'locked') {
      throw new Error('This payroll run is locked and approved — it cannot be recalculated. Create a new run instead.');
    }

    // Regeneration replaces prior draft payslips for this run rather than
    // duplicating them, so re-running the wizard after editing an
    // employee's gross pay reflects the correction instead of adding rows.
    // Goes through writeRecord (not a raw DELETE) so the deletion is queued
    // for remote sync too, not just applied locally.
    const priorPayslips = getDb().prepare('select id from payslips where payroll_run_id = ?').all(payrollRunId);
    for (const p of priorPayslips) writeRecord('payslips', 'delete', { id: p.id });

    const employees = getDb()
      .prepare('select * from employees where company_id = ? and status = ?')
      .all(companyId, 'active');

    const now = new Date().toISOString();
    const payslips = employees.map((employee) => {
      const breakdown = calculatePayroll({ grossPay: employee.gross_pay }, countryCode);
      const record = {
        id: newId(),
        payroll_run_id: payrollRunId,
        employee_id: employee.id,
        breakdown_json: JSON.stringify(breakdown),
        net_pay: breakdown.netPay,
        version: 1,
        created_at: now,
        updated_at: now,
      };
      writeRecord('payslips', 'insert', record);
      return record;
    });

    writeRecord('payroll_runs', 'update', {
      id: payrollRunId,
      status: 'reviewed',
      updated_at: now,
    });

    return payslips;
  });

  // Approval is the final, irreversible step: it also locks the run.
  // Once locked, payslips.generateForRun refuses to touch that run again
  // (see the guard there) — a locked run's numbers are what got paid.
  ipcMain.handle('payrollRuns:approve', (_e, { payrollRunId, approvedBy }) => {
    const now = new Date().toISOString();
    const record = { id: payrollRunId, status: 'locked', approved_by: approvedBy, approved_at: now, updated_at: now };
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

  ipcMain.on('network:statusChanged', (_e, isOnline) => {
    const supabase = getSupabaseClient();
    if (isOnline && supabase && activeCompanyId) {
      runSync(supabase, activeCompanyId).catch(err => console.error('Reconnect sync failed:', err));
    }
  });
}

app.whenReady().then(() => {
  initDatabase(app.getPath('userData'));
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
