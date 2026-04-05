-- Tournament ownership + RLS
--
-- WHY run this in the Supabase SQL editor (or via CLI)?
-- The app cannot enforce "only my tournaments" by itself: anyone with the anon key
-- could still call the REST API. Row Level Security runs in Postgres and rejects
-- queries that do not match these rules. The column `created_by` is required so
-- policies can compare auth.uid() to the row owner.
--
-- Public/anonymous sessions (is_anonymous JWT) can still read tournament rows
-- so the public site + access-code flows keep working. Email/password admins
-- are non-anonymous and only see rows where created_by = auth.uid().
--
-- After applying: backfill old rows (optional):
--   update public.tournaments set created_by = 'YOUR_USER_UUID' where created_by is null;

alter table public.tournaments
  add column if not exists created_by uuid references auth.users (id) on delete set null;

create index if not exists idx_tournaments_created_by on public.tournaments (created_by);

-- Default owner on insert for real (non-anonymous) admins; keeps RLS WITH CHECK satisfied
create or replace function public.tournaments_set_created_by()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if coalesce((auth.jwt() ->> 'is_anonymous'), 'false') = 'false'
     and (auth.uid() is not null) then
    if new.created_by is null then
      new.created_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tournaments_set_created_by_trg on public.tournaments;
create trigger tournaments_set_created_by_trg
before insert on public.tournaments
for each row execute function public.tournaments_set_created_by();

-- Prevent transferring ownership through the API
create or replace function public.tournaments_prevent_created_by_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'created_by cannot be changed';
  end if;
  return new;
end;
$$;

drop trigger if exists tournaments_lock_created_by_trg on public.tournaments;
create trigger tournaments_lock_created_by_trg
before update on public.tournaments
for each row execute function public.tournaments_prevent_created_by_change();

-- ========== tournaments policies ==========
drop policy if exists "tournaments_read_all" on public.tournaments;
drop policy if exists "tournaments_select_authenticated" on public.tournaments;
drop policy if exists "tournaments_insert_authenticated" on public.tournaments;
drop policy if exists "tournaments_update_authenticated" on public.tournaments;
drop policy if exists "tournaments_delete_authenticated" on public.tournaments;

-- Unauthenticated API clients (rare if the app always uses a JWT)
drop policy if exists "tournaments_select_anon" on public.tournaments;
create policy "tournaments_select_anon" on public.tournaments
for select to anon using (true);

drop policy if exists "tournaments_select_authenticated" on public.tournaments;
create policy "tournaments_select_authenticated" on public.tournaments
for select to authenticated using (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or created_by = auth.uid()
);

drop policy if exists "tournaments_insert_authenticated" on public.tournaments;
create policy "tournaments_insert_authenticated" on public.tournaments
for insert to authenticated with check (
  auth.uid() is not null
  and (auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  and (created_by is null or created_by = auth.uid())
);

drop policy if exists "tournaments_update_authenticated" on public.tournaments;
create policy "tournaments_update_authenticated" on public.tournaments
for update to authenticated using (
  (auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  and created_by = auth.uid()
) with check (
  (auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  and created_by = auth.uid()
);

drop policy if exists "tournaments_delete_authenticated" on public.tournaments;
create policy "tournaments_delete_authenticated" on public.tournaments
for delete to authenticated using (
  (auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  and created_by = auth.uid()
);

-- ========== pools ==========
drop policy if exists "pools_select_authenticated" on public.pools;
drop policy if exists "pools_insert_authenticated" on public.pools;
drop policy if exists "pools_update_authenticated" on public.pools;
drop policy if exists "pools_delete_authenticated" on public.pools;

create policy "pools_select_authenticated" on public.pools
for select to authenticated using (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = pools.tournament_id and t.created_by = auth.uid()
  )
);

create policy "pools_insert_authenticated" on public.pools
for insert to authenticated with check (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = pools.tournament_id and t.created_by = auth.uid()
  )
);

create policy "pools_update_authenticated" on public.pools
for update to authenticated using (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = pools.tournament_id and t.created_by = auth.uid()
  )
) with check (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = pools.tournament_id and t.created_by = auth.uid()
  )
);

create policy "pools_delete_authenticated" on public.pools
for delete to authenticated using (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = pools.tournament_id and t.created_by = auth.uid()
  )
);

-- ========== teams ==========
drop policy if exists "teams_select_authenticated" on public.teams;
drop policy if exists "teams_insert_authenticated" on public.teams;
drop policy if exists "teams_update_authenticated" on public.teams;
drop policy if exists "teams_delete_authenticated" on public.teams;

create policy "teams_select_authenticated" on public.teams
for select to authenticated using (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = teams.tournament_id and t.created_by = auth.uid()
  )
);

create policy "teams_insert_authenticated" on public.teams
for insert to authenticated with check (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = teams.tournament_id and t.created_by = auth.uid()
  )
);

create policy "teams_update_authenticated" on public.teams
for update to authenticated using (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = teams.tournament_id and t.created_by = auth.uid()
  )
) with check (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = teams.tournament_id and t.created_by = auth.uid()
  )
);

create policy "teams_delete_authenticated" on public.teams
for delete to authenticated using (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = teams.tournament_id and t.created_by = auth.uid()
  )
);

-- ========== schedule_templates ==========
drop policy if exists "schedule_templates_select_authenticated" on public.schedule_templates;
drop policy if exists "schedule_templates_insert_authenticated" on public.schedule_templates;
drop policy if exists "schedule_templates_update_authenticated" on public.schedule_templates;
drop policy if exists "schedule_templates_delete_authenticated" on public.schedule_templates;

create policy "schedule_templates_select_authenticated" on public.schedule_templates
for select to authenticated using (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = schedule_templates.tournament_id and t.created_by = auth.uid()
  )
);

create policy "schedule_templates_insert_authenticated" on public.schedule_templates
for insert to authenticated with check (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = schedule_templates.tournament_id and t.created_by = auth.uid()
  )
);

create policy "schedule_templates_update_authenticated" on public.schedule_templates
for update to authenticated using (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = schedule_templates.tournament_id and t.created_by = auth.uid()
  )
) with check (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = schedule_templates.tournament_id and t.created_by = auth.uid()
  )
);

create policy "schedule_templates_delete_authenticated" on public.schedule_templates
for delete to authenticated using (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = schedule_templates.tournament_id and t.created_by = auth.uid()
  )
);

-- ========== matches (keep public insert/update; tighten authenticated delete) ==========
drop policy if exists "matches_delete_authenticated" on public.matches;

create policy "matches_delete_authenticated" on public.matches
for delete to authenticated using (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (
    select 1 from public.tournaments t
    where t.id = matches.tournament_id and t.created_by = auth.uid()
  )
);
