-- =============================================================================
-- Mikaju Payroll schema — applied to the shared Salary Calculator project
-- All Mikaju tables live under the `mikaju` schema so they are cleanly
-- separated from the salary calculator's `public` schema tables.
-- Both products share auth.users. A user registered on salarycalculator.co.ke
-- can sign into Mikaju with the same credentials.
-- =============================================================================

create schema if not exists mikaju;
create extension if not exists "pgcrypto" schema public;

-- updated_at trigger helper
create or replace function mikaju.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ── companies ─────────────────────────────────────────────────────────────────
create table if not exists mikaju.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country_code char(2) not null default 'KE',
  kra_pin text,
  industry text,
  logo_url text,
  plan_tier text not null default 'free' check (plan_tier in ('free','basic','enterprise')),
  billing_cycle text check (billing_cycle in ('monthly','yearly')),
  subscription_status text not null default 'active'
    check (subscription_status in ('active','past_due','cancelled')),
  paystack_customer_code text,
  paystack_subscription_code text,
  trial_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger mikaju_companies_updated_at before update on mikaju.companies
  for each row execute function mikaju.set_updated_at();

-- ── company_members ───────────────────────────────────────────────────────────
create table if not exists mikaju.company_members (
  company_id uuid not null references mikaju.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','admin','payroll_clerk')),
  created_at timestamptz not null default now(),
  primary key (company_id, user_id)
);

-- ── employees ─────────────────────────────────────────────────────────────────
create table if not exists mikaju.employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references mikaju.companies(id) on delete cascade,
  full_name text not null,
  id_number text,
  kra_pin text,
  nssf_number text,
  shif_number text,
  bank_name text,
  bank_account text,
  phone text,
  email text,
  job_title text,
  employment_type text not null default 'permanent'
    check (employment_type in ('permanent','contract','casual')),
  basic_salary numeric(14,2) not null default 0,
  housing_allowance numeric(14,2) not null default 0,
  other_allowances jsonb not null default '[]',
  is_pwd boolean not null default false,
  pwd_exemption_certificate_number text,
  date_joined date not null default current_date,
  date_exited date,
  status text not null default 'active' check (status in ('active','exited')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger mikaju_employees_updated_at before update on mikaju.employees
  for each row execute function mikaju.set_updated_at();
create index if not exists idx_mikaju_employees_company on mikaju.employees(company_id);

-- ── payroll_runs ──────────────────────────────────────────────────────────────
create table if not exists mikaju.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references mikaju.companies(id) on delete cascade,
  period_month smallint not null check (period_month between 1 and 12),
  period_year smallint not null,
  status text not null default 'draft' check (status in ('draft','approved','locked')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, period_month, period_year)
);
create trigger mikaju_payroll_runs_updated_at before update on mikaju.payroll_runs
  for each row execute function mikaju.set_updated_at();
create index if not exists idx_mikaju_payroll_runs_company on mikaju.payroll_runs(company_id);

-- ── payslips ──────────────────────────────────────────────────────────────────
create table if not exists mikaju.payslips (
  id uuid primary key default gen_random_uuid(),
  payroll_run_id uuid not null references mikaju.payroll_runs(id) on delete cascade,
  employee_id uuid not null references mikaju.employees(id) on delete restrict,
  gross_pay numeric(14,2) not null,
  pensionable_pay numeric(14,2) not null,
  nssf_employee numeric(14,2) not null default 0,
  nssf_employer numeric(14,2) not null default 0,
  shif numeric(14,2) not null default 0,
  housing_levy_employee numeric(14,2) not null default 0,
  housing_levy_employer numeric(14,2) not null default 0,
  paye numeric(14,2) not null default 0,
  other_deductions jsonb not null default '[]',
  net_pay numeric(14,2) not null,
  employer_cost numeric(14,2) not null,
  calculation_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (payroll_run_id, employee_id)
);
create index if not exists idx_mikaju_payslips_run on mikaju.payslips(payroll_run_id);
create index if not exists idx_mikaju_payslips_employee on mikaju.payslips(employee_id);

