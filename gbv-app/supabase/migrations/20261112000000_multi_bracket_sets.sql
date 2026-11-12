-- Multiple brackets per tournament (Gold / Silver / Bronze ...) + per-set (match play) scoring.
--
-- Additive and idempotent: existing tournaments keep working. Tournaments that already have
-- bracket matches get a single "Main" bracket and their matches are attached to it.

-- =========================
-- brackets
-- =========================
create table if not exists public.brackets (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  -- Pool finishing places (1-based) that feed this bracket, e.g. {1,2} = top two of every pool.
  places integer[] not null default '{}',
  -- Per-round match format keyed by rounds-from-the-end so it survives bracket size changes:
  -- [{ "fromEnd": 1, "bestOf": 3, "setTargets": [21,21,15], "cap": null, "winBy2": true }, ...]
  -- fromEnd 1 = final, 2 = semifinal, 3 = quarterfinal, ...; missing rounds use the bracket default.
  round_formats jsonb not null default '[]'::jsonb,
  generated_at timestamptz,
  started boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists brackets_tournament_name_uidx on public.brackets(tournament_id, lower(name));
create index if not exists brackets_tournament_idx on public.brackets(tournament_id);

-- =========================
-- matches: bracket membership + match-play sets
-- =========================
alter table public.matches add column if not exists bracket_id uuid references public.brackets(id) on delete cascade;
alter table public.matches add column if not exists set_scores jsonb;          -- [{ "t1": 21, "t2": 18 }, ...]
alter table public.matches add column if not exists best_of integer;           -- null/1 = single set, 3 = best of 3
alter table public.matches add column if not exists set_targets integer[];     -- e.g. {21,21,15}
alter table public.matches add column if not exists court text;

create index if not exists matches_bracket_id_idx on public.matches(bracket_id);

-- Bracket (round, index) is now unique per bracket rather than per tournament.
drop index if exists public.matches_bracket_round_index_uidx;
create unique index if not exists matches_bracket_round_index_uidx
  on public.matches(tournament_id, coalesce(bracket_id, '00000000-0000-0000-0000-000000000000'::uuid), bracket_round, bracket_match_index)
  where match_type = 'bracket';

-- =========================
-- Backfill: one "Main" bracket for tournaments that already have bracket matches
-- =========================
insert into public.brackets (tournament_id, name, sort_order, places, generated_at, started)
select t.id, 'Main', 0,
       (select coalesce(array_agg(g), '{1,2}') from generate_series(1,
          greatest(2, coalesce((
            select max((p->>'advanceCount')::int)
            from jsonb_array_elements(coalesce(t.advancement_rules->'pools', '[]'::jsonb)) p
          ), 2))) g),
       t.bracket_generated_at, t.bracket_started
from public.tournaments t
where exists (select 1 from public.matches m where m.tournament_id = t.id and m.match_type = 'bracket' and m.bracket_id is null)
  and not exists (select 1 from public.brackets b where b.tournament_id = t.id);

update public.matches m
set bracket_id = b.id
from public.brackets b
where m.match_type = 'bracket'
  and m.bracket_id is null
  and b.tournament_id = m.tournament_id
  and b.name = 'Main';

-- =========================
-- RLS for brackets (same ownership model as pools)
-- =========================
alter table public.brackets enable row level security;

drop policy if exists "brackets_select_anon" on public.brackets;
create policy "brackets_select_anon" on public.brackets for select to anon using (true);

drop policy if exists "brackets_select_authenticated" on public.brackets;
create policy "brackets_select_authenticated" on public.brackets
for select to authenticated using (
  (auth.jwt() ->> 'is_anonymous') = 'true'
  or exists (select 1 from public.tournaments t where t.id = brackets.tournament_id and t.created_by = auth.uid())
);

drop policy if exists "brackets_insert_authenticated" on public.brackets;
create policy "brackets_insert_authenticated" on public.brackets
for insert to authenticated with check (
  (auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  and exists (select 1 from public.tournaments t where t.id = brackets.tournament_id and t.created_by = auth.uid())
);

drop policy if exists "brackets_update_authenticated" on public.brackets;
create policy "brackets_update_authenticated" on public.brackets
for update to authenticated using (
  (auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  and exists (select 1 from public.tournaments t where t.id = brackets.tournament_id and t.created_by = auth.uid())
) with check (
  (auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  and exists (select 1 from public.tournaments t where t.id = brackets.tournament_id and t.created_by = auth.uid())
);

drop policy if exists "brackets_delete_authenticated" on public.brackets;
create policy "brackets_delete_authenticated" on public.brackets
for delete to authenticated using (
  (auth.jwt() ->> 'is_anonymous') is distinct from 'true'
  and exists (select 1 from public.tournaments t where t.id = brackets.tournament_id and t.created_by = auth.uid())
);

grant select on public.brackets to anon, authenticated;
grant insert, update, delete on public.brackets to authenticated;

-- Realtime for bracket changes
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'brackets'
  ) then
    execute 'alter publication supabase_realtime add table public.brackets';
  end if;
end $$;
