<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import PublicLayout from '../components/layout/PublicLayout.vue';
import UiBackButton from '../components/ui/UiBackButton.vue';
import { rankPool, DEFAULT_TIEBREAKERS, type Standing } from '../lib/standings';
import { loadBrackets } from '../lib/bracket';
import { poolFormatForSize } from '../lib/schedule';
import { formatLabel } from '../lib/scoring';
import { medalFor } from '../lib/bracketStyle';
import type { Bracket, SetScore } from '../types/db';

type UUID = string;

type Pool = {
  id: UUID;
  tournament_id: UUID;
  name: string;
  court_assignment: string | null;
};

type Team = {
  id: UUID;
  full_team_name: string;
  seed_in_pool: number | null;
  seed_global: number | null;
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
  is_live: boolean;
  live_score_team1: number | null;
  live_score_team2: number | null;
  live_owner_id: UUID | null;
  live_last_active_at: string | null;
  match_type: 'pool' | 'bracket';
  best_of: number | null;
  set_targets: number[] | null;
  set_scores: SetScore[] | null;
};

const route = useRoute();
const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const poolId = computed(() => route.params.poolId as string);

const loading = ref(false);
const pool = ref<Pool | null>(null);
const teams = ref<Team[]>([]);
const teamById = ref<Record<string, Team>>({});
const matches = ref<Match[]>([]);
const now = ref<number>(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const LIVE_LEASE_MS = 90 * 1000;
function isLiveActive(m: Match): boolean {
  if (!m.is_live) return false;
  if (!m.live_owner_id) return false;
  if (!m.live_last_active_at) return false;
  const t = Date.parse(m.live_last_active_at);
  if (!Number.isFinite(t)) return false;
  return (now.value - t) <= LIVE_LEASE_MS;
}

const standings = ref<Standing[]>([]);

const brackets = ref<Bracket[]>([]);
/** Which bracket a pool finishing place feeds, e.g. place 1 -> Gold. */
function bracketForPlace(place: number): { name: string; dot: string } | null {
  const i = brackets.value.findIndex((b) => (b.places ?? []).includes(place));
  if (i < 0) return null;
  const b = brackets.value[i];
  return { name: b.name, dot: medalFor(b.name, i).dot };
}
const poolFormat = computed(() => formatLabel(poolFormatForSize(session.tournament?.game_rules, teams.value.length)));

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

async function loadPool() {
  if (!session.tournament || !poolId.value) {
    pool.value = null;
    return;
  }
  const { data, error } = await supabase
    .from('pools')
    .select('*')
    .eq('id', poolId.value)
    .eq('tournament_id', session.tournament.id)
    .single();

  if (error || !data) {
    toast.add({ severity: 'error', summary: 'Failed to load pool', detail: error?.message ?? 'Not found', life: 3000 });
    pool.value = null;
    return;
  }
  pool.value = data as Pool;
}

async function loadTeams() {
  if (!session.tournament || !poolId.value) {
    teams.value = [];
    teamById.value = {};
    return;
  }
  const { data, error } = await supabase
    .from('teams')
    .select('id, full_team_name, seed_in_pool, seed_global, pool_id')
    .eq('tournament_id', session.tournament.id)
    .eq('pool_id', poolId.value);

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 3000 });
    teams.value = [];
    teamById.value = {};
    return;
  }
  const arr = (data as Team[]) ?? [];
  teams.value = arr;
  const map: Record<string, Team> = {};
  arr.forEach((t) => (map[t.id] = t));
  teamById.value = map;
}

