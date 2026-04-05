-- Fix PostgREST 42501 "permission denied for table tournaments" when INSERT fails:
-- 1) Ensure authenticated (and anon) have explicit table privileges.
-- 2) Allow created_by to be NULL on INSERT so WITH CHECK passes before the trigger
--    tournaments_set_created_by fills it (matches PostgreSQL RLS/trigger ordering).

grant usage on schema public to anon, authenticated, service_role;

grant select on table public.tournaments to anon;
grant select, insert, update, delete on table public.tournaments to authenticated;

drop policy if exists "tournaments_insert_authenticated" on public.tournaments;
create policy "tournaments_insert_authenticated" on public.tournaments
for insert to authenticated with check (
  auth.uid() is not null
  and (auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  and (created_by is null or created_by = auth.uid())
);
