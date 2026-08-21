/**
 * Electron main process — Mikaju Payroll.
 *
 * Owns: BrowserWindow, local SQLite database, Supabase client, sync engine.
 * The renderer never touches any of these directly — everything crosses
 * through preload.js via contextBridge IPC.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getSupabaseClient } = require('./supabaseClient');
const { initDatabase, getDb, newId, writeRecord } = require('./db');
const { runSync, registerPeriodicSync } = require('./sync/syncEngine');
const { getCurrentEntitlement } = require('./license/licenseManager');

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

  ipcMain.handle('license:getEntitlement', () => getCurrentEntitlement());

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
