<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import PublicLayout from '../components/layout/PublicLayout.vue';
import UiBackButton from '../components/ui/UiBackButton.vue';
import { matchContext } from '../lib/matchContext';
import { formatFromMatch, matchResult, targetForSet } from '../lib/scoring';

type UUID = string;

type Match = {
  id: UUID;
  tournament_id: UUID;
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
  set_scores: Array<{ t1: number; t2: number }> | null;
  court: string | null;
  bracket_round: number | null;
  bracket_id: UUID | null;
};

type Team = { id: UUID; full_team_name: string };

const route = useRoute();
const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const matchId = computed(() => route.params.matchId as string);
const from = computed(() => (route.query.from as string | undefined) ?? undefined);

const loading = ref(false);
const match = ref<Match | null>(null);
const teamNameById = ref<Record<string, string>>({});
const now = ref<number>(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;

const LIVE_LEASE_MS = 90 * 1000;
function isLiveActive(m: Match): boolean {
  if (!m.is_live) return false;
  if (!m.live_owner_id) return false;
  if (!m.live_last_active_at) return false;
  const t = Date.parse(m.live_last_active_at);
  if (!Number.isFinite(t)) return false;
  return (now.value - t) <= LIVE_LEASE_MS;
}

let channel: ReturnType<typeof supabase.channel> | null = null;
async function subscribeRealtime() {
  if (!session.tournament || !matchId.value) return;
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }

  channel = supabase
    .channel('match_actions_' + matchId.value)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'matches', filter: `id=eq.${matchId.value}` },
      (payload) => {
        if (import.meta.env.DEV) console.debug('[Realtime] MatchActions event', payload);
        if (payload.new) {
          match.value = payload.new as Match;
        } else if (payload.eventType === 'DELETE' && match.value?.id === matchId.value) {
          match.value = null;
        }
      }
    );

  await channel.subscribe((status) => {
    if (import.meta.env.DEV) console.debug('[Realtime] MatchActions status', status);
  });
}

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

async function loadMatch() {
  if (!session.tournament || !matchId.value) {
    match.value = null;
    return;
  }
  const { data, error } = await supabase
    .from('matches')
    .select('id,tournament_id,pool_id,round_number,team1_id,team2_id,ref_team_id,team1_score,team2_score,winner_id,is_live,live_score_team1,live_score_team2,live_owner_id,live_last_active_at,match_type,best_of,set_targets,set_scores,court,bracket_round,bracket_id')
    .eq('id', matchId.value)
    .eq('tournament_id', session.tournament.id)
    .single();

  if (error || !data) {
    toast.add({ severity: 'error', summary: 'Failed to load match', detail: error?.message ?? 'Not found', life: 3000 });
    match.value = null;
    return;
  }
  match.value = data as Match;
  await loadContext();
}

/** Heading such as "Gold · Semifinals · Best of 3 (21, 21, 15)". */
const contextLabel = ref('');
async function loadContext() {
  if (!match.value) return;
  const c = await matchContext(match.value);
  contextLabel.value = `${c.where} · ${c.format}`;
}

async function loadTeams() {
  if (!session.tournament) return;
  const { data, error } = await supabase
    .from('teams')
    .select('id, full_team_name')
    .eq('tournament_id', session.tournament.id);
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 2500 });
    return;
  }
  const map: Record<string, string> = {};
  (data as Team[]).forEach((t) => (map[t.id] = t.full_team_name));
  teamNameById.value = map;
}

function nameFor(id: string | null) {
  return (id && teamNameById.value[id]) || 'TBD';
}

function isCompleted(m: Match): boolean {
  return m.team1_score != null && m.team2_score != null;
}

function winnerSide(m: Match): 1 | 2 | null {
  if (!m.team1_id || !m.team2_id) return null;
  if (m.winner_id) {
    if (m.winner_id === m.team1_id) return 1;
    if (m.winner_id === m.team2_id) return 2;
  }
  if (!isCompleted(m)) return null;
  if (m.team1_score === m.team2_score) return null;
  return (m.team1_score ?? 0) > (m.team2_score ?? 0) ? 1 : 2;
}

function winnerName(m: Match): string | null {
  const side = winnerSide(m);
  if (side === 1) return nameFor(m.team1_id);
  if (side === 2) return nameFor(m.team2_id);
  return null;
}

function finalScoreText(m: Match): string | null {
  if (!isCompleted(m)) return null;
  if ((m.best_of ?? 1) > 1 && Array.isArray(m.set_scores) && m.set_scores.length) {
    return m.set_scores.map((x) => `${x.t1}\u2013${x.t2}`).join(', ');
  }
  return `${m.team1_score ?? 0}\u2013${m.team2_score ?? 0}`;
}

