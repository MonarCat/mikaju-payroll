-- payroll_runs is the highest-stakes table for concurrent offline edits
-- in this product: two devices racing to approve/lock the same run, or
-- one regenerating payslips while another approves, need to be
-- detectable as a conflict rather than silently letting whichever push
-- wins overwrite the other. employees already had a version column on
-- both sides; this brings payroll_runs to parity so the desktop app's
-- sync engine can apply real optimistic concurrency to it too.
alter table mikaju.payroll_runs add column version integer not null default 1;
