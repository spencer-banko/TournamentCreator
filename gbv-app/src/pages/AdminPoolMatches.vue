<script setup lang="ts">
/**
 * Admin view of every pool match, grouped by pool and round. Click a match to change
 * teams, ref, round, court, format or score. Matches can also be added, deleted, or
 * moved to an earlier/later round.
 */
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import Button from 'primevue/button';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import MatchEditDialog from '@/components/admin/MatchEditDialog.vue';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import { poolFormatForSize } from '../lib/schedule';
import { rankPool, DEFAULT_TIEBREAKERS } from '../lib/standings';
import { formatFromMatch, formatLabel, setsOf } from '../lib/scoring';
import type { Match, Pool, Tournament } from '../types/db';

type Team = { id: string; full_team_name: string; pool_id: string | null; seed_in_pool: number | null; seed_global: number | null };

const router = useRouter();
const toast = useToast();
const confirm = useConfirm();
const session = useSessionStore();

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

async function moveRound(m: Match, delta: number) {
  const next = Math.max(1, (m.round_number ?? 1) + delta);
  if (next === m.round_number) return;
  busy.value = `move:${m.id}`;
  const { error } = await supabase.from('matches').update({ round_number: next }).eq('id', m.id);
  busy.value = null;
  if (error) toast.add({ severity: 'error', summary: 'Could not move match', detail: error.message, life: 3000 });
  await load();
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

onMounted(async () => {
  await session.refreshAdminUser();
  await session.restoreAdminTournament();
  await load();
});
</script>

<template>
  <div class="-mx-4 min-h-dvh gbv-page-bg px-4 py-8 text-tone-100">
    <UiSectionHeading variant="dashboard" title="Pool Matches" subtitle="Every pool match by round. Click a match to change who plays, the ref, or the score." :divider="true">
      <Button label="Back" icon="pi pi-arrow-left" severity="secondary" outlined class="!rounded-xl !border-tone-600/70 !text-tone-200" @click="router.push({ name: 'admin-dashboard' })" />
    </UiSectionHeading>

    <div v-if="!tournament" class="mt-4 rounded-2xl border border-tone-600/45 bg-tone-800/50 p-5 text-sm text-tone-300">
      Pick a tournament on the dashboard first.
    </div>

    <template v-else>
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
        No pool matches yet. Generate the schedule first.
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

          <div v-for="r in b.rounds" :key="r.round" class="border-b border-tone-600/25 px-4 py-2 last:border-b-0">
            <div class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-tone-400">Round {{ r.round || '–' }}</div>
            <div
              v-for="m in r.matches"
              :key="m.id"
              class="group flex items-center gap-2 rounded-xl px-2 py-1.5 transition hover:bg-tone-700/40"
            >
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
                <button type="button" class="rounded-md p-1.5 text-tone-400 hover:bg-tone-700/60 hover:text-ink disabled:opacity-30" :disabled="(m.round_number ?? 1) <= 1 || !!busy" aria-label="Move to earlier round" title="Earlier round" @click="moveRound(m, -1)">
                  <i class="pi pi-arrow-up text-xs" />
                </button>
                <button type="button" class="rounded-md p-1.5 text-tone-400 hover:bg-tone-700/60 hover:text-ink disabled:opacity-30" :disabled="!!busy" aria-label="Move to later round" title="Later round" @click="moveRound(m, 1)">
                  <i class="pi pi-arrow-down text-xs" />
                </button>
                <button type="button" class="rounded-md p-1.5 text-tone-400 hover:bg-red-500/15 hover:text-red-400" aria-label="Delete match" title="Delete match" @click="deleteMatch(m)">
                  <i class="pi pi-trash text-xs" />
                </button>
              </div>
            </div>
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
