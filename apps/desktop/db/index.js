/**
 * Local SQLite database — Mikaju Payroll.
 *
 * This is the offline source of truth. Every write goes here first (and only
 * here, if offline). writeRecord() also appends to sync_queue so syncEngine
 * can push it to Supabase whenever a connection is available.
 *
 * Schema mirrors the `mikaju` Postgres schema closely enough that pulled
 * rows can be upserted with minimal transformation, but this is SQLite —
 * types are simplified (TEXT for ids/timestamps, INTEGER for booleans).
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const crypto = require('crypto');

let _db = null;

function newId() {
  return crypto.randomUUID();
}

const SCHEMA = `
create table if not exists app_meta (
  key   text primary key,
  value text
);

create table if not exists companies (
  id            text primary key,
  name          text not null,
  country_code  text not null,
  kra_pin       text,
  logo_path     text,
  version       integer not null default 1,
  created_at    text not null,
  updated_at    text not null
);

create table if not exists employees (
  id              text primary key,
  company_id      text not null references companies(id),
  full_name       text not null,
  national_id     text,
  tax_pin         text,
  ssnit_or_equiv  text,
  bank_name       text,
  bank_account    text,
  gross_pay       real not null default 0,
  status          text not null default 'active',
  version         integer not null default 1,
  created_at      text not null,
  updated_at      text not null
);
create index if not exists idx_employees_company on employees(company_id);

create table if not exists payroll_runs (
  id             text primary key,
  company_id     text not null references companies(id),
  period_month   integer not null,
  period_year    integer not null,
  status         text not null default 'draft', -- draft | reviewed | approved | locked
  approved_by    text,
  approved_at    text,
  version        integer not null default 1,
  created_at     text not null,
  updated_at     text not null
);
create index if not exists idx_payroll_runs_company on payroll_runs(company_id);

create table if not exists payslips (
  id              text primary key,
  payroll_run_id  text not null references payroll_runs(id),
  employee_id     text not null references employees(id),
  breakdown_json  text not null, -- full calculatePayroll() output, frozen at approval time
  net_pay         real not null,
  version         integer not null default 1,
  created_at      text not null,
  updated_at      text not null
);
create index if not exists idx_payslips_run on payslips(payroll_run_id);

-- Outbox pattern: every local write is queued here for syncEngine to push.
-- This table is never synced itself.
create table if not exists sync_queue (
  id           integer primary key autoincrement,
  table_name   text not null,
  op           text not null,     -- insert | update | delete
  record_id    text not null,
  payload_json text not null,
  created_at   text not null,
  attempts     integer not null default 0,
  last_error   text
);
`;

function initDatabase(userDataPath) {
  const dbPath = path.join(userDataPath, 'mikaju.db');
  fs.mkdirSync(userDataPath, { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA);
  return _db;
}

function getDb() {
  if (!_db) throw new Error('Database not initialized — call initDatabase() first.');
  return _db;
}

/**
 * Writes a record locally AND enqueues it for remote sync, in one
 * transaction, so we never end up with a local write that silently never
 * makes it to Supabase.
 */
function writeRecord(tableName, op, record) {
  const db = getDb();
  const tx = db.transaction(() => {
    if (op === 'insert') {
      const cols = Object.keys(record);
      const placeholders = cols.map(() => '?').join(',');
      db.prepare(`insert into ${tableName} (${cols.join(',')}) values (${placeholders})`)
        .run(...cols.map((c) => record[c]));
    } else if (op === 'update') {
      const cols = Object.keys(record).filter((c) => c !== 'id');
      const setClause = cols.map((c) => `${c} = ?`).join(', ');
      db.prepare(`update ${tableName} set ${setClause} where id = ?`)
        .run(...cols.map((c) => record[c]), record.id);
    } else if (op === 'delete') {
      db.prepare(`delete from ${tableName} where id = ?`).run(record.id);
    } else {
      throw new Error(`Unknown op "${op}"`);
    }

    db.prepare(
      `insert into sync_queue (table_name, op, record_id, payload_json, created_at) values (?,?,?,?,?)`
    ).run(tableName, op, record.id, JSON.stringify(record), new Date().toISOString());
  });
  tx();
}

module.exports = { initDatabase, getDb, newId, writeRecord };
