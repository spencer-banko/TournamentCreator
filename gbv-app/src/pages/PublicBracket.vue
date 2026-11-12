<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import PublicLayout from '../components/layout/PublicLayout.vue';
import BracketView from '../components/BracketView.vue';
import { loadBrackets } from '../lib/bracket';
import { formatFromMatch } from '../lib/scoring';
import { medalFor, placesLabel } from '../lib/bracketStyle';
import type { Bracket, SetScore } from '../types/db';

type UUID = string;

type Team = { id: UUID; full_team_name: string };

type Match = {
  id: UUID;
  tournament_id: UUID;
  pool_id: UUID | null;
  round_number: number | null;
  team1_id: UUID | null;
  team2_id: UUID | null;
  team1_score: number | null;
  team2_score: number | null;
  is_live: boolean;
  live_score_team1: number | null;
  live_score_team2: number | null;
  live_owner_id: UUID | null;
  live_last_active_at: string | null;
  winner_id: UUID | null;
  match_type: 'pool' | 'bracket';
  bracket_round: number | null;
  bracket_match_index: number | null;
  bracket_id: UUID | null;
  best_of: number | null;
  set_targets: number[] | null;
  set_scores: SetScore[] | null;
  court: string | null;
};

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const toast = useToast();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const loading = ref(false);
const hasBracket = computed(() => {
  const t = session.tournament;
  return !!t && (t.status === 'bracket' || t.status === 'completed' || !!t.bracket_generated_at);
});

const bracketChromeHidden = ref(false);
const mobileBracketOffsetPx = computed(() => (bracketChromeHidden.value ? 110 : 200));
function onBracketViewportScroll(pos: { left: number; top: number }) {
  bracketChromeHidden.value = pos.left > 0 || pos.top > 0;
}

const allMatches = ref<Match[]>([]);
const brackets = ref<Bracket[]>([]);
const selectedId = ref<string | null>(null);

/** Brackets that have matches; legacy matches without a bracket_id show under one tab. */
const tabs = computed(() => {
  const withMatches = brackets.value.filter((b) => allMatches.value.some((m) => m.bracket_id === b.id));
  const orphan = allMatches.value.some((m) => !m.bracket_id || !brackets.value.some((b) => b.id === m.bracket_id));
  const list = withMatches.map((b, i) => ({ id: b.id as string, name: b.name, places: b.places, medal: medalFor(b.name, i) }));
  if (orphan) list.push({ id: '__legacy', name: list.length ? 'Other' : 'Bracket', places: [], medal: medalFor('', list.length) });
  return list;
});
const selectedTab = computed(() => tabs.value.find((t) => t.id === selectedId.value) ?? tabs.value[0] ?? null);
const matches = computed<Match[]>(() => {
  const tab = selectedTab.value;
  if (!tab) return [];
  if (tab.id === '__legacy') return allMatches.value.filter((m) => !m.bracket_id || !brackets.value.some((b) => b.id === m.bracket_id));
  return allMatches.value.filter((m) => m.bracket_id === tab.id);
});
const roundFormats = computed<Record<number, string>>(() => {
  const out: Record<number, string> = {};
  for (const m of matches.value) {
    const r = m.bracket_round ?? 1;
    if (out[r]) continue;
    const f = formatFromMatch(m);
    out[r] = f.bestOf > 1 ? `Best of 3 · ${f.setTargets.join(', ')}` : `1 set to ${f.setTargets[0]}`;
  }
  return out;
});
function selectTab(id: string) {
  selectedId.value = id;
  router.replace({ query: { ...route.query, b: tabs.value.find((t) => t.id === id)?.name ?? undefined } });
}
function championFor(list: Match[]): string | null {
  if (!list.length) return null;
  const maxRound = Math.max(0, ...list.map((m) => m.bracket_round ?? 0));
  const f = list.find((m) => (m.bracket_round ?? 0) === maxRound && (m.bracket_match_index ?? 0) === 0);
  if (!f || f.team1_score == null) return null;
  const w = winnerIdFor(f);
  return w ? teamNameById.value[w] ?? 'TBD' : null;
}
const teamNameById = ref<Record<string, string>>({});
const courts = ref<string[]>([]);

