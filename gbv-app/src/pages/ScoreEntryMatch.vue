<script setup lang="ts">
/**
 * Player score entry. Single-set matches take one score per team; best-of-3 matches take
 * one score per set, and Set 3 only appears when the match is 1–1. Every set is checked
 * against its target (win by 2, cap) before it can be submitted.
 */
import { ref, onMounted, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import PublicLayout from '../components/layout/PublicLayout.vue';
import { advanceWinnerToNextById } from '../lib/bracket';
import { poolFormatForSize } from '../lib/schedule';
import { formatFromMatch, formatLabel, matchResult, targetForSet, validateSet, validateMatch } from '../lib/scoring';
import UiBackButton from '../components/ui/UiBackButton.vue';
import type { MatchFormat, SetScore } from '../types/db';

type UUID = string;
type Team = { id: UUID; full_team_name: string; pool_id: UUID | null };
type Match = {
  id: UUID;
  pool_id: UUID | null;
  round_number: number | null;
  bracket_round: number | null;
  team1_id: UUID | null;
  team2_id: UUID | null;
  team1_score: number | null;
  team2_score: number | null;
  winner_id: UUID | null;
  is_live: boolean;
  live_score_team1: number | null;
  live_score_team2: number | null;
  match_type: 'pool' | 'bracket';
  best_of: number | null;
  set_targets: number[] | null;
  set_scores: SetScore[] | null;
  court: string | null;
};

const toast = useToast();
const route = useRoute();
const router = useRouter();
const session = useSessionStore();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const matchId = computed(() => route.params.matchId as string);
const from = computed(() => (route.query.from as string | undefined) ?? undefined);

const loading = ref(false);
const submitting = ref(false);
const teams = ref<Team[]>([]);
const match = ref<Match | null>(null);

/** Per-set entry; null = not entered yet. */
const sets = ref<Array<{ t1: number | null; t2: number | null }>>([{ t1: null, t2: null }]);

const canEditScore = computed(() => !!match.value?.team1_id && !!match.value?.team2_id);

const format = computed<MatchFormat>(() => {
  const m = match.value;
  if (!m) return { bestOf: 1, setTargets: [21], cap: null, winBy2: true };
  const base = formatFromMatch(m);
  // Pool matches inherit the cap configured for that pool size.
  if (m.match_type === 'pool' && m.pool_id) {
    const size = teams.value.filter((t) => t.pool_id === m.pool_id).length;
    const rule = poolFormatForSize(session.tournament?.game_rules, size);
    if (rule.bestOf === base.bestOf) return { ...base, cap: rule.cap ?? null, winBy2: rule.winBy2 !== false };
  }
  return base;
});
const isMatchPlay = computed(() => format.value.bestOf > 1);

const filledSets = computed<SetScore[]>(() =>
  sets.value.filter((s) => s.t1 != null && s.t2 != null).map((s) => ({ t1: s.t1 as number, t2: s.t2 as number }))
);
const result = computed(() => matchResult(filledSets.value, format.value.bestOf));

/** Show Set 1 and 2 for match play; Set 3 only at 1–1. */
function syncSetRows() {
  const want = isMatchPlay.value ? Math.max(2, result.value.complete ? result.value.setsWon1 + result.value.setsWon2 : Math.min(3, result.value.setsWon1 + result.value.setsWon2 + 1)) : 1;
  while (sets.value.length < want) sets.value.push({ t1: null, t2: null });
  while (sets.value.length > want) sets.value.pop();
}
watch(() => filledSets.value.map((s) => `${s.t1}-${s.t2}`).join('|') + `:${format.value.bestOf}`, syncSetRows);

function setError(i: number): string | null {
  const s = sets.value[i];
  if (!s || s.t1 == null || s.t2 == null) return null;
  return validateSet({ t1: s.t1, t2: s.t2 }, targetForSet(format.value, i + 1), format.value.cap ?? null, format.value.winBy2 !== false);
}

const errors = computed(() => validateMatch(filledSets.value, format.value));
const ready = computed(() => canEditScore.value && filledSets.value.length > 0 && errors.value.length === 0);

const summary = computed(() => {
  if (!match.value || !result.value.complete) return '';
  const w = result.value.winner === 1 ? match.value.team1_id : match.value.team2_id;
  if (!isMatchPlay.value) return `${nameFor(w)} wins`;
  return `${nameFor(w)} wins ${Math.max(result.value.setsWon1, result.value.setsWon2)}–${Math.min(result.value.setsWon1, result.value.setsWon2)}`;
});

function nameFor(id: string | null) {
  return teams.value.find((t) => t.id === id)?.full_team_name ?? 'TBD';
}

function bump(i: number, side: 't1' | 't2', delta: number) {
  const s = sets.value[i];
  const v = (s[side] ?? 0) + delta;
  s[side] = Math.max(0, Math.min(99, v));
}
function onInput(i: number, side: 't1' | 't2', raw: string) {
  const n = raw.trim() === '' ? null : Math.max(0, Math.min(99, Math.floor(Number(raw))));
  sets.value[i][side] = n == null || Number.isNaN(n) ? null : n;
}

async function ensureTournament() {
  if (!accessCode.value) return;
  await session.ensureAnon();
  if (!session.tournament) {
    const t = await session.loadTournamentByCode(accessCode.value);
    if (!t) toast.add({ severity: 'warn', summary: 'Not found', detail: 'Invalid tournament code', life: 2500 });
  }
}

async function loadTeams() {
  if (!session.tournament) return;
  const { data, error } = await supabase.from('teams').select('id, full_team_name, pool_id').eq('tournament_id', session.tournament.id);
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 2500 });
    return;
  }
  teams.value = (data as Team[]) ?? [];
}

