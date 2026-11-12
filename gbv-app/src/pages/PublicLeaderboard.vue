<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import PublicLayout from '../components/layout/PublicLayout.vue';
import UiBackButton from '../components/ui/UiBackButton.vue';
import { rankAllPools, seedForPlaces, DEFAULT_TIEBREAKERS, type Standing } from '../lib/standings';
import { loadBrackets } from '../lib/bracket';
import { medalFor, placesLabel } from '../lib/bracketStyle';
import type { Bracket, SetScore } from '../types/db';

type UUID = string;

type Team = {
  id: UUID;
  full_team_name: string;
  seed_global: number | null;
  seed_in_pool: number | null;
  pool_id: UUID | null;
};

type Match = {
  id: UUID;
  pool_id: UUID | null;
  round_number: number | null;
  team1_id: UUID | null;
  team2_id: UUID | null;
  ref_team_id: UUID | null;
  team1_score: number | null;
  team2_score: number | null;
  winner_id: UUID | null;
  match_type: 'pool' | 'bracket';
  best_of: number | null;
  set_scores: SetScore[] | null;
};

const route = useRoute();
const toast = useToast();
const session = useSessionStore();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');

const loading = ref(false);
const teams = ref<Team[]>([]);
const matches = ref<Match[]>([]);
const standings = ref<Standing[]>([]);
const brackets = ref<Bracket[]>([]);
const poolNames = ref<Record<string, string>>({});
type Group = { key: string; title: string; subtitle: string; dot: string | null; rows: Standing[] };
const groups = ref<Group[]>([]);

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let channel: ReturnType<typeof supabase.channel> | null = null;

async function ensureTournament() {
  if (!accessCode.value) return;
  await session.ensureAnon();
  if (!session.tournament) {
    const t = await session.loadTournamentByCode(accessCode.value);
    if (!t) {
      toast.add({ severity: 'warn', summary: 'Not found', detail: 'Invalid tournament code', life: 2500 });
    }
  }
}

async function loadTeams() {
  if (!session.tournament) {
    teams.value = [];
    return;
  }
  const { data, error } = await supabase
    .from('teams')
    .select('id, full_team_name, seed_global, seed_in_pool, pool_id')
    .eq('tournament_id', session.tournament.id);

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 3000 });
    teams.value = [];
    return;
  }
  teams.value = (data as Team[]) ?? [];
}

