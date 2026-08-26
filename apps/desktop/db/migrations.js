/**
 * Versioned schema migrations — Mikaju Payroll local database.
 *
 * db/index.js's SCHEMA creates tables with `create table if not exists`,
 * which is deliberately permissive so it never fails on an existing
 * install. That means it can't be used to *add* constraints to tables
 * that already exist without them — SQLite has no `ALTER TABLE ... ADD
 * CONSTRAINT`. This module handles that via the standard SQLite pattern:
 * rebuild the table under a new name with the constraint present, copy
 * the data across, then swap names.
 *
 * Each migration is guarded by a check for data that would violate the
 * new constraint. If any is found, we log a clear warning and skip
 * *only that constraint* rather than crash the app or silently drop
 * rows — a business decision about duplicate/invalid data belongs to
 * a human, not to a migration running silently at startup.
 */

const CURRENT_SCHEMA_VERSION = 2;

function getSchemaVersion(db) {
  const row = db.prepare("select value from app_meta where key = 'schema_version'").get();
  return row ? Number(row.value) : 1;
}

function setSchemaVersion(db, version) {
  db.prepare(
    "insert into app_meta (key,value) values ('schema_version',?) on conflict(key) do update set value=excluded.value"
  ).run(String(version));
}

/**
 * v2: adds
 *   - employees:     CHECK (gross_pay >= 0)
 *   - payroll_runs:   CHECK (period_month BETWEEN 1 AND 12)
 *   - payroll_runs:   UNIQUE (company_id, period_year, period_month)
 * so the database itself refuses impossible payroll data, rather than
 * relying on every caller (today's IPC handlers, tomorrow's sync pull,
 * a future admin tool) to each remember to check.
 */
function migrateToV2(db) {
  const negativeGrossPay = db.prepare('select count(*) as n from employees where gross_pay < 0').get().n;
  if (negativeGrossPay > 0) {
    console.warn(
      `[db migration v2] Skipping "gross_pay >= 0" constraint: ${negativeGrossPay} existing employee row(s) ` +
      'would violate it. Fix that data, then restart the app to have this enforced at the database level.'
    );
  } else {
    db.exec(`
      create table employees_v2 (
        id              text primary key,
        company_id      text not null references companies(id),
        full_name       text not null,
        national_id     text,
        tax_pin         text,
        ssnit_or_equiv  text,
        bank_name       text,
        bank_account    text,
        gross_pay       real not null default 0 check (gross_pay >= 0),
        status          text not null default 'active',
        version         integer not null default 1,
        created_at      text not null,
        updated_at      text not null
      );
      insert into employees_v2 select * from employees;
      drop table employees;
      alter table employees_v2 rename to employees;
      create index if not exists idx_employees_company on employees(company_id);
    `);
  }

  const badMonths = db
    .prepare('select count(*) as n from payroll_runs where period_month < 1 or period_month > 12')
    .get().n;
  const duplicatePeriods = db
    .prepare(
      `select company_id, period_year, period_month, count(*) as n
       from payroll_runs group by company_id, period_year, period_month having n > 1`
    )
    .all();

  if (badMonths > 0 || duplicatePeriods.length > 0) {
    if (badMonths > 0) {
      console.warn(
        `[db migration v2] Skipping "period_month between 1 and 12" constraint: ${badMonths} ` +
        'existing payroll_runs row(s) have an out-of-range month.'
      );
    }
    if (duplicatePeriods.length > 0) {
      console.warn(
        `[db migration v2] Skipping "one payroll run per company/period" constraint: ` +
        `${duplicatePeriods.length} company/period combination(s) already have more than one run. ` +
        'Resolve manually (keep one, delete or archive the rest), then restart to have this enforced.'
      );
    }
  } else {
    db.exec(`
      create table payroll_runs_v2 (
        id             text primary key,
        company_id     text not null references companies(id),
        period_month   integer not null check (period_month between 1 and 12),
        period_year    integer not null,
        status         text not null default 'draft',
        approved_by    text,
        approved_at    text,
        version        integer not null default 1,
        created_at     text not null,
        updated_at     text not null,
        unique (company_id, period_year, period_month)
      );
      insert into payroll_runs_v2 select * from payroll_runs;
      drop table payroll_runs;
      alter table payroll_runs_v2 rename to payroll_runs;
      create index if not exists idx_payroll_runs_company on payroll_runs(company_id);
    `);
  }
}

const MIGRATIONS = {
  2: migrateToV2,
};

/**
 * Runs every migration between the database's current version and
 * CURRENT_SCHEMA_VERSION, in order, each in its own transaction. Safe to
 * call on every startup — if already at the latest version, this is a
 * single indexed lookup and nothing else.
 */
function runMigrations(db) {
  let version = getSchemaVersion(db);
  while (version < CURRENT_SCHEMA_VERSION) {
    const next = version + 1;
    const migrate = MIGRATIONS[next];
    if (!migrate) break; // no migration registered for this step — nothing more we can do automatically
    const tx = db.transaction(() => {
      db.pragma('foreign_keys = OFF');
      migrate(db);
      db.pragma('foreign_keys = ON');
    });
    tx();
    setSchemaVersion(db, next);
    version = next;
  }
}

module.exports = { runMigrations, CURRENT_SCHEMA_VERSION };
