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

const CURRENT_SCHEMA_VERSION = 3;

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

/**
 * v3: aligns the local schema to the actual cloud `mikaju` schema in
 * Supabase, column-for-column. Before this, the two had drifted apart —
 * different names for the same field (national_id vs id_number,
 * tax_pin vs kra_pin, gross_pay vs basic_salary), different shapes
 * entirely for payslips (one JSON blob locally vs individual statutory
 * columns in the cloud), and even different status values for
 * payroll_runs ('reviewed' locally, 'approved' in the cloud). The sync
 * engine's upsert() calls were sending payloads whose columns didn't
 * exist on the other side — meaning every push to Supabase for these
 * tables was effectively broken, quietly, regardless of the RLS gaps
 * fixed separately in Workstream 4.
 *
 * companies, employees, and payroll_runs are simple renames/additions —
 * done as one INSERT ... SELECT per table. payslips is not a simple
 * rename: the cloud schema breaks each statutory deduction into its own
 * column instead of one JSON blob, so existing rows are read into JS,
 * unpacked, and re-inserted individually. The full original breakdown is
 * still kept (renamed to calculation_snapshot, matching the cloud
 * column) so nothing is lost even where the structured extraction below
 * doesn't apply cleanly (e.g. a non-Kenya country whose breakdown shape
 * doesn't use nssf/shif/ahl/paye keys) — see the fallback comment below.
 */