async function loadMatch() {
  if (!session.tournament || !matchId.value) return;
  const { data, error } = await supabase
    .from('matches')
    .select('id,pool_id,round_number,bracket_round,team1_id,team2_id,team1_score,team2_score,winner_id,is_live,live_score_team1,live_score_team2,match_type,best_of,set_targets,set_scores,court')
    .eq('tournament_id', session.tournament.id)
    .eq('id', matchId.value)
    .single();
  if (error || !data) {
    toast.add({ severity: 'error', summary: 'Failed to load match', detail: error?.message ?? 'Not found', life: 3000 });
    return;
  }
  const m = data as Match;
  match.value = m;
  const f = formatFromMatch(m);
  if (f.bestOf > 1 && Array.isArray(m.set_scores) && m.set_scores.length) {
    sets.value = m.set_scores.map((s) => ({ t1: s.t1, t2: s.t2 }));
  } else if (f.bestOf === 1 && m.team1_score != null && m.team2_score != null) {
    sets.value = [{ t1: m.team1_score, t2: m.team2_score }];
  } else if (m.live_score_team1 != null || m.live_score_team2 != null) {
    sets.value = [{ t1: m.live_score_team1 ?? 0, t2: m.live_score_team2 ?? 0 }];
  } else {
    sets.value = [{ t1: null, t2: null }];
  }
  syncSetRows();
}

async function submitScore() {
  const m = match.value;
  if (!m || !session.tournament) return;
  if (!canEditScore.value) {
    toast.add({ severity: 'warn', summary: 'Teams not set', detail: 'A score can be entered once both teams are assigned.', life: 2500 });
    return;
  }
  if (errors.value.length) {
    toast.add({ severity: 'warn', summary: 'Check the score', detail: errors.value[0], life: 3500 });
    return;
  }
  if (m.match_type === 'pool' && (session.tournament.status === 'bracket' || session.tournament.bracket_started)) {
    toast.add({ severity: 'warn', summary: 'Brackets already generated', detail: 'Changing a pool score now may require the brackets to be regenerated.', life: 3500 });
  }

  const r = result.value;
  const used = filledSets.value.slice(0, r.setsWon1 + r.setsWon2);
  const winner_id = r.winner === 1 ? m.team1_id : m.team2_id;
  const payload = isMatchPlay.value
    ? { team1_score: r.setsWon1, team2_score: r.setsWon2, set_scores: used }
    : { team1_score: used[0].t1, team2_score: used[0].t2, set_scores: null };

  submitting.value = true;
  try {
    const { data, error } = await supabase
      .from('matches')
      .update({ ...payload, winner_id, is_live: false, live_score_team1: null, live_score_team2: null })
      .eq('id', m.id)
      .select('id')
      .single();
    if (error) {
      toast.add({ severity: 'error', summary: 'Submit failed', detail: error.message, life: 3000 });
      return;
    }
    if (!data) {
      toast.add({ severity: 'error', summary: 'Score not saved', detail: 'The update was blocked. Ask the tournament director to enter it.', life: 4000 });
      return;
    }
    if (m.match_type === 'bracket') {
      await supabase.from('tournaments').update({ bracket_started: true }).eq('id', session.tournament.id).eq('bracket_started', false);
      if (winner_id) await advanceWinnerToNextById(session.tournament.id, m.id);
    }
    toast.add({ severity: 'success', summary: 'Score submitted', life: 1800 });
    if (m.match_type === 'pool' && m.pool_id) {
      router.push({ name: 'public-pool-details', params: { accessCode: accessCode.value, poolId: m.pool_id } });
    } else if (m.match_type === 'bracket') {
      router.push({ name: 'public-bracket', params: { accessCode: accessCode.value } });
    } else {
      backToMatch();
    }
  } finally {
    submitting.value = false;
  }
}

