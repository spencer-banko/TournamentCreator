<script setup lang="ts">
/**
 * Pool schedule + matches. The top card generates (or regenerates / resets / deletes) the
 * pool-play schedule from the schedule templates. Below, every pool match is grouped by pool
 * and round: click a match to change teams, ref, round, court, format or score, or drag it
 * onto another round (or the "new round" drop zone) to change when it's played.
 */
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import Button from 'primevue/button';
import { useConfirmAsync } from '../lib/useConfirmAsync';
import { adminBtnPillPt, adminBtnGreenPillClass } from '@/lib/adminButtonStyles';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import MatchEditDialog from '@/components/admin/MatchEditDialog.vue';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import { useAdminProgressStore } from '../stores/adminProgress';
import { poolFormatForSize, checkPrerequisites, generateSchedule, type GenerateResult } from '../lib/schedule';
import { rankPool, DEFAULT_TIEBREAKERS } from '../lib/standings';
import { formatFromMatch, formatLabel, setsOf } from '../lib/scoring';
import type { Match, Pool, Tournament } from '../types/db';

type Team = { id: string; full_team_name: string; pool_id: string | null; seed_in_pool: number | null; seed_global: number | null };

const router = useRouter();
const toast = useToast();
const confirm = useConfirm();
const askConfirm = useConfirmAsync();
const session = useSessionStore();
const progress = useAdminProgressStore();

const pools = ref<Pool[]>([]);
const teams = ref<Team[]>([]);
const matches = ref<Match[]>([]);
const loading = ref(false);
const busy = ref<string | null>(null);
const filterPool = ref<string | 'all'>('all');

const editing = ref<Match | null>(null);
const editOpen = ref(false);

const tournament = computed<Tournament | null>(() => session.tournament as Tournament | null);
const nameOf = computed(() => new Map(teams.value.map((t) => [t.id, t.full_team_name])));

const poolBlocks = computed(() =>
  pools.value
    .filter((p) => filterPool.value === 'all' || p.id === filterPool.value)
    .map((p) => {
      const pTeams = teams.value.filter((t) => t.pool_id === p.id);
      const pMatches = matches.value
        .filter((m) => m.pool_id === p.id)
        .sort((a, b) => (a.round_number ?? 0) - (b.round_number ?? 0) || a.id.localeCompare(b.id));
      const rounds = new Map<number, Match[]>();
      for (const m of pMatches) {
        const r = m.round_number ?? 0;
        rounds.set(r, [...(rounds.get(r) ?? []), m]);
      }
      const standings = rankPool(pTeams, pMatches, tournament.value?.advancement_rules?.tiebreakers ?? DEFAULT_TIEBREAKERS);
      const scored = pMatches.filter((m) => m.team1_score != null).length;
      return {
        pool: p,
        teams: pTeams,
        format: formatLabel(poolFormatForSize(tournament.value?.game_rules, pTeams.length)),
        rounds: [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([round, ms]) => ({ round, matches: ms })),
        nextRound: Math.max(0, ...pMatches.map((m) => m.round_number ?? 0)) + 1,
        standings,
        scored,
        total: pMatches.length,
      };
    })
);

const totals = computed(() => ({
  matches: matches.value.length,
  scored: matches.value.filter((m) => m.team1_score != null).length,
}));

async function load() {
  void progress.refresh(); // keep sidebar step statuses current
  const t = tournament.value;
  if (!t) return;
  loading.value = true;
  try {
    const [p, tm, ms] = await Promise.all([
      supabase.from('pools').select('*').eq('tournament_id', t.id).order('name'),
      supabase.from('teams').select('id,full_team_name,pool_id,seed_in_pool,seed_global').eq('tournament_id', t.id),
      supabase.from('matches').select('*').eq('tournament_id', t.id).eq('match_type', 'pool'),
    ]);
    if (p.error) throw p.error;
    if (tm.error) throw tm.error;
    if (ms.error) throw ms.error;
    pools.value = (p.data as Pool[]) ?? [];
    teams.value = (tm.data as Team[]) ?? [];
    matches.value = (ms.data as Match[]) ?? [];
  } catch (e: any) {
    toast.add({ severity: 'error', summary: 'Failed to load pool matches', detail: e?.message ?? String(e), life: 3500 });
  } finally {
    loading.value = false;
  }
}

