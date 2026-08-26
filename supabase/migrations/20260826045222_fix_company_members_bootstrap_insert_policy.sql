drop policy if exists "owner can insert own membership on company creation" on mikaju.company_members;

create policy "owner can bootstrap membership for a brand new company"
on mikaju.company_members
for insert
to public
with check (
  user_id = auth.uid()
  and role = 'owner'
  and not exists (
    select 1 from mikaju.company_members existing
    where existing.company_id = company_members.company_id
  )
);