let refreshTimer: ReturnType<typeof setInterval> | null = null;

function winnerIdFor(m: Match): string | null {
  const winId = m.winner_id ?? null;
  const t1 = m.team1_id ?? null;
  const t2 = m.team2_id ?? null;
  if (winId && (winId === t1 || winId === t2)) return winId;
  if (t1 && t2 && m.team1_score != null && m.team2_score != null) {
    const s1 = m.team1_score ?? 0;
    const s2 = m.team2_score ?? 0;
    if (s1 === s2) return null;
    return s1 > s2 ? t1 : t2;
  }
  return null;
}

const championName = computed(() => championFor(matches.value));

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

async function loadMatches() {
  if (!session.tournament) {
    allMatches.value = [];
    return;
  }
  const { data, error } = await supabase
    .from('matches')
    .select('id,tournament_id,pool_id,round_number,team1_id,team2_id,team1_score,team2_score,is_live,live_score_team1,live_score_team2,live_owner_id,live_last_active_at,winner_id,match_type,bracket_round,bracket_match_index,bracket_id,best_of,set_targets,set_scores,court')
    .eq('tournament_id', session.tournament.id)
    .eq('match_type', 'bracket')
    .order('bracket_round', { ascending: true })
    .order('bracket_match_index', { ascending: true });

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load bracket', detail: error.message, life: 3000 });
    allMatches.value = [];
    return;
  }
  allMatches.value = (data as Match[]) ?? [];
}

async function loadCourts() {
  if (!session.tournament) {
    courts.value = [];
    return;
  }
  const { data, error } = await supabase
    .from('pools')
    .select('court_assignment')
    .eq('tournament_id', session.tournament.id);
  if (error) {
    courts.value = [];
    return;
  }
  const vals = ((data as Array<{ court_assignment: string | null }>) ?? [])
    .map((p) => (p.court_assignment ?? '').trim())
    .filter(Boolean);

  const uniq = Array.from(new Set(vals));
  uniq.sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const aNum = Number.isFinite(na);
    const bNum = Number.isFinite(nb);
    if (aNum && bNum) return na - nb;
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    return a.localeCompare(b);
  });
  courts.value = uniq;
}

function openMatch(m: Match) {
  router.push({ name: 'match-actions', params: { accessCode: accessCode.value, matchId: m.id } });
}
function openMatchById(id: string) {
  const m = allMatches.value.find(mm => mm.id === id);
  if (m) openMatch(m);
}

// Realtime subscription
let channel: ReturnType<typeof supabase.channel> | null = null;