function scoreText(m: Match): string {
  if (m.team1_score == null || m.team2_score == null) return '';
  const sets = setsOf(m);
  if ((m.best_of ?? 1) > 1) return sets.map((s) => `${s.t1}–${s.t2}`).join(', ');
  return `${m.team1_score}–${m.team2_score}`;
}

function openMatch(m: Match) {
  editing.value = m;
  editOpen.value = true;
}

const editContext = computed(() => {
  const m = editing.value;
  if (!m) return '';
  const p = pools.value.find((x) => x.id === m.pool_id);
  return `${p?.name ?? 'Pool'} · Round ${m.round_number ?? '–'}`;
});
const editTeams = computed(() => {
  const m = editing.value;
  if (!m) return teams.value;
  // Pool teams first is handled by the dialog's sort; offer the pool's teams only, plus anyone already on the match.
  const ids = new Set([m.team1_id, m.team2_id, m.ref_team_id].filter(Boolean) as string[]);
  return teams.value.filter((t) => t.pool_id === m.pool_id || ids.has(t.id));
});

async function addMatch(poolId: string) {
  const t = tournament.value;
  if (!t) return;
  busy.value = `add:${poolId}`;
  try {
    const size = teams.value.filter((x) => x.pool_id === poolId).length;
    const fmt = poolFormatForSize(t.game_rules, size);
    const lastRound = Math.max(0, ...matches.value.filter((m) => m.pool_id === poolId).map((m) => m.round_number ?? 0));
    const { data, error } = await supabase
      .from('matches')
      .insert({
        tournament_id: t.id,
        pool_id: poolId,
        round_number: lastRound + 1,
        team1_id: null,
        team2_id: null,
        ref_team_id: null,
        match_type: 'pool',
        best_of: fmt.bestOf,
        set_targets: fmt.setTargets,
        is_live: false,
      })
      .select('*')
      .single();
    if (error) throw error;
    await load();
    openMatch(data as Match);
  } catch (e: any) {
    toast.add({ severity: 'error', summary: 'Could not add match', detail: e?.message ?? String(e), life: 3500 });
  } finally {
    busy.value = null;
  }
}

function deleteMatch(m: Match) {
  const label = `${nameOf.value.get(m.team1_id ?? '') ?? 'TBD'} vs ${nameOf.value.get(m.team2_id ?? '') ?? 'TBD'}`;
  confirm.require({
    header: 'Delete this match?',
    message: `${label} (round ${m.round_number ?? '–'}) and any score on it will be removed. Pool standings update right away.`,
    icon: 'pi pi-trash',
    acceptLabel: 'Delete match',
    rejectLabel: 'Keep',
    defaultFocus: 'reject',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', outlined: true },
    accept: async () => {
      busy.value = `del:${m.id}`;
      const { error } = await supabase.from('matches').delete().eq('id', m.id);
      busy.value = null;
      if (error) toast.add({ severity: 'error', summary: 'Delete failed', detail: error.message, life: 3000 });
      else toast.add({ severity: 'success', summary: 'Match deleted', life: 1800 });
      await load();
    },
  });
}

// ---------- Schedule generation (formerly the Generate Schedule page) ----------

const prereqErrors = ref<string[]>([]);
const checking = ref(false);
const generating = ref(false);
const resettingScores = ref(false);
const deletingAll = ref(false);
const lastResult = ref<GenerateResult | null>(null);
const hasMatches = computed(() => matches.value.length > 0);

async function refreshPrereqs(): Promise<boolean> {
  const t = tournament.value;
  if (!t) return false;
  checking.value = true;
  try {
    const res = await checkPrerequisites(t.id);
    prereqErrors.value = res.errors ?? [];
    return res.ok;
  } catch (e: any) {
    prereqErrors.value = [e?.message ?? 'Prerequisite check failed'];
    return false;
  } finally {
    checking.value = false;
  }
}

