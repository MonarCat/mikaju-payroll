/**
 * Preload — Mikaju Payroll.
 *
 * contextIsolation is on and nodeIntegration is off (see main.js), so this
 * is the ONLY place the renderer touches anything Node/Electron-flavored.
 * Every function here is a thin wrapper around ipcRenderer — no business
 * logic lives here, only the whitelist of what the UI is allowed to call.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mikaju', {
  countries: {
    list: () => ipcRenderer.invoke('countries:list'),
  },
  companies: {
    get: () => ipcRenderer.invoke('companies:get'),
    create: (company) => ipcRenderer.invoke('companies:create', company),
  },
  employees: {
    list: (companyId) => ipcRenderer.invoke('employees:list', companyId),
    create: (employee) => ipcRenderer.invoke('employees:create', employee),
    update: (employee) => ipcRenderer.invoke('employees:update', employee),
  },
  payrollRuns: {
    list: (companyId) => ipcRenderer.invoke('payrollRuns:list', companyId),
    create: (args) => ipcRenderer.invoke('payrollRuns:create', args),
    approve: (args) => ipcRenderer.invoke('payrollRuns:approve', args),
  },
  payroll: {
    calculate: (args) => ipcRenderer.invoke('payroll:calculate', args),
  },
  payslips: {
    generateForRun: (args) => ipcRenderer.invoke('payslips:generateForRun', args),
    generatePdf: (args) => ipcRenderer.invoke('payslips:generatePdf', args),
  },
  files: {
    // Electron removed File.path from renderer-side File objects as a
    // security hardening (sandbox: true in main.js means it was never
    // available here to begin with) — webUtils.getPathForFile is the
    // supported replacement for "user picked a file, I need its disk path".
    getPathForFile: (file) => webUtils.getPathForFile(file),
    openPath: (filePath) => ipcRenderer.invoke('files:openPath', filePath),
  },
  license: {
    getEntitlement: () => ipcRenderer.invoke('license:getEntitlement'),
  },
  sync: {
    now: () => ipcRenderer.invoke('sync:now'),
    setActiveCompany: (companyId) => ipcRenderer.invoke('sync:setActiveCompany', companyId),
    onStatusChanged: (callback) => {
      const listener = (_e, status) => callback(status);
      ipcRenderer.on('sync:statusChanged', listener);
      return () => ipcRenderer.removeListener('sync:statusChanged', listener);
    },
  },
  auth: {
    // The main process's Supabase client is a SEPARATE instance from the
    // renderer's — it never receives a session just because the renderer
    // signed in. license-issue (and any future RLS-scoped call from main)
    // needs a real user JWT, so the renderer forwards its session here
    // every time it changes (sign in, token refresh, sign out).
    syncSession: (session) => ipcRenderer.send('auth:sessionChanged', session),
  },
  network: {
    reportStatusChanged: (isOnline) => ipcRenderer.send('network:statusChanged', isOnline),
  },
});