async function subscribeRealtime() {
  if (!session.tournament) return;
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
  channel = supabase
    .channel('bracket_matches_' + session.tournament.id)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'matches', filter: `tournament_id=eq.${session.tournament.id}` },
      async (payload) => {
        if (import.meta.env.DEV) console.debug('[Realtime] PublicBracket event', payload);
        const row = (payload.new ?? payload.old) as Match;
        if (row.match_type === 'bracket') {
          await loadMatches();
        }
      }
    );

  await channel.subscribe((status) => {
    if (import.meta.env.DEV) console.debug('[Realtime] PublicBracket status', status);
  });
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  loading.value = true;
  try {
    await ensureTournament();
    if (!hasBracket.value) {
      toast.add({ severity: 'info', summary: 'Bracket is locked', detail: 'The bracket will unlock after it is generated.', life: 2500 });
      await router.replace({ name: 'public-pool-list', params: { accessCode: accessCode.value } });
      return;
    }
    await loadTeams();
    try {
      brackets.value = await loadBrackets(session.tournament!.id);
    } catch {
      brackets.value = [];
    }
    await loadMatches();
    const wanted = String(route.query.b ?? '').toLowerCase();
    selectedId.value = tabs.value.find((t) => t.name.toLowerCase() === wanted)?.id ?? tabs.value[0]?.id ?? null;
    await loadCourts();
    await subscribeRealtime();
    refreshTimer = setInterval(() => void loadMatches(), 15_000);
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
    <section
      class="px-5 sm:px-7 pb-2"
      :class="bracketChromeHidden ? 'pt-2 sm:pt-3' : 'pt-5 sm:pt-7'"
    >
      <div v-show="!bracketChromeHidden" class="mb-4 flex items-center gap-2 rounded-xl border border-ink/20 bg-ink/5 p-2">
        <router-link
          :to="{ name: 'public-pool-list', params: { accessCode } }"
          class="inline-flex items-center rounded-lg px-3 py-2 text-sm font-semibold text-ink/85 transition-colors hover:bg-ink/10"
        >
          Pool Play
        </router-link>
        <router-link
          :to="{ name: 'public-bracket', params: { accessCode } }"
          class="inline-flex items-center rounded-lg px-3 py-2 text-sm font-semibold bg-amber-400/20 text-ink ring-1 ring-amber-400/60"
        >
          Bracket
        </router-link>
      </div>
      <div v-show="!bracketChromeHidden" class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-2xl font-semibold text-ink">{{ tabs.length > 1 && selectedTab ? `${selectedTab.name} Bracket` : 'Bracket' }}</h2>
          <p class="mt-1 text-ink/80">
            <template v-if="selectedTab && selectedTab.places.length">{{ placesLabel(selectedTab.places) }} · </template>Tap a match for details or to enter a score.
          </p>
        </div>
        <div class="flex items-center gap-2">
          <router-link
            :to="{ name: 'public-leaderboard', params: { accessCode } }"
            class="inline-flex items-center rounded-full bg-ink/10 px-3 py-1 text-xs font-semibold text-ink ring-1 ring-ink/20 hover:bg-ink/15 transition-colors whitespace-nowrap"
          >
            Leaderboard
          </router-link>
          <div v-if="loading" class="text-sm text-ink/80">Loading…</div>
        </div>
      </div>

      <nav
        v-if="tabs.length > 1"
        v-show="!bracketChromeHidden"
        class="mt-4 flex gap-2 overflow-x-auto pb-1"
        role="tablist"
        aria-label="Brackets"
      >
        <button
          v-for="t in tabs"
          :key="t.id"
          type="button"
          role="tab"
          :aria-selected="t.id === selectedTab?.id"
          class="flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-bold transition"
          :class="t.id === selectedTab?.id ? 'text-ink shadow-sm' : 'text-ink/70 ring-1 ring-ink/15 hover:bg-ink/5'"
          :style="t.id === selectedTab?.id ? { background: t.medal.chip, boxShadow: `inset 0 0 0 2px ${t.medal.ring}` } : {}"
          @click="selectTab(t.id)"
        >
          <span class="h-2.5 w-2.5 rounded-full" :style="{ background: t.medal.dot }" />
          {{ t.name }}
          <span v-if="championFor(allMatches.filter((m) => (t.id === '__legacy' ? !m.bracket_id : m.bracket_id === t.id)))" class="text-xs" aria-label="complete">🏆</span>
        </button>
      </nav>

      <div
        v-if="championName && !bracketChromeHidden"
        class="mt-4 rounded-2xl bg-ink/10 ring-2 ring-amber-300/60 p-5 text-center text-ink"
      >
        <div class="text-2xl sm:text-3xl font-extrabold leading-tight">
          {{ championName }} WON{{ tabs.length > 1 && selectedTab ? ` ${selectedTab.name.toUpperCase()}` : '' }}!! 🎉🎉
        </div>
        <div class="mt-1 text-ink/80 font-medium">
          Thank you for playing!
        </div>
      </div>

      <div v-if="matches.length === 0" class="mt-6 rounded-xl border border-dashed border-ink/30 p-6 text-center text-ink/80">
        No bracket matches yet.
      </div>

      <div v-else :class="bracketChromeHidden ? '' : 'mt-4'">
        <div class="-mx-5 sm:-mx-7 -mb-10">
          <BracketView
            :matches="matches"
            :teamNameById="teamNameById"
            :courts="courts"
            :round-formats="roundFormats"
            :mobile-max-height-offset-px="mobileBracketOffsetPx"
            @viewport-scroll="onBracketViewportScroll"
            @open="openMatchById"
          />
        </div>
      </div>
    </section>
  </PublicLayout>
</template>