async function deleteAllPoolMatches(skipConfirm = false): Promise<boolean> {
  const t = tournament.value;
  if (!t) return false;
  if (!skipConfirm) {
    const ok = await askConfirm(`Delete all ${matches.value.length} pool matches (and their scores)? This cannot be undone.`);
    if (!ok) return false;
  }
  deletingAll.value = true;
  try {
    const { error } = await supabase.from('matches').delete().eq('tournament_id', t.id).eq('match_type', 'pool');
    if (error) {
      toast.add({ severity: 'error', summary: 'Delete failed', detail: error.message, life: 3000 });
      return false;
    }
    if (!skipConfirm) toast.add({ severity: 'success', summary: 'Pool matches deleted', life: 1500 });
    await load();
    return true;
  } finally {
    deletingAll.value = false;
  }
}

async function runGenerate() {
  const t = tournament.value;
  if (!t) return;
  lastResult.value = null;
  if (!(await refreshPrereqs())) {
    toast.add({ severity: 'warn', summary: 'Fix the issues listed first', detail: `${prereqErrors.value.length} issue(s)`, life: 2500 });
    return;
  }
  if (hasMatches.value) {
    const scored = totals.value.scored;
    const ok = await askConfirm(
      `Regenerate the schedule? All ${matches.value.length} existing pool matches` +
        (scored ? `, including ${scored} with scores,` : '') +
        ' will be deleted and rebuilt from the templates. This cannot be undone.',
    );
    if (!ok) return;
    if (!(await deleteAllPoolMatches(true))) return;
  }
  generating.value = true;
  try {
    const res = await generateSchedule(t.id);
    lastResult.value = res;
    if ((res.errors ?? []).length === 0) {
      toast.add({ severity: 'success', summary: `Generated ${res.inserted} match(es)`, life: 2000 });
    } else {
      toast.add({ severity: 'warn', summary: `Generated ${res.inserted}, with ${res.errors.length} error(s)`, life: 3500 });
    }
  } catch (e: any) {
    toast.add({ severity: 'error', summary: 'Generation failed', detail: e?.message ?? 'Unknown error', life: 3000 });
  } finally {
    generating.value = false;
    await load();
  }
}

async function resetPoolMatchScores() {
  const t = tournament.value;
  if (!t) return;
  const ok = await askConfirm('Reset all pool match scores? This clears submitted and live scores and cannot be undone.');
  if (!ok) return;
  resettingScores.value = true;
  try {
    const { data, error } = await supabase
      .from('matches')
      .update({
        team1_score: null,
        team2_score: null,
        winner_id: null,
        is_live: false,
        live_score_team1: null,
        live_score_team2: null,
        live_owner_id: null,
        live_last_active_at: null,
      })
      .eq('tournament_id', t.id)
      .eq('match_type', 'pool')
      .select('id');
    if (error) {
      toast.add({ severity: 'error', summary: 'Reset failed', detail: error.message, life: 3000 });
      return;
    }
    toast.add({ severity: 'success', summary: `Reset scores for ${Array.isArray(data) ? data.length : 0} pool match(es)`, life: 2200 });
    await load();
  } finally {
    resettingScores.value = false;
  }
}

// ---------- Drag a match to another round ----------

const dragging = ref<{ id: string; poolId: string; round: number } | null>(null);
const dropTarget = ref<string | null>(null);
const dropKey = (poolId: string, round: number) => `${poolId}:${round}`;

function onDragStart(m: Match, e: DragEvent) {
  if (!m.pool_id) return;
  dragging.value = { id: m.id, poolId: m.pool_id, round: m.round_number ?? 0 };
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', m.id); // required for Firefox to start the drag
  }
}

function onDragEnd() {
  dragging.value = null;
  dropTarget.value = null;
}

function onDragOver(poolId: string, round: number, e: DragEvent) {
  // Matches can only move between rounds of their own pool
  if (!dragging.value || dragging.value.poolId !== poolId) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  dropTarget.value = dropKey(poolId, round);
}

function onDragLeave(poolId: string, round: number, e: DragEvent) {
  const to = e.relatedTarget as Node | null;
  if (to && (e.currentTarget as HTMLElement).contains(to)) return;
  if (dropTarget.value === dropKey(poolId, round)) dropTarget.value = null;
}