-- ── subscriptions ─────────────────────────────────────────────────────────────
create table if not exists mikaju.subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references mikaju.companies(id) on delete cascade,
  plan_tier text not null check (plan_tier in ('basic','enterprise')),
  billing_cycle text not null check (billing_cycle in ('monthly','yearly')),
  paystack_subscription_code text not null,
  paystack_customer_code text not null,
  status text not null default 'active' check (status in ('active','past_due','cancelled')),
  current_period_end timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger mikaju_subscriptions_updated_at before update on mikaju.subscriptions
  for each row execute function mikaju.set_updated_at();

-- ── license_tokens ────────────────────────────────────────────────────────────
create table if not exists mikaju.license_tokens (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references mikaju.companies(id) on delete cascade,
  plan_tier text not null check (plan_tier in ('free','basic','enterprise')),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists idx_mikaju_license_tokens_company on mikaju.license_tokens(company_id);

-- =============================================================================
-- Row Level Security
-- =============================================================================
alter table mikaju.companies enable row level security;
alter table mikaju.company_members enable row level security;
alter table mikaju.employees enable row level security;
alter table mikaju.payroll_runs enable row level security;
alter table mikaju.payslips enable row level security;
alter table mikaju.subscriptions enable row level security;
alter table mikaju.license_tokens enable row level security;

-- companies
create policy "members can read their companies"
  on mikaju.companies for select
  using (id in (select company_id from mikaju.company_members where user_id = auth.uid()));

create policy "owners/admins can update their companies"
  on mikaju.companies for update
  using (id in (select company_id from mikaju.company_members where user_id = auth.uid() and role in ('owner','admin')));

create policy "authenticated users can create a company"
  on mikaju.companies for insert
  with check (auth.uid() is not null);

-- company_members
create policy "members can read own membership"
  on mikaju.company_members for select using (user_id = auth.uid());

create policy "owners can manage members"
  on mikaju.company_members for all
  using (company_id in (select company_id from mikaju.company_members where user_id = auth.uid() and role = 'owner'));

create policy "owner can insert own membership on company creation"
  on mikaju.company_members for insert
  with check (user_id = auth.uid());

-- employees
create policy "members can read company employees"
  on mikaju.employees for select
  using (company_id in (select company_id from mikaju.company_members where user_id = auth.uid()));

create policy "members can write company employees"
  on mikaju.employees for all
  using (company_id in (select company_id from mikaju.company_members where user_id = auth.uid()));

-- payroll_runs
create policy "members can read company payroll runs"
  on mikaju.payroll_runs for select
  using (company_id in (select company_id from mikaju.company_members where user_id = auth.uid()));

create policy "members can write company payroll runs"
  on mikaju.payroll_runs for all
  using (company_id in (select company_id from mikaju.company_members where user_id = auth.uid()));

-- payslips
create policy "members can read company payslips"
  on mikaju.payslips for select
  using (payroll_run_id in (
    select id from mikaju.payroll_runs
    where company_id in (select company_id from mikaju.company_members where user_id = auth.uid())
  ));

-- subscriptions and license_tokens (written by Edge Functions via service role)
create policy "members can read their subscription"
  on mikaju.subscriptions for select
  using (company_id in (select company_id from mikaju.company_members where user_id = auth.uid()));

create policy "members can read their license tokens"
  on mikaju.license_tokens for select
  using (company_id in (select company_id from mikaju.company_members where user_id = auth.uid()));

-- Grant schema usage so the anon/authenticated roles can reach it
grant usage on schema mikaju to anon, authenticated;
grant all on all tables in schema mikaju to authenticated;
grant select on all tables in schema mikaju to anon;
alter default privileges in schema mikaju grant all on tables to authenticated;
