-- The bootstrap INSERT policy's "not exists (select ... from
-- company_members)" check is itself subject to RLS for the CURRENT
-- caller. An attacker can only ever see their OWN membership rows (per
-- "members can read own membership"), so from their perspective a
-- company they're not a member of always looks like it has zero
-- members - the exists-check passes even when a real owner already
-- exists, because that owner's row is invisible to the attacker, not
-- because it's absent. Same root cause as the recursion bug: a raw
-- subquery against an RLS-protected table, evaluated under the
-- CALLER'S row visibility. Needs the same SECURITY DEFINER fix, which
-- runs with the function owner's visibility (all rows), not the
-- caller's.
create or replace function mikaju.company_has_any_member(target_company_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from mikaju.company_members
    where company_id = target_company_id
  );
$$;

revoke all on function mikaju.company_has_any_member(uuid) from public;
grant execute on function mikaju.company_has_any_member(uuid) to authenticated;

drop policy if exists "owner can bootstrap membership for a brand new company" on mikaju.company_members;

create policy "owner can bootstrap membership for a brand new company"
on mikaju.company_members
for insert
to public
with check (
  user_id = auth.uid()
  and role = 'owner'
  and not mikaju.company_has_any_member(company_id)
);