async function loadMatches() {
  if (!session.tournament || !poolId.value) {
    matches.value = [];
    return;
  }
  const { data, error } = await supabase
    .from('matches')
    .select('id,pool_id,round_number,team1_id,team2_id,ref_team_id,team1_score,team2_score,winner_id,is_live,live_score_team1,live_score_team2,live_owner_id,live_last_active_at,match_type,best_of,set_targets,set_scores')
    .eq('tournament_id', session.tournament.id)
    .eq('match_type', 'pool')
    .eq('pool_id', poolId.value)
    .order('round_number', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load matches', detail: error.message, life: 3000 });
    matches.value = [];
    return;
  }

  // Deduplicate any accidental duplicate rows returned or present in DB.
  // Key on pool_id + round_number + team1_id + team2_id + ref_team_id to ensure uniqueness per pool/round/matchup.
  const raw = (data as Match[]) ?? [];
  const seen = new Set<string>();
  matches.value = raw.filter((m) => {
    const k = [
      m.pool_id ?? 'null',
      m.round_number ?? 'null',
      m.team1_id ?? 'null',
      m.team2_id ?? 'null',
      m.ref_team_id ?? 'null',
    ].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function computeStandings() {
  standings.value = rankPool(teams.value, matches.value, session.tournament?.advancement_rules?.tiebreakers ?? DEFAULT_TIEBREAKERS);
}

function nameFor(id: string | null) {
  if (!id) return 'TBD';
  return teamById.value[id]?.full_team_name ?? 'TBD';
}


function completedLabel(m: Match): string {
  if (m.team1_score == null || m.team2_score == null) return '';
  return 'FINAL';
}

function winnerSide(m: Match): 1 | 2 | null {
  if (!m.team1_id || !m.team2_id) return null;
  if (m.winner_id) {
    if (m.winner_id === m.team1_id) return 1;
    if (m.winner_id === m.team2_id) return 2;
  }
  if (m.team1_score == null || m.team2_score == null) return null;
  if (m.team1_score === m.team2_score) return null;
  return m.team1_score > m.team2_score ? 1 : 2;
}

function winnerPillText(m: Match, side: 1 | 2): string {
  if (m.team1_score == null || m.team2_score == null) return 'WIN';
  const s1 = m.team1_score ?? 0;
  const s2 = m.team2_score ?? 0;
  const a = side === 1 ? s1 : s2;
  const b = side === 1 ? s2 : s1;
  if ((m.best_of ?? 1) > 1 && Array.isArray(m.set_scores) && m.set_scores.length) {
    return `WIN ${a}\u2013${b} \u00b7 ${m.set_scores.map((x) => (side === 1 ? `${x.t1}-${x.t2}` : `${x.t2}-${x.t1}`)).join(', ')}`;
  }
  return `WIN ${a}\u2013${b}`;
}

function openMatch(matchId: string) {
  router.push({ name: 'match-actions', params: { accessCode: accessCode.value, matchId } });
}

// Realtime subscription to reflect score/live changes
let channel: ReturnType<typeof supabase.channel> | null = null;

async function subscribeRealtime() {
  if (!session.tournament) return;
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
  channel = supabase
    .channel('pool_matches_' + session.tournament.id + '_' + poolId.value)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'matches',
        filter: `tournament_id=eq.${session.tournament.id}`,
      },
      async (payload) => {
        if (import.meta.env.DEV) console.debug('[Realtime] PublicPoolDetails event', payload);
        const row = (payload.new ?? payload.old) as Match;
        if (row.pool_id === poolId.value && row.match_type === 'pool') {
          await loadMatches();
          computeStandings();
        }
      }
    );

  await channel.subscribe((status) => {
    if (import.meta.env.DEV) console.debug('[Realtime] PublicPoolDetails status', status);
  });
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  loading.value = true;
  try {
    nowTimer = setInterval(() => (now.value = Date.now()), 15_000);
    await ensureTournament();
    await loadPool();
    await loadTeams();
    await loadMatches();
    computeStandings();
    try {
      if (session.tournament) brackets.value = await loadBrackets(session.tournament.id);
    } catch {
      brackets.value = [];
    }
    await subscribeRealtime();
    refreshTimer = setInterval(() => {
      void loadMatches().then(() => computeStandings());
    }, 15_000);
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(async () => {
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (nowTimer) {
    clearInterval(nowTimer);
    nowTimer = null;
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
              :to="{ name: 'public-pool-list', params: { accessCode } }"
              aria-label="Back to Pools"
            />
            <div class="min-w-0">
              <h2 class="text-2xl font-semibold tracking-tight text-ink">
                {{ pool?.name || 'Pool' }}
              </h2>
              <p class="mt-1 text-tone-400">
                Court: <span class="font-medium text-tone-300">{{ pool?.court_assignment || 'TBD' }}</span>
              </p>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <router-link
              :to="{ name: 'public-leaderboard', params: { accessCode } }"
              class="inline-flex items-center whitespace-nowrap rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300/95 transition-colors hover:border-amber-400/45 hover:bg-amber-500/15"
            >
              Leaderboard
            </router-link>
            <div v-if="loading" class="text-sm text-tone-400">Loading…</div>
          </div>
        </div>

        <!-- Standings -->
        <div class="mt-6">
          <h3 class="text-lg font-semibold text-ink">Standings</h3>
          <div class="mt-1 text-sm text-tone-400">
            {{ poolFormat }} · ranked by wins, then point differential
          </div>
          <div v-if="standings.length === 0" class="mt-2 text-sm text-tone-400">No results yet.</div>
          <ul v-else class="mt-3 grid gap-3">
            <li
              v-for="(s, i) in standings"
              :key="s.teamId"
              class="rounded-xl border border-tone-600/45 bg-tone-800/50 p-4 text-ink shadow-lg shadow-black/25"
            >
              <div class="flex items-start gap-3">
                <div
                  class="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-tone-600/50 bg-tone-800/80 text-sm font-semibold tabular-nums text-tone-200"
                >
                  {{ i + 1 }}
                </div>

                <div class="min-w-0 flex-1">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                      <div class="font-semibold leading-tight text-ink">
                        {{ s.name }}
                      </div>
                    </div>
                    <div class="shrink-0 text-sm font-semibold tabular-nums text-ink">
                      {{ s.matchWins }}-{{ s.matchLosses }}
                    </div>
                  </div>

                  <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-tone-500">
                    <span v-if="bracketForPlace(i + 1)" class="inline-flex items-center gap-1 font-semibold text-tone-300">
                      <span class="h-2 w-2 rounded-full" :style="{ background: bracketForPlace(i + 1)!.dot }" />{{ bracketForPlace(i + 1)!.name }}
                    </span>
                    <span>Sets {{ s.gameWins }}-{{ s.gameLosses }}</span>
                    <span>Pt Diff {{ s.pointDiff > 0 ? '+' + s.pointDiff : s.pointDiff }}</span>
                    <span>Seed {{ s.seed ?? '—' }}</span>
                  </div>
                </div>
              </div>
            </li>
          </ul>
        </div>

        <!-- Schedule -->
        <div class="mt-8">
          <h3 class="text-lg font-semibold text-ink">Schedule</h3>
          <div v-if="matches.length === 0" class="mt-2 text-sm text-tone-400">No matches scheduled.</div>
          <ul v-else class="mt-3 grid gap-3">
            <li
              v-for="m in matches"
              :key="m.id"
              :class="[
                'cursor-pointer rounded-xl border border-tone-600/45 bg-tone-800/50 p-4 text-ink shadow-lg shadow-black/25 transition-colors hover:border-amber-500/20 hover:bg-tone-800/65',
                isLiveActive(m) ? 'ring-2 ring-red-500/70 ring-offset-2 ring-offset-tone-950' : '',
              ]"
              @click="openMatch(m.id)"
            >
              <div class="flex items-center justify-between">
                <div class="text-sm text-tone-400">
                  Round {{ m.round_number ?? '—' }}
                </div>
                <div class="ml-3 flex items-center gap-2">
                  <span
                    v-if="isLiveActive(m)"
                    class="inline-flex items-center gap-2 rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-white whitespace-nowrap"
                  >
                    <span class="size-2 rounded-full bg-white/90"></span>
                    LIVE <span class="tabular-nums">{{ m.live_score_team1 ?? 0 }}-{{ m.live_score_team2 ?? 0 }}</span>
                  </span>
                  <span
                    v-if="m.team1_score != null && m.team2_score != null"
                    class="inline-flex items-center whitespace-nowrap rounded-full border border-tone-600/50 bg-tone-800/80 px-2.5 py-0.5 text-xs font-medium text-tone-200"
                  >
                    {{ completedLabel(m) }}
                  </span>
                </div>
              </div>
              <div class="mt-1">
                <div class="flex items-center justify-between gap-2">
                  <div
                    class="min-w-0 truncate font-semibold leading-tight text-ink"
                    :class="winnerSide(m) === 2 ? 'opacity-70 line-through decoration-2 decoration-slate-500' : ''"
                  >
                    {{ nameFor(m.team1_id) }}
                  </div>
                  <span
                    v-if="winnerSide(m) === 1"
                    class="inline-flex shrink-0 items-center rounded-full bg-amber-400/95 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-tone-900 ring-1 ring-amber-300/80"
                  >
                    {{ winnerPillText(m, 1) }}
                  </span>
                </div>
                <div class="mt-1 flex items-center justify-between gap-2">
                  <div
                    class="min-w-0 truncate font-semibold leading-tight text-ink"
                    :class="winnerSide(m) === 1 ? 'opacity-70 line-through decoration-2 decoration-slate-500' : ''"
                  >
                    {{ nameFor(m.team2_id) }}
                  </div>
                  <span
                    v-if="winnerSide(m) === 2"
                    class="inline-flex shrink-0 items-center rounded-full bg-amber-400/95 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-tone-900 ring-1 ring-amber-300/80"
                  >
                    {{ winnerPillText(m, 2) }}
                  </span>
                </div>
              </div>
              <div class="mt-1 text-xs text-tone-500">
                Ref: {{ nameFor(m.ref_team_id) }}
              </div>
            </li>
          </ul>
        </div>
    </section>
  </PublicLayout>
</template>