function dedupePoolMatches(raw: Match[]): Match[] {
  const seen = new Set<string>();
  return raw.filter((m) => {
    const a = m.team1_id ?? 'null';
    const b = m.team2_id ?? 'null';
    const [x, y] = a < b ? [a, b] : [b, a];
    const k = [m.pool_id ?? 'null', m.round_number ?? 'null', x, y, m.ref_team_id ?? 'null'].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function loadMatches() {
  if (!session.tournament) {
    matches.value = [];
    return;
  }

  const { data, error } = await supabase
    .from('matches')
    .select('id,pool_id,round_number,team1_id,team2_id,ref_team_id,team1_score,team2_score,winner_id,match_type,best_of,set_scores')
    .eq('tournament_id', session.tournament.id)
    .eq('match_type', 'pool')
    .order('pool_id', { ascending: true })
    .order('round_number', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load matches', detail: error.message, life: 3000 });
    matches.value = [];
    return;
  }

  matches.value = dedupePoolMatches(((data as Match[]) ?? []));
}

/**
 * Group teams the way brackets are seeded: each bracket (Gold, Silver, ...) lists the teams whose
 * pool finish feeds it, in seed order (game wins, then point differential).
 */
function computeStandings() {
  const byPool = rankAllPools(teams.value, matches.value, session.tournament?.advancement_rules?.tiebreakers ?? DEFAULT_TIEBREAKERS);
  const all = [...byPool.values()].flat();
  standings.value = all;
  const out: Group[] = [];
  const used = new Set<string>();
  brackets.value.forEach((b, i) => {
    const rows = seedForPlaces(byPool, b.places ?? []);
    rows.forEach((r) => used.add(r.teamId));
    if (rows.length) out.push({ key: b.id, title: b.name, subtitle: placesLabel(b.places ?? []), dot: medalFor(b.name, i).dot, rows });
  });
  const rest = all.filter((r) => !used.has(r.teamId));
  if (rest.length) {
    const sorted = seedForPlaces(new Map([['_', rest]]), [...new Set(rest.map((r) => r.place))]);
    out.push({ key: 'rest', title: out.length ? 'Not in a bracket' : 'All teams', subtitle: '', dot: null, rows: sorted });
  }
  groups.value = out;
}

async function subscribeRealtime() {
  if (!session.tournament) return;
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
  channel = supabase
    .channel('global_leaderboard_' + session.tournament.id)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'matches', filter: `tournament_id=eq.${session.tournament.id}` },
      async (payload) => {
        const row = (payload.new ?? payload.old) as Match;
        if (row.match_type === 'pool') {
          await loadMatches();
          computeStandings();
        }
      }
    );
  await channel.subscribe();
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  loading.value = true;
  try {
    await ensureTournament();
    await loadTeams();
    await loadMatches();
    if (session.tournament) {
      try {
        brackets.value = await loadBrackets(session.tournament.id);
      } catch {
        brackets.value = [];
      }
      const { data } = await supabase.from('pools').select('id,name').eq('tournament_id', session.tournament.id);
      poolNames.value = Object.fromEntries(((data as Array<{ id: string; name: string }>) ?? []).map((p) => [p.id, p.name]));
    }
    computeStandings();
    await subscribeRealtime();
    refreshTimer = setInterval(() => {
      void loadMatches().then(() => computeStandings());
    }, 15_000);
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(async () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
});
</script>

<template>
  <PublicLayout>
    <section class="p-5 sm:p-7">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-start gap-3 min-w-0">
          <UiBackButton
            class="mt-0.5 shrink-0"
            :to="{ name: 'tournament-public', params: { accessCode } }"
            aria-label="Return to Tournament"
          />
          <div class="min-w-0">
            <h2 class="text-2xl font-semibold text-ink">Leaderboard</h2>
            <p class="mt-1 text-ink/80">
              Pool play results, grouped by the bracket each team plays in.
            </p>
          </div>
        </div>
        <div v-if="loading" class="text-sm text-ink/80 shrink-0">Loading…</div>
      </div>

      <div v-if="standings.length === 0" class="mt-6 text-sm text-ink/80">No results yet.</div>
      <div v-for="g in groups" :key="g.key" class="mt-6">
        <div class="flex items-baseline justify-between gap-3">
          <h3 class="flex items-center gap-2 text-lg font-bold text-ink">
            <span v-if="g.dot" class="h-3 w-3 rounded-full" :style="{ background: g.dot }" />
            {{ g.title }}
          </h3>
          <span class="text-xs text-ink/60">{{ g.subtitle }}<template v-if="g.subtitle"> · </template>{{ g.rows.length }} teams</span>
        </div>
        <ol class="mt-2 overflow-hidden rounded-2xl ring-1 ring-ink/15">
          <li
            v-for="(s, i) in g.rows"
            :key="s.teamId"
            class="flex items-center gap-3 border-t border-ink/10 px-3 py-2.5 first:border-t-0"
          >
            <span class="w-6 shrink-0 text-right text-sm font-semibold tabular-nums text-ink/60">{{ i + 1 }}</span>
            <span class="min-w-0 flex-1">
              <span class="block truncate font-semibold leading-tight text-ink">{{ s.name }}</span>
              <span class="block text-xs text-ink/60">
                {{ s.poolId ? poolNames[s.poolId] ?? 'Pool' : 'Pool' }} · {{ s.place }}{{ s.place === 1 ? 'st' : s.place === 2 ? 'nd' : s.place === 3 ? 'rd' : 'th' }}
              </span>
            </span>
            <span class="shrink-0 text-right tabular-nums">
              <span class="block text-sm font-semibold text-ink">{{ s.gameWins }}–{{ s.gameLosses }}</span>
              <span class="block text-xs" :class="s.pointDiff > 0 ? 'text-emerald-400' : s.pointDiff < 0 ? 'text-red-400' : 'text-ink/60'">
                {{ s.pointDiff > 0 ? '+' : '' }}{{ s.pointDiff }}
              </span>
            </span>
          </li>
        </ol>
      </div>
      <p v-if="groups.length" class="mt-4 text-xs text-ink/60">Within each bracket, teams are ordered by games won, then point differential. This is the bracket seeding order.</p>
    </section>
  </PublicLayout>
</template>