function backToMatch() {
  if (!match.value) {
    router.push({ name: 'public-pool-list', params: { accessCode: accessCode.value } });
    return;
  }
  router.push({ name: 'match-actions', params: { accessCode: accessCode.value, matchId: match.value.id }, query: from.value ? { from: from.value } : undefined });
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  loading.value = true;
  try {
    await ensureTournament();
    await loadTeams();
    await loadMatch();
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <PublicLayout>
    <section class="p-5 sm:p-7">
      <div class="flex items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          <UiBackButton class="shrink-0" :on-click="backToMatch" aria-label="Back to Match" />
          <h2 class="truncate text-2xl font-semibold text-ink">Enter Score</h2>
        </div>
        <div v-if="loading" class="shrink-0 text-sm text-ink/80">Loading…</div>
      </div>

      <div v-if="match" class="mt-4 rounded-2xl border border-tone-600/40 bg-tone-800/50 p-4">
        <div class="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-tone-400">
          <span>{{ match.match_type === 'bracket' ? 'Bracket' : 'Pool' }}{{ match.round_number ? ` · Round ${match.round_number}` : '' }}</span>
          <span class="rounded-full bg-amber-500/15 px-2 py-0.5 normal-case tracking-normal text-amber-400">{{ formatLabel(format) }}</span>
        </div>
        <p v-if="isMatchPlay" class="mt-2 text-sm text-tone-300">
          First to win 2 sets. Set 3 to {{ targetForSet(format, 3) }} is only played at 1–1.
        </p>
        <p v-else class="mt-2 text-sm text-tone-300">
          One set to {{ format.setTargets[0] }}{{ format.cap ? `, cap ${format.cap}` : '' }}, win by 2.
        </p>
      </div>

      <div v-if="match" class="mt-5 grid gap-4">
        <div
          v-for="(s, i) in sets"
          :key="i"
          class="rounded-2xl border p-4 transition"
          :class="setError(i) ? 'border-red-500/50 bg-red-500/5' : 'border-tone-600/40 bg-tone-800/30'"
        >
          <div v-if="isMatchPlay" class="mb-3 flex items-center justify-between text-sm">
            <span class="font-semibold text-ink">Set {{ i + 1 }}</span>
            <span class="text-tone-400">to {{ targetForSet(format, i + 1) }}</span>
          </div>
          <div v-for="side in (['t1', 't2'] as const)" :key="side" class="flex items-center gap-3 py-1.5">
            <span class="min-w-0 flex-1 truncate text-base font-semibold text-ink">
              {{ nameFor(side === 't1' ? match.team1_id : match.team2_id) }}
            </span>
            <div class="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                class="h-11 w-11 rounded-xl border border-tone-600/60 bg-tone-800 text-xl font-bold text-ink active:scale-95 disabled:opacity-40"
                :disabled="!canEditScore || (s[side] ?? 0) <= 0"
                :aria-label="`Decrease ${nameFor(side === 't1' ? match.team1_id : match.team2_id)} set ${i + 1} score`"
                @click="bump(i, side, -1)"
              >
                −
              </button>
              <input
                :value="s[side] ?? ''"
                inputmode="numeric"
                pattern="[0-9]*"
                placeholder="–"
                :disabled="!canEditScore"
                :aria-label="`${nameFor(side === 't1' ? match.team1_id : match.team2_id)} set ${i + 1} score`"
                class="h-11 w-16 rounded-xl border border-tone-600/60 bg-white text-center text-2xl font-bold tabular-nums text-slate-900 placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400"
                @input="onInput(i, side, ($event.target as HTMLInputElement).value)"
                @focus="($event.target as HTMLInputElement).select()"
              />
              <button
                type="button"
                class="h-11 w-11 rounded-xl border border-tone-600/60 bg-tone-800 text-xl font-bold text-ink active:scale-95 disabled:opacity-40"
                :disabled="!canEditScore"
                :aria-label="`Increase ${nameFor(side === 't1' ? match.team1_id : match.team2_id)} set ${i + 1} score`"
                @click="bump(i, side, 1)"
              >
                +
              </button>
            </div>
          </div>
          <p v-if="setError(i)" class="mt-2 text-sm font-medium text-red-400">{{ setError(i) }}</p>
        </div>
      </div>

      <div v-if="match" class="mt-5 min-h-[1.5rem] text-center text-base font-semibold" :class="summary ? 'text-emerald-400' : 'text-tone-400'">
        <template v-if="!canEditScore">Waiting for both teams to be set.</template>
        <template v-else-if="summary">{{ summary }}</template>
        <template v-else-if="isMatchPlay && result.setsWon1 + result.setsWon2 > 0">Sets {{ result.setsWon1 }}–{{ result.setsWon2 }}</template>
      </div>

      <div class="mt-4 flex items-center justify-center">
        <Button
          :disabled="!ready || submitting"
          :loading="submitting"
          label="Submit Score"
          size="large"
          icon="pi pi-check-circle"
          class="!rounded-2xl !border-none !bg-amber-500 !px-8 !py-4 !text-lg !font-semibold !text-white disabled:!opacity-50"
          @click="submitScore"
        />
      </div>
    </section>
  </PublicLayout>
</template>