const canEditScore = computed(() => !!match.value?.team1_id && !!match.value?.team2_id);

// ---------- Match play: per-set choices ----------

const isMatchPlay = computed(() => (match.value?.best_of ?? 1) > 1);
const recordedSets = computed(() => (Array.isArray(match.value?.set_scores) ? match.value!.set_scores! : []));
const setResult = computed(() => matchResult(recordedSets.value, match.value?.best_of ?? 1));
/** Set currently being live scored (the next unrecorded set). */
const liveSetNumber = computed(() => recordedSets.value.length + 1);

type SetRow = {
  n: number;
  target: number;
  score: { t1: number; t2: number } | null;
  state: 'done' | 'next' | 'locked' | 'not-needed';
  note: string;
};

const setRows = computed<SetRow[]>(() => {
  const m = match.value;
  if (!m || !isMatchPlay.value) return [];
  const fmt = formatFromMatch(m);
  const res = setResult.value;
  const rows: SetRow[] = [];
  for (let n = 1; n <= fmt.bestOf; n++) {
    const score = recordedSets.value[n - 1] ?? null;
    let state: SetRow['state'];
    let note = '';
    if (score) {
      state = 'done';
      const w = score.t1 > score.t2 ? m.team1_id : m.team2_id;
      note = `${nameFor(w)} won`;
    } else if (res.complete) {
      state = 'not-needed';
      note = 'Not needed';
    } else if (n === recordedSets.value.length + 1) {
      state = 'next';
      note = isLiveActive(m) ? 'Live now' : 'Up next';
    } else {
      state = 'locked';
      note = n === 3 ? 'Only played if sets are 1–1' : `Finish Set ${n - 1} first`;
    }
    rows.push({ n, target: targetForSet(fmt, n), score, state, note });
  }
  return rows;
});

const selectedSet = ref<number | null>(null);
function selectSet(row: SetRow) {
  if (row.state === 'locked' || row.state === 'not-needed') return;
  selectedSet.value = selectedSet.value === row.n ? null : row.n;
}

const matchWinnerText = computed(() => {
  const m = match.value;
  if (!m || !isMatchPlay.value || !isCompleted(m)) return '';
  const r = setResult.value;
  const name = winnerName(m);
  if (!name) return '';
  return `${name} wins the match ${Math.max(r.setsWon1, r.setsWon2)}–${Math.min(r.setsWon1, r.setsWon2)}`;
});

function goManual(setNumber?: number) {
  if (!match.value) return;
  if (!canEditScore.value) {
    toast.add({ severity: 'warn', summary: 'Teams not set', detail: 'Cannot enter a score until both teams are assigned.', life: 2200 });
    return;
  }
  const query: Record<string, string> = {};
  if (from.value) query.from = from.value;
  if (setNumber) query.set = String(setNumber);
  router.push({ name: 'match-score', params: { accessCode: accessCode.value, matchId: match.value.id }, query });
}

function goLive() {
  if (!match.value) return;
  if (!canEditScore.value) {
    toast.add({ severity: 'warn', summary: 'Teams not set', detail: 'Cannot start live scoring until both teams are assigned.', life: 2200 });
    return;
  }
  router.push({ name: 'match-live', params: { accessCode: accessCode.value, matchId: match.value.id }, query: from.value ? { from: from.value } : undefined });
}

const backLabel = computed(() => {
  if (from.value === 'admin-bracket') return 'Back to Admin Bracket';
  if (match.value?.match_type === 'bracket') return 'Back to Bracket';
  return 'Back to Pool';
});

function backToContext() {
  if (from.value === 'admin-bracket') {
    router.push({ name: 'admin-bracket' });
    return;
  }

  if (match.value?.match_type === 'bracket') {
    router.push({ name: 'public-bracket', params: { accessCode: accessCode.value } });
    return;
  }

  if (!match.value?.pool_id) {
    router.push({ name: 'public-pool-list', params: { accessCode: accessCode.value } });
    return;
  }
  router.push({ name: 'public-pool-details', params: { accessCode: accessCode.value, poolId: match.value.pool_id } });
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  nowTimer = setInterval(() => (now.value = Date.now()), 15_000);
  loading.value = true;
  try {
    await ensureTournament();
    await loadTeams();
    await loadMatch();
    await subscribeRealtime();
  } finally {
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  if (nowTimer) {
    clearInterval(nowTimer);
    nowTimer = null;
  }
  if (channel) {
    void channel.unsubscribe();
    channel = null;
  }
});
</script>