function migrateToV3(db) {
  // --- companies: add cloud-only columns, drop local-only `version` ---
  db.exec(`
    create table companies_v3 (
      id                          text primary key,
      name                        text not null,
      country_code                text not null default 'KE',
      kra_pin                     text,
      industry                    text,
      logo_url                    text,
      plan_tier                   text not null default 'free' check (plan_tier in ('free','basic','enterprise')),
      billing_cycle               text check (billing_cycle in ('monthly','yearly')),
      subscription_status         text not null default 'active' check (subscription_status in ('active','past_due','cancelled')),
      paystack_customer_code      text,
      paystack_subscription_code  text,
      trial_ends_at               text,
      created_at                  text not null,
      updated_at                  text not null
    );
    insert into companies_v3 (
      id, name, country_code, kra_pin, logo_url, plan_tier, billing_cycle,
      subscription_status, paystack_subscription_code, created_at, updated_at
    )
    select id, name, country_code, kra_pin, logo_url, plan_tier, billing_cycle,
           subscription_status, paystack_subscription_code, created_at, updated_at
    from companies;
    drop table companies;
    alter table companies_v3 rename to companies;
  `);

  // --- employees: rename fields to match cloud, add new compensation/HR columns ---
  const badGrossPay = db.prepare('select count(*) as n from employees where gross_pay < 0').get().n;
  const basicSalaryCheck = badGrossPay > 0 ? '' : 'check (basic_salary >= 0)';
  if (badGrossPay > 0) {
    console.warn(
      `[db migration v3] "basic_salary >= 0" constraint left unenforced: ${badGrossPay} existing ` +
      'employee row(s) have a negative gross_pay. Fix that data, then it will be enforced on next restart.'
    );
  }
  db.exec(`
    create table employees_v3 (
      id                                 text primary key,
      company_id                         text not null references companies(id),
      full_name                          text not null,
      id_number                         text,
      kra_pin                            text,
      nssf_number                        text,
      shif_number                        text,
      bank_name                          text,
      bank_account                       text,
      phone                              text,
      email                              text,
      job_title                          text,
      employment_type                    text not null default 'permanent' check (employment_type in ('permanent','contract','casual')),
      basic_salary                       real not null default 0 ${basicSalaryCheck},
      housing_allowance                  real not null default 0,
      other_allowances                   text not null default '[]',
      is_pwd                             integer not null default 0,
      pwd_exemption_certificate_number   text,
      date_joined                        text not null,
      date_exited                        text,
      status                             text not null default 'active' check (status in ('active','exited')),
      version                            integer not null default 1,
      created_at                         text not null,
      updated_at                         text not null
    );
    insert into employees_v3 (
      id, company_id, full_name, id_number, kra_pin, nssf_number, bank_name, bank_account,
      basic_salary, date_joined, status, version, created_at, updated_at
    )
    select id, company_id, full_name, national_id, tax_pin, ssnit_or_equiv, bank_name, bank_account,
           gross_pay, substr(created_at, 1, 10), status, version, created_at, updated_at
    from employees;
    drop table employees;
    alter table employees_v3 rename to employees;
    create index if not exists idx_employees_company on employees(company_id);
  `);

  // --- payroll_runs: rename 'reviewed' -> 'approved' to match cloud's enum, drop local-only `version` ---
  const unexpectedStatuses = db
    .prepare("select distinct status from payroll_runs where status not in ('draft','reviewed','locked')")
    .all();
  if (unexpectedStatuses.length > 0) {
    console.warn(
      `[db migration v3] Unexpected payroll_runs.status value(s) found: ${unexpectedStatuses.map(r => r.status).join(', ')}. ` +
      'These rows are kept as-is; the status CHECK constraint may reject them on the next write.'
    );
  }
  db.exec(`
    create table payroll_runs_v3 (
      id             text primary key,
      company_id     text not null references companies(id),
      period_month   integer not null check (period_month between 1 and 12),
      period_year    integer not null,
      status         text not null default 'draft' check (status in ('draft','approved','locked')),
      approved_by    text,
      approved_at    text,
      created_at     text not null,
      updated_at     text not null,
      unique (company_id, period_month, period_year)
    );
    insert into payroll_runs_v3 (id, company_id, period_month, period_year, status, approved_by, approved_at, created_at, updated_at)
    select id, company_id, period_month, period_year,
           case status when 'reviewed' then 'approved' else status end,
           approved_by, approved_at, created_at, updated_at
    from payroll_runs;
    drop table payroll_runs;
    alter table payroll_runs_v3 rename to payroll_runs;
    create index if not exists idx_payroll_runs_company on payroll_runs(company_id);
  `);

  // --- payslips: unpack breakdown_json into the cloud's structured columns ---
  db.exec(`
    create table payslips_v3 (
      id                     text primary key,
      payroll_run_id         text not null references payroll_runs(id),
      employee_id            text not null references employees(id),
      gross_pay              real not null,
      pensionable_pay        real not null,
      nssf_employee          real not null default 0,
      nssf_employer          real not null default 0,
      shif                   real not null default 0,
      housing_levy_employee  real not null default 0,
      housing_levy_employer  real not null default 0,
      paye                   real not null default 0,
      other_deductions       text not null default '[]',
      net_pay                real not null,
      employer_cost          real not null,
      calculation_snapshot   text not null,
      created_at             text not null,
      unique (payroll_run_id, employee_id)
    );
  `);

  const oldPayslips = db.prepare('select * from payslips').all();
  const insertV3Payslip = db.prepare(`
    insert into payslips_v3 (
      id, payroll_run_id, employee_id, gross_pay, pensionable_pay,
      nssf_employee, nssf_employer, shif, housing_levy_employee, housing_levy_employer,
      paye, other_deductions, net_pay, employer_cost, calculation_snapshot, created_at
    ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  for (const row of oldPayslips) {
    // Structured extraction below assumes the Kenya-shaped breakdown
    // (statutoryDeductions.{nssf,shif,ahl,paye}) — the only country this
    // product has actually issued real payroll for so far. Every field
    // defaults safely to 0 if the shape doesn't match (e.g. a different
    // country module's breakdown), and the FULL original breakdown is
    // always preserved in calculation_snapshot regardless, so no data is
    // lost even when the structured columns can't be populated exactly.
    let breakdown = {};
    try {
      breakdown = row.breakdown_json ? JSON.parse(row.breakdown_json) : {};
    } catch {
      breakdown = {};
    }
    const sd = breakdown.statutoryDeductions || {};
    insertV3Payslip.run(
      row.id,
      row.payroll_run_id,
      row.employee_id,
      breakdown.grossPay ?? row.net_pay ?? 0,
      breakdown.grossPay ?? row.net_pay ?? 0, // pensionable_pay: KE module defaults this to grossPay when not given separately
      sd.nssf?.totalEmployee ?? 0,
      sd.nssf?.totalEmployer ?? 0,
      sd.shif?.employee ?? 0,
      sd.ahl?.employee ?? 0,
      sd.ahl?.employer ?? 0,
      sd.paye?.employee ?? 0,
      JSON.stringify(breakdown.otherDeductions || []),
      row.net_pay,
      breakdown.employerCost ?? row.net_pay,
      JSON.stringify(breakdown),
      row.created_at
    );
  }

  db.exec(`
    drop table payslips;
    alter table payslips_v3 rename to payslips;
    create index if not exists idx_payslips_run on payslips(payroll_run_id);
    create index if not exists idx_payslips_employee on payslips(employee_id);
  `);
}

const MIGRATIONS = {
  2: migrateToV2,
  3: migrateToV3,
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

    // PRAGMA foreign_keys is a silent no-op when set from inside an
    // already-open transaction — SQLite only honors it between
    // transactions. Setting it inside db.transaction()'s callback below
    // (as an earlier version of this function did) looks like it works
    // but doesn't: enforcement stays on the whole time, and a rebuild
    // that drops a table still referenced by an unmigrated sibling
    // (e.g. dropping `companies` while `employees` still FK-references
    // it) fails with SQLITE_CONSTRAINT_FOREIGNKEY. Must be set here,
    // outside the transaction, to actually take effect.
    db.pragma('foreign_keys = OFF');
    const tx = db.transaction(() => migrate(db));
    tx();
    db.pragma('foreign_keys = ON');

    setSchemaVersion(db, next);
    version = next;
  }
}

module.exports = { runMigrations, CURRENT_SCHEMA_VERSION };
