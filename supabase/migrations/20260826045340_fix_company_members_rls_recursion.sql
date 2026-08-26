-- Both "owners can manage members" and the new bootstrap INSERT policy
-- need to check company_members from within a policy ON company_members.
-- Done as a raw subquery, that's mutually recursive: evaluating the
-- subquery re-triggers the same table's RLS policies, which query the
-- table again, and so on, until Postgres aborts with
-- "infinite recursion detected in policy" (42P17). The standard fix is a
-- SECURITY DEFINER function: it runs as its owner, which bypasses RLS
-- for its own internal query, breaking the cycle.
create or replace function mikaju.is_company_owner(target_company_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from mikaju.company_members
    where company_id = target_company_id
      and user_id = auth.uid()
      and role = 'owner'
  );
$$;

revoke all on function mikaju.is_company_owner(uuid) from public;
grant execute on function mikaju.is_company_owner(uuid) to authenticated;

drop policy if exists "owners can manage members" on mikaju.company_members;

create policy "owners can manage members"
on mikaju.company_members
for all
to public
using (mikaju.is_company_owner(company_id))
with check (mikaju.is_company_owner(company_id));
