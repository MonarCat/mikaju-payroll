-- payslips had RLS enabled and a read policy, but no INSERT/UPDATE/DELETE
-- policy at all. Since the authenticated role has table-level CRUD grants
-- (RLS is the only enforcement layer), this meant no client - including
-- the desktop app's own sync engine - could ever write a payslip to
-- Supabase; every push silently failed as an RLS violation, and the
-- payslip would sit in sync_queue retrying forever (the exact "gives up
-- but doesn't really" queue bug already tracked as its own workstream).
--
-- Scoped through payroll_runs (same join pattern as the existing read
-- policy) and restricted to runs that are not yet locked, so a client
-- cannot rewrite the payslips of an already-approved payroll run even if
-- it tries - locking a run is meant to be the point of no return, and
-- that should hold at the database level, not just in the desktop app's
-- own UI guard.
create policy "members can write company payslips for unlocked runs"
on mikaju.payslips
for all
to public
using (
  payroll_run_id in (
    select pr.id from mikaju.payroll_runs pr
    where pr.company_id in (
      select cm.company_id from mikaju.company_members cm where cm.user_id = auth.uid()
    )
    and pr.status <> 'locked'
  )
)
with check (
  payroll_run_id in (
    select pr.id from mikaju.payroll_runs pr
    where pr.company_id in (
      select cm.company_id from mikaju.company_members cm where cm.user_id = auth.uid()
    )
    and pr.status <> 'locked'
  )
);