<template>
  <PublicLayout>
    <section class="p-5 sm:p-7">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <UiBackButton
            class="shrink-0"
            :on-click="backToContext"
            :aria-label="backLabel"
          />
          <h2 class="text-2xl font-semibold text-ink truncate">Match</h2>
        </div>
        <div v-if="loading" class="text-sm text-ink/80 shrink-0">Loading…</div>
      </div>

      <div v-if="match" class="mt-3">
        <div class="flex items-center justify-between">
          <div class="text-sm text-ink/80">
            {{ contextLabel || `Round ${match.round_number ?? '—'} • ${match.match_type === 'bracket' ? 'Bracket' : 'Pool'}` }}
          </div>
          <div
            v-if="isLiveActive(match)"
            class="inline-flex items-center gap-2 rounded-full bg-red-600 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white"
          >
            <span class="size-2 rounded-full bg-white/90"></span>
            LIVE
            <span class="tabular-nums">{{ match.live_score_team1 ?? 0 }}-{{ match.live_score_team2 ?? 0 }}</span>
          </div>
        </div>
        <div class="mt-2">
          <div class="text-xl font-semibold text-ink leading-tight">
            {{ nameFor(match.team1_id) }}
          </div>
          <div class="text-sm font-medium text-ink/70 leading-tight">
            vs
          </div>
          <div class="text-xl font-semibold text-ink leading-tight">
            {{ nameFor(match.team2_id) }}
          </div>
        </div>

        <div
          v-if="isLiveActive(match)"
          class="mt-5 rounded-2xl bg-ink/10 p-4 text-ink ring-2 ring-red-500/60"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="text-sm font-semibold uppercase tracking-wide text-ink/80">Live Score<template v-if="isMatchPlay"> · Set {{ liveSetNumber }}</template></div>
            <div class="inline-flex items-center gap-2 rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-white whitespace-nowrap">
              <span class="size-2 rounded-full bg-white/90"></span>
              LIVE <span class="tabular-nums">{{ match.live_score_team1 ?? 0 }}-{{ match.live_score_team2 ?? 0 }}</span>
            </div>
          </div>
          <div class="mt-3 grid grid-cols-2 gap-3">
            <div class="rounded-xl bg-ink/5 ring-1 ring-ink/15 p-3">
              <div class="text-xs font-medium text-ink/70 truncate">{{ nameFor(match.team1_id) }}</div>
              <div class="mt-1 text-4xl font-black tabular-nums text-ink">{{ match.live_score_team1 ?? 0 }}</div>
            </div>
            <div class="rounded-xl bg-ink/5 ring-1 ring-ink/15 p-3">
              <div class="text-xs font-medium text-ink/70 truncate">{{ nameFor(match.team2_id) }}</div>
              <div class="mt-1 text-4xl font-black tabular-nums text-ink">{{ match.live_score_team2 ?? 0 }}</div>
            </div>
          </div>
        </div>

        <div
          v-else-if="isCompleted(match)"
          class="mt-5 rounded-2xl bg-ink/10 p-4 text-ink ring-1 ring-ink/20"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="text-sm font-semibold uppercase tracking-wide text-ink/80">{{ (match.best_of ?? 1) > 1 ? 'Final · sets won' : 'Final' }}</div>
            <div class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide bg-ink/10 ring-1 ring-ink/20 text-ink whitespace-nowrap">
              <span class="tabular-nums">{{ finalScoreText(match) }}</span>
            </div>
          </div>
          <div class="mt-3 grid grid-cols-2 gap-3">
            <div class="rounded-xl bg-ink/5 ring-1 ring-ink/15 p-3">
              <div
                class="text-xs font-medium text-ink/70 truncate"
                :class="winnerSide(match) === 2 ? 'opacity-70 line-through decoration-2 decoration-ink/70' : ''"
              >
                {{ nameFor(match.team1_id) }}
              </div>
              <div class="mt-1 text-4xl font-black tabular-nums text-ink">{{ match.team1_score ?? 0 }}</div>
            </div>
            <div class="rounded-xl bg-ink/5 ring-1 ring-ink/15 p-3">
              <div
                class="text-xs font-medium text-ink/70 truncate"
                :class="winnerSide(match) === 1 ? 'opacity-70 line-through decoration-2 decoration-ink/70' : ''"
              >
                {{ nameFor(match.team2_id) }}
              </div>
              <div class="mt-1 text-4xl font-black tabular-nums text-ink">{{ match.team2_score ?? 0 }}</div>
            </div>
          </div>
          <div class="mt-3 flex items-center justify-between gap-3">
            <div class="text-sm text-ink/80">Winner</div>
            <div
              v-if="winnerName(match)"
              class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-extrabold tracking-wide uppercase bg-amber-300/90 text-tone-900 ring-1 ring-amber-200/70 max-w-[70%] truncate"
            >
              {{ winnerName(match) }}
            </div>
            <div v-else class="text-sm text-ink/70">—</div>
          </div>
        </div>

        <!-- Match play: pick a set, then choose how to score it -->
        <div v-if="isMatchPlay" class="mt-6">
          <div
            v-if="matchWinnerText"
            class="mb-4 flex items-center gap-3 rounded-2xl bg-yellow-400 px-4 py-3 text-slate-900 shadow-lg"
            role="status"
          >
            <i class="pi pi-trophy text-2xl" aria-hidden="true" />
            <div class="text-lg font-black leading-tight">{{ matchWinnerText }}</div>
          </div>
          <div v-else class="mb-3 flex items-center justify-between text-sm text-ink/80">
            <span>Best of 3 — choose a set</span>
            <span v-if="setResult.setsWon1 + setResult.setsWon2 > 0" class="font-semibold tabular-nums text-ink">
              Sets {{ setResult.setsWon1 }}–{{ setResult.setsWon2 }}
            </span>
          </div>

          <div class="grid gap-3">
            <div
              v-for="row in setRows"
              :key="row.n"
              class="rounded-2xl ring-1 transition"
              :class="[
                row.state === 'locked' || row.state === 'not-needed' ? 'bg-ink/5 ring-ink/10 opacity-60' : 'bg-ink/10 ring-ink/20',
                selectedSet === row.n ? 'ring-2 ring-amber-400' : '',
                row.state === 'next' && isLiveActive(match) ? 'ring-2 ring-red-500/60' : '',
              ]"
            >
              <button
                type="button"
                class="flex w-full items-center gap-3 px-4 py-4 text-left"
                :class="row.state === 'locked' || row.state === 'not-needed' ? 'cursor-not-allowed' : 'cursor-pointer'"
                :disabled="row.state === 'locked' || row.state === 'not-needed' || !canEditScore"
                :aria-expanded="selectedSet === row.n"
                @click="selectSet(row)"
              >
                <div class="min-w-0 flex-1">
                  <div class="text-lg font-semibold text-ink">Set {{ row.n }} <span class="text-sm font-normal text-ink/70">to {{ row.target }}</span></div>
                  <div class="text-sm" :class="row.state === 'next' && isLiveActive(match) ? 'font-semibold text-red-500' : 'text-ink/70'">{{ row.note }}</div>
                </div>
                <div v-if="row.score" class="shrink-0 text-2xl font-black tabular-nums text-ink">{{ row.score.t1 }}–{{ row.score.t2 }}</div>
                <div v-else-if="row.state === 'next' && isLiveActive(match)" class="shrink-0 text-2xl font-black tabular-nums text-ink">
                  {{ match.live_score_team1 ?? 0 }}–{{ match.live_score_team2 ?? 0 }}
                </div>
                <i v-if="row.state === 'locked' || row.state === 'not-needed'" class="pi pi-lock shrink-0 text-ink/50" aria-hidden="true" />
                <i v-else class="pi shrink-0 text-ink/60" :class="selectedSet === row.n ? 'pi-chevron-up' : 'pi-chevron-down'" aria-hidden="true" />
              </button>

              <div v-if="selectedSet === row.n" class="grid grid-cols-1 gap-3 px-4 pb-4 sm:grid-cols-2">
                <Button
                  :label="row.state === 'done' ? 'Edit Set Score' : 'Enter Final Score'"
                  icon="pi pi-pencil"
                  severity="secondary"
                  size="large"
                  class="!rounded-2xl !px-6 !py-4 !text-lg !font-semibold text-ink bg-ink/10 ring-1 ring-ink/20"
                  @click="goManual(row.n)"
                />
                <Button
                  v-if="row.state === 'next'"
                  :label="isLiveActive(match) ? 'View Live Score' : 'Use Live Scoreboard'"
                  icon="pi pi-bolt"
                  severity="secondary"
                  size="large"
                  class="!rounded-2xl !px-6 !py-4 !text-lg !font-semibold text-ink bg-ink/10 ring-1 ring-ink/20"
                  @click="goLive"
                />
              </div>
            </div>
          </div>
        </div>

        <div v-else class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Button
            label="Enter Final Score"
            icon="pi pi-pencil"
            :disabled="!canEditScore"
            severity="secondary"
            size="large"
            class="!rounded-2xl !px-6 !py-4 !text-lg !font-semibold text-ink bg-ink/10 ring-1 ring-ink/20"
            @click="goManual()"
          />
          <Button
            :label="isLiveActive(match) ? 'View Live Score' : 'Use Live Scoreboard'"
            icon="pi pi-bolt"
            :disabled="!canEditScore"
            severity="secondary"
            size="large"
            class="!rounded-2xl !px-6 !py-4 !text-lg !font-semibold text-ink bg-ink/10 ring-1 ring-ink/20"
            @click="goLive"
          />
        </div>

      </div>
    </section>
  </PublicLayout>
</template>
