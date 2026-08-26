# Supabase migrations — Mikaju Payroll

These files mirror the actual migration history tracked by Supabase for
project `wznopthjoaqusalqoyru` (shared with Salary Calculator Kenya; Mikaju
lives entirely in the `mikaju` schema). They were pulled from
`supabase_migrations.schema_migrations` and checked in here for the first
time on 2026-08-26 — prior to that, schema and RLS changes for `mikaju`
were applied directly via the SQL editor / MCP tooling with no tracked
file in this repo. From this point on, schema changes should be written
as new files here (matching the `<version>_<name>.sql` naming Supabase's
CLI expects) and applied via `supabase db push` or the equivalent MCP
`apply_migration` call, not applied live without a corresponding file.

## What's here

- `20260821150514_create_mikaju_schema.sql` — the original schema: all
  seven tables, RLS enabled, and the first set of policies.
- `20260826045222` through `20260826045532` — five follow-up migrations
  from a Workstream 4 (identity/RBAC/multi-tenancy) audit, in order:
  1. Restricted `company_members` self-insert to a first-owner bootstrap
     only (the original policy let any authenticated user self-insert
     into **any** company's membership with **any** role, including
     `owner` — a live cross-tenant privilege escalation, closed here).
  2. Fixed an RLS self-reference recursion bug this uncovered
     (`infinite recursion detected in policy`, 42P17) via a
     `SECURITY DEFINER` helper function.
  3. Fixed a second bug in the same bootstrap policy: its own
     `not exists (...)` check was itself filtered by RLS for the calling
     user, so an attacker's view of "does this company already have a
     member" was always empty regardless of reality. Same
     `SECURITY DEFINER` pattern, applied correctly this time.
  4. Added a write policy to `payslips`, which had RLS enabled but no
     INSERT/UPDATE/DELETE policy at all — meaning no client, including
     the desktop app's own sync engine, could ever successfully push a
     payslip to Supabase.
  5. Pinned `search_path` on the `set_updated_at` trigger function
     (minor hardening, flagged by the security advisor).

All five were verified against the live project in rolled-back
transactions (simulating both a legitimate owner and an attacker via
`set local request.jwt.claims`) before being treated as done.

## Known gap, not yet addressed here

The **local SQLite schema** used by the Electron desktop app
(`apps/desktop/db/index.js`) does not match this cloud schema — different
column names throughout (e.g. `national_id`/`tax_pin`/`gross_pay` locally
vs. `id_number`/`kra_pin`/`basic_salary`+`housing_allowance` here), and
`payroll_runs.status` uses `'reviewed'` locally vs. `'approved'` here.
The sync engine's `upsert(payload)` calls therefore don't align with this
schema. This needs a deliberate decision (migrate local to match cloud,
or vice versa) rather than a silent fix, and is tracked separately.