async function onDrop(poolId: string, round: number) {
  const d = dragging.value;
  onDragEnd();
  if (!d || d.poolId !== poolId || d.round === round) return;
  const m = matches.value.find((x) => x.id === d.id);
  if (!m) return;
  const prev = m.round_number;
  m.round_number = round; // optimistic
  busy.value = `move:${m.id}`;
  const { error } = await supabase.from('matches').update({ round_number: round }).eq('id', m.id);
  busy.value = null;
  if (error) {
    m.round_number = prev;
    toast.add({ severity: 'error', summary: 'Could not move match', detail: error.message, life: 3000 });
  }
}

onMounted(async () => {
  await session.refreshAdminUser();
  await session.restoreAdminTournament();
  await load();
  await refreshPrereqs();
});
</script>

<template>
  <div class="text-tone-100">
    <UiSectionHeading variant="dashboard" title="Pool Schedule" subtitle="Generate the pool-play schedule, then click a match to edit it or drag it to another round." :divider="true">
    </UiSectionHeading>

    <div v-if="!tournament" class="mt-4 rounded-2xl border border-tone-600/45 bg-tone-800/50 p-5 text-sm text-tone-300">
      Pick a tournament on the dashboard first.
    </div>

    <template v-else>
      <!-- Schedule generation -->
      <section class="mt-4 rounded-2xl border border-tone-600/45 bg-tone-800/50 p-4">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h2 class="text-base font-bold text-ink">Schedule</h2>
              <span
                class="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                :class="hasMatches ? 'bg-emerald-500/15 text-emerald-400' : 'bg-tone-700/60 text-tone-300'"
              >
                {{ hasMatches ? 'Generated' : 'Not generated' }}
              </span>
            </div>
            <p class="mt-1 text-sm text-tone-400">
              Builds every pool's matches from the
              <button type="button" class="font-semibold text-amber-300 hover:underline" @click="router.push({ name: 'admin-schedule-templates' })">schedule templates</button>
              (pool sizes 3–6).
            </p>
            <div class="mt-2 text-sm">
              <span v-if="checking" class="text-tone-400">Checking setup…</span>
              <span v-else-if="prereqErrors.length === 0" class="text-emerald-400">
                <i class="pi pi-check-circle mr-1 text-xs" />Pools, teams and templates are ready.
              </span>
              <ul v-else class="list-disc space-y-0.5 pl-5 text-amber-300">
                <li v-for="(e, i) in prereqErrors" :key="i">{{ e }}</li>
              </ul>
            </div>
            <div v-if="lastResult && lastResult.errors?.length" class="mt-2 text-sm text-amber-300">
              Last run inserted {{ lastResult.inserted }} match(es) with errors:
              <ul class="list-disc pl-5">
                <li v-for="(e, i) in lastResult.errors" :key="i">{{ e }}</li>
              </ul>
            </div>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              class="rounded-full px-3 py-2 text-sm font-semibold text-tone-300 transition hover:bg-tone-700/60 hover:text-ink disabled:opacity-50"
              :disabled="checking"
              @click="refreshPrereqs"
            >
              <i class="pi pi-refresh mr-1 text-xs" />Re-check
            </button>
            <template v-if="hasMatches">
              <button
                type="button"
                class="rounded-full border border-red-500/40 px-3 py-2 text-sm font-semibold text-red-400 transition hover:bg-red-500/10 disabled:opacity-50"
                :disabled="resettingScores || !totals.scored"
                @click="resetPoolMatchScores"
              >
                Reset scores
              </button>
              <button
                type="button"
                class="rounded-full border border-red-500/40 px-3 py-2 text-sm font-semibold text-red-400 transition hover:bg-red-500/10 disabled:opacity-50"
                :disabled="deletingAll"
                @click="deleteAllPoolMatches()"
              >
                Delete all
              </button>
            </template>
            <Button
              :label="hasMatches ? 'Regenerate' : 'Generate schedule'"
              icon="pi pi-cog"
              :loading="generating"
              :disabled="checking || prereqErrors.length > 0"
              :class="adminBtnGreenPillClass"
              :pt="adminBtnPillPt"
              @click="runGenerate"
            />
          </div>
        </div>
      </section>

      <section class="mt-4 flex flex-col gap-3 rounded-2xl border border-tone-600/45 bg-tone-800/50 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div class="text-sm font-semibold text-ink">{{ tournament.name }}</div>
          <div class="mt-0.5 text-sm text-tone-400">
            {{ pools.length }} pools · {{ totals.scored }} of {{ totals.matches }} matches scored
          </div>
        </div>
        <div class="flex gap-1.5 overflow-x-auto" role="tablist" aria-label="Filter by pool">
          <button
            type="button"
            class="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition"
            :class="filterPool === 'all' ? 'bg-amber-500 text-white' : 'border border-tone-600/60 text-tone-300 hover:text-ink'"
            @click="filterPool = 'all'"
          >
            All pools
          </button>
          <button
            v-for="p in pools"
            :key="p.id"
            type="button"
            class="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition"
            :class="filterPool === p.id ? 'bg-amber-500 text-white' : 'border border-tone-600/60 text-tone-300 hover:text-ink'"
            @click="filterPool = p.id"
          >
            {{ p.name }}
          </button>
        </div>
      </section>

      <div v-if="loading && !pools.length" class="mt-6 text-sm text-tone-400">Loading…</div>
      <div v-else-if="!matches.length" class="mt-6 rounded-2xl border border-dashed border-tone-600/60 p-6 text-sm text-tone-400">
        No pool matches yet. Use <span class="font-semibold text-ink">Generate schedule</span> above.
      </div>

      <div class="mt-5 grid gap-5 xl:grid-cols-2">
        <article v-for="b in poolBlocks" :key="b.pool.id" class="rounded-2xl border border-tone-600/45 bg-tone-800/40">
          <header class="flex items-center justify-between gap-3 border-b border-tone-600/40 px-4 py-3">
            <div class="min-w-0">
              <h2 class="text-base font-bold text-ink">{{ b.pool.name }}</h2>
              <p class="text-xs text-tone-400">
                {{ b.teams.length }} teams · {{ b.format }} · {{ b.scored }}/{{ b.total }} scored
                <template v-if="b.pool.court_assignment"> · Court {{ b.pool.court_assignment }}</template>
              </p>
            </div>
            <Button
              label="Add match"
              icon="pi pi-plus"
              size="small"
              severity="secondary"
              outlined
              class="!shrink-0 !rounded-full !border-tone-600/70 !text-tone-200"
              :loading="busy === `add:${b.pool.id}`"
              @click="addMatch(b.pool.id)"
            />
          </header>

          <div
            v-for="r in b.rounds"
            :key="r.round"
            class="border-b border-tone-600/25 px-4 py-2 transition-colors last:border-b-0"
            :class="dropTarget === dropKey(b.pool.id, r.round) ? 'round-drop--active' : ''"
            @dragover="onDragOver(b.pool.id, r.round, $event)"
            @dragleave="onDragLeave(b.pool.id, r.round, $event)"
            @drop.prevent="onDrop(b.pool.id, r.round)"
          >
            <div class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-tone-400">Round {{ r.round || '–' }}</div>
            <div
              v-for="m in r.matches"
              :key="m.id"
              draggable="true"
              class="group flex cursor-grab items-center gap-2 rounded-xl px-2 py-1.5 transition hover:bg-tone-700/40 active:cursor-grabbing"
              :class="dragging?.id === m.id ? 'opacity-40' : ''"
              :title="'Drag to another round'"
              @dragstart="onDragStart(m, $event)"
              @dragend="onDragEnd"
            >
              <i class="pi pi-bars shrink-0 text-xs text-tone-500 transition group-hover:text-tone-300" aria-hidden="true" />
              <button type="button" class="flex min-w-0 flex-1 items-center gap-3 text-left" :aria-label="`Edit match ${nameOf.get(m.team1_id ?? '') ?? 'TBD'} versus ${nameOf.get(m.team2_id ?? '') ?? 'TBD'}`" @click="openMatch(m)">
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm" :class="m.winner_id && m.winner_id === m.team1_id ? 'font-bold text-ink' : 'text-tone-200'">
                    {{ nameOf.get(m.team1_id ?? '') ?? 'TBD' }}
                  </span>
                  <span class="block truncate text-sm" :class="m.winner_id && m.winner_id === m.team2_id ? 'font-bold text-ink' : 'text-tone-200'">
                    {{ nameOf.get(m.team2_id ?? '') ?? 'TBD' }}
                  </span>
                  <span class="block truncate text-[11px] text-tone-400">
                    Ref: {{ nameOf.get(m.ref_team_id ?? '') ?? '—' }}
                    <template v-if="(m.best_of ?? 1) > 1"> · {{ formatLabel(formatFromMatch(m)) }}</template>
                    <template v-if="m.court"> · Court {{ m.court }}</template>
                  </span>
                </span>
                <span v-if="scoreText(m)" class="shrink-0 text-right text-sm font-semibold tabular-nums text-ink">
                  <span v-if="(m.best_of ?? 1) > 1" class="block">{{ m.team1_score }}–{{ m.team2_score }}</span>
                  <span :class="(m.best_of ?? 1) > 1 ? 'block text-[11px] font-normal text-tone-400' : ''">{{ scoreText(m) }}</span>
                </span>
                <span v-else-if="m.is_live" class="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-400">Live</span>
                <span v-else class="shrink-0 text-xs text-tone-500">Not played</span>
              </button>
              <div class="flex shrink-0 items-center opacity-70 transition group-hover:opacity-100">
                <button type="button" class="rounded-md p-1.5 text-tone-400 hover:bg-red-500/15 hover:text-red-400" aria-label="Delete match" title="Delete match" @click="deleteMatch(m)">
                  <i class="pi pi-trash text-xs" />
                </button>
              </div>
            </div>
          </div>

          <!-- Drop zone for a brand-new round, shown while dragging a match from this pool -->
          <div
            v-if="dragging?.poolId === b.pool.id"
            class="mx-4 my-2 rounded-xl border-2 border-dashed px-3 py-3 text-center text-xs font-semibold transition-colors"
            :class="dropTarget === dropKey(b.pool.id, b.nextRound) ? 'border-amber-500 bg-amber-500/10 text-amber-300' : 'border-tone-600/60 text-tone-400'"
            @dragover="onDragOver(b.pool.id, b.nextRound, $event)"
            @dragleave="onDragLeave(b.pool.id, b.nextRound, $event)"
            @drop.prevent="onDrop(b.pool.id, b.nextRound)"
          >
            Drop here for Round {{ b.nextRound }}
          </div>

          <footer v-if="b.total" class="border-t border-tone-600/40 px-4 py-3">
            <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-tone-400">Standings</div>
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-[11px] uppercase tracking-wider text-tone-500">
                  <th class="w-6 py-1 font-semibold">#</th>
                  <th class="py-1 font-semibold">Team</th>
                  <th class="w-12 py-1 text-right font-semibold">W–L</th>
                  <th class="w-14 py-1 text-right font-semibold">Sets</th>
                  <th class="w-12 py-1 text-right font-semibold">+/-</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in b.standings" :key="s.teamId" class="border-t border-tone-600/20">
                  <td class="py-1 tabular-nums text-tone-400">{{ s.place }}</td>
                  <td class="truncate py-1 text-tone-100">{{ s.name }}</td>
                  <td class="py-1 text-right tabular-nums text-tone-200">{{ s.matchWins }}–{{ s.matchLosses }}</td>
                  <td class="py-1 text-right tabular-nums text-tone-300">{{ s.gameWins }}–{{ s.gameLosses }}</td>
                  <td class="py-1 text-right tabular-nums" :class="s.pointDiff > 0 ? 'text-emerald-400' : s.pointDiff < 0 ? 'text-red-400' : 'text-tone-300'">
                    {{ s.pointDiff > 0 ? '+' : '' }}{{ s.pointDiff }}
                  </td>
                </tr>
              </tbody>
            </table>
          </footer>
        </article>
      </div>
    </template>

    <MatchEditDialog v-model:visible="editOpen" :match="editing" :teams="editTeams" :context="editContext" @saved="load" />
  </div>
</template>

<style scoped>
.round-drop--active {
  background-color: color-mix(in srgb, var(--color-amber-500) 10%, transparent);
  box-shadow: inset 3px 0 0 var(--color-amber-500);
}
</style>
