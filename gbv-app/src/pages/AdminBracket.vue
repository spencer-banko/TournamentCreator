<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import MatchEditDialog from '@/components/admin/MatchEditDialog.vue';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import {
  generateBracket,
  generateAllBrackets,
  deleteBracketMatches,
  checkBracketPrerequisites,
  ensureBrackets,
  roundFormatFor,
  type BracketPrereqReport,
} from '../lib/bracket';
import { fillRandomPoolScores, fillRandomBracketScores } from '../lib/testData';
import { roundName } from '../lib/standings';
import { formatLabel, setsOf } from '../lib/scoring';
import { medalFor, placesLabel } from '../lib/bracketStyle';
import { adminBtnPillPt, adminBtnBluePillClass, adminBtnGreenPillClass } from '@/lib/adminButtonStyles';
import type { Bracket, Match, Tournament } from '../types/db';

type Team = { id: string; full_team_name: string; pool_id: string | null };

const router = useRouter();
const toast = useToast();
const confirm = useConfirm();
const session = useSessionStore();

const accessCode = ref<string>(session.accessCode ?? '');
const loading = ref(false);
const busy = ref<string | null>(null); // which action is running

const brackets = ref<Bracket[]>([]);
const selectedId = ref<string | null>(null);
const matches = ref<Match[]>([]);
const teams = ref<Team[]>([]);
const report = ref<BracketPrereqReport | null>(null);

const editing = ref<Match | null>(null);
const editOpen = ref(false);

const teamName = computed(() => new Map(teams.value.map((t) => [t.id, t.full_team_name])));
const selected = computed(() => brackets.value.find((b) => b.id === selectedId.value) ?? null);
const selectedMatches = computed(() => matches.value.filter((m) => m.bracket_id === selectedId.value));
const totalRounds = computed(() => Math.max(0, ...selectedMatches.value.map((m) => m.bracket_round ?? 0)));
const planFor = (id: string) => report.value?.brackets.find((p) => p.bracketId === id) ?? null;

const rounds = computed(() => {
  const map = new Map<number, Match[]>();
  for (const m of selectedMatches.value) {
    const r = m.bracket_round ?? 1;
    map.set(r, [...(map.get(r) ?? []), m]);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([r, arr]) => ({ round: r, matches: arr.sort((a, b) => (a.bracket_match_index ?? 0) - (b.bracket_match_index ?? 0)) }));
});

function bracketMatches(id: string) {
  return matches.value.filter((m) => m.bracket_id === id);
}
function championOf(id: string): string | null {
  const ms = bracketMatches(id);
  const last = Math.max(0, ...ms.map((m) => m.bracket_round ?? 0));
  const final = ms.find((m) => m.bracket_round === last && (m.bracket_match_index ?? 0) === 0);
  if (!final?.winner_id || final.team1_score == null) return null;
  return teamName.value.get(final.winner_id) ?? null;
}
function statusOf(id: string): { label: string; tone: 'idle' | 'live' | 'done' } {
  const ms = bracketMatches(id);
  if (!ms.length) return { label: 'Not generated', tone: 'idle' };
  if (championOf(id)) return { label: 'Complete', tone: 'done' };
  if (ms.some((m) => m.team1_score != null)) return { label: 'In progress', tone: 'live' };
  return { label: 'Ready to play', tone: 'idle' };
}

const isBye = (m: Match) => (m.bracket_round === 1 && !!m.winner_id && m.team1_score == null && (!m.team1_id || !m.team2_id));

function scoreCells(m: Match, side: 1 | 2): string[] {
  if (m.team1_score == null) return [];
  const sets = setsOf(m as any);
  if ((m.best_of ?? 1) > 1) return sets.map((s) => String(side === 1 ? s.t1 : s.t2));
  return [String(side === 1 ? m.team1_score : m.team2_score)];
}

async function refreshTournament() {
  const id = session.tournament?.id;
  if (!id) return;
  const { data } = await supabase.from('tournaments').select('*').eq('id', id).single();
  if (data) session.tournament = data as Tournament;
}

async function loadAll(opts: { quiet?: boolean } = {}) {
  const t = session.tournament;
  if (!t) return;
  try {
    const [b, tm, ms] = await Promise.all([
      ensureBrackets(t.id),
      supabase.from('teams').select('id,full_team_name,pool_id').eq('tournament_id', t.id),
      supabase
        .from('matches')
        .select('*')
        .eq('tournament_id', t.id)
        .eq('match_type', 'bracket')
        .order('bracket_round')
        .order('bracket_match_index'),
    ]);
    brackets.value = b;
    teams.value = (tm.data as Team[]) ?? [];
    matches.value = (ms.data as Match[]) ?? [];
    if (!selectedId.value || !b.some((x) => x.id === selectedId.value)) selectedId.value = b[0]?.id ?? null;
    if (!opts.quiet) report.value = await checkBracketPrerequisites(t.id);
    await refreshTournament();
  } catch (e: any) {
    if (!opts.quiet) toast.add({ severity: 'error', summary: 'Failed to load brackets', detail: e?.message ?? String(e), life: 3500 });
  }
}

async function loadByCode() {
  if (!accessCode.value.trim()) return;
  loading.value = true;
  try {
    await session.ensureAnon();
    session.setAccessCode(accessCode.value.trim());
    const t = await session.loadTournamentByCode(accessCode.value.trim());
    if (!t) {
      toast.add({ severity: 'error', summary: 'Tournament not found', life: 2000 });
      return;
    }
    await loadAll();
    startPolling();
  } finally {
    loading.value = false;
  }
}

async function run(key: string, fn: () => Promise<void>) {
  busy.value = key;
  try {
    await fn();
  } catch (e: any) {
    toast.add({ severity: 'error', summary: 'Something went wrong', detail: e?.message ?? String(e), life: 4000 });
  } finally {
    busy.value = null;
    await loadAll();
  }
}

function doGenerateAll() {
  const t = session.tournament;
  if (!t) return;
  const any = matches.value.length > 0;
  const go = () =>
    run('all', async () => {
      const res = await generateAllBrackets(t.id);
      const ok = res.results.filter((r) => !r.errors.length);
      if (res.errors.length) toast.add({ severity: 'warn', summary: 'Some brackets were not generated', detail: res.errors[0], life: 5000 });
      if (ok.length) toast.add({ severity: 'success', summary: `Generated ${ok.map((r) => `${r.name} (${r.teams})`).join(', ')}`, life: 3500 });
    });
  if (!any) return go();
  confirm.require({
    header: 'Regenerate all brackets?',
    message: 'Every bracket is rebuilt from the current pool standings. Bracket scores entered so far will be erased.',
    icon: 'pi pi-refresh',
    acceptLabel: 'Regenerate all',
    rejectLabel: 'Cancel',
    defaultFocus: 'reject',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', outlined: true },
    accept: go,
  });
}

function doGenerateOne(b: Bracket) {
  const t = session.tournament;
  if (!t) return;
  const go = () =>
    run(`gen:${b.id}`, async () => {
      const r = await generateBracket(t.id, b.id);
      if (r.errors.length) toast.add({ severity: 'warn', summary: `${b.name} not generated`, detail: r.errors[0], life: 5000 });
      else toast.add({ severity: 'success', summary: `${b.name}: ${r.teams} teams, ${r.bracketSize}-team draw`, life: 3000 });
    });
  if (!bracketMatches(b.id).length) return go();
  confirm.require({
    header: `Regenerate ${b.name}?`,
    message: `${b.name} is rebuilt from the current pool standings. Its bracket scores will be erased. Other brackets are not touched.`,
    icon: 'pi pi-refresh',
    acceptLabel: `Regenerate ${b.name}`,
    rejectLabel: 'Cancel',
    defaultFocus: 'reject',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', outlined: true },
    accept: go,
  });
}

function doDelete(b: Bracket) {
  const t = session.tournament;
  if (!t) return;
  confirm.require({
    header: `Delete ${b.name} matches?`,
    message: `All ${b.name} bracket matches and their scores are removed. The bracket setup (which pool places feed it) is kept.`,
    icon: 'pi pi-trash',
    acceptLabel: 'Delete matches',
    rejectLabel: 'Keep',
    defaultFocus: 'reject',
    acceptProps: { severity: 'danger' },
    rejectProps: { severity: 'secondary', outlined: true },
    accept: () =>
      run(`del:${b.id}`, async () => {
        const r = await deleteBracketMatches(t.id, b.id);
        toast.add({ severity: r.errors.length ? 'warn' : 'success', summary: r.errors[0] ?? `Deleted ${r.deleted} ${b.name} matches`, life: 3000 });
      }),
  });
}

function doFillPool() {
  const t = session.tournament;
  if (!t) return;
  confirm.require({
    header: 'Fill pool scores randomly?',
    message: 'For testing: every unscored pool match gets a random valid score.',
    icon: 'pi pi-bolt',
    acceptLabel: 'Fill scores',
    rejectLabel: 'Cancel',
    rejectProps: { severity: 'secondary', outlined: true },
    accept: () =>
      run('fillpool', async () => {
        const r = await fillRandomPoolScores(t.id);
        toast.add({ severity: r.errors.length ? 'warn' : 'success', summary: `Filled ${r.updated} pool match(es)`, life: 2500 });
      }),
  });
}

function doFillBracket(b: Bracket) {
  const t = session.tournament;
  if (!t) return;
  confirm.require({
    header: `Play out ${b.name} randomly?`,
    message: 'For testing: every playable match gets a random valid score and winners move forward.',
    icon: 'pi pi-bolt',
    acceptLabel: 'Play it out',
    rejectLabel: 'Cancel',
    rejectProps: { severity: 'secondary', outlined: true },
    accept: () =>
      run(`fill:${b.id}`, async () => {
        const r = await fillRandomBracketScores(t.id, b.id);
        toast.add({ severity: r.errors.length ? 'warn' : 'success', summary: `Scored ${r.updated} ${b.name} match(es)`, life: 2500 });
      }),
  });
}

function openMatch(m: Match) {
  if (isBye(m)) return;
  editing.value = m;
  editOpen.value = true;
}

let timer: ReturnType<typeof setInterval> | null = null;
function startPolling() {
  stopPolling();
  timer = setInterval(() => {
    if (!editOpen.value && !busy.value) void loadAll({ quiet: true });
  }, 10_000);
}
function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

watch(selectedId, () => (editOpen.value = false));

onMounted(async () => {
  await session.refreshAdminUser();
  await session.restoreAdminTournament();
  if (session.tournament) {
    await loadAll();
    startPolling();
  }
});
onBeforeUnmount(stopPolling);
</script>

<template>
  <div class="admin-bracket-page -mx-4 min-h-dvh gbv-page-bg px-4 py-8 text-tone-100">
    <UiSectionHeading variant="dashboard" title="Brackets" subtitle="Generate each bracket from pool standings, then click any match to fix teams or scores." :divider="true">
      <Button label="Back" icon="pi pi-arrow-left" severity="secondary" outlined class="!rounded-xl !border-tone-600/70 !text-tone-200" @click="router.push({ name: 'admin-dashboard' })" />
    </UiSectionHeading>

    <!-- Loader -->
    <div v-if="!session.tournament" class="mt-4 max-w-xl rounded-2xl border border-tone-600/45 bg-tone-800/50 p-5">
      <label class="mb-2 block text-sm font-medium text-tone-300">Tournament access code</label>
      <div class="flex gap-3">
        <InputText v-model="accessCode" placeholder="e.g. ECVA-MENS" class="w-full !rounded-xl !bg-white !text-slate-900" @keyup.enter="loadByCode" />
        <Button :loading="loading" label="Load" icon="pi pi-search" :class="adminBtnBluePillClass" :pt="adminBtnPillPt" @click="loadByCode" />
      </div>
    </div>

    <template v-else>
      <!-- Readiness bar -->
      <section class="mt-4 flex flex-col gap-4 rounded-2xl border border-tone-600/45 bg-tone-800/50 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <div class="text-sm font-semibold text-ink">{{ session.tournament.name }}</div>
          <div class="mt-0.5 text-sm text-tone-400">
            <template v-if="report">
              {{ report.stats.teamCount }} teams · {{ report.stats.poolCount }} pools ·
              <span :class="report.stats.unscoredCount ? 'font-semibold text-amber-300' : 'text-emerald-300'">
                {{ report.stats.unscoredCount ? `${report.stats.unscoredCount} pool matches still unscored` : 'All pool matches scored' }}
              </span>
            </template>
            <template v-else>Checking…</template>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button
            v-if="report && report.stats.unscoredCount"
            label="Fill pool scores (test)"
            icon="pi pi-bolt"
            severity="secondary"
            outlined
            size="small"
            class="!rounded-full !border-tone-600/70 !text-tone-200"
            :loading="busy === 'fillpool'"
            @click="doFillPool"
          />
          <Button
            :label="matches.length ? 'Regenerate all brackets' : 'Generate all brackets'"
            icon="pi pi-sitemap"
            :class="adminBtnGreenPillClass"
            :pt="adminBtnPillPt"
            :loading="busy === 'all'"
            :disabled="!!busy"
            @click="doGenerateAll"
          />
        </div>
      </section>

      <ul v-if="report && (report.errors.length || report.infos.length)" class="mt-3 grid gap-1.5 text-sm">
        <li v-for="e in report.errors" :key="e" class="flex gap-2 text-amber-300"><i class="pi pi-exclamation-triangle mt-0.5 text-xs" />{{ e }}</li>
        <li v-for="e in report.infos" :key="e" class="flex gap-2 text-tone-400"><i class="pi pi-info-circle mt-0.5 text-xs" />{{ e }}</li>
      </ul>

      <!-- Bracket tabs -->
      <nav class="mt-6 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Brackets">
        <button
          v-for="(b, i) in brackets"
          :key="b.id"
          role="tab"
          :aria-selected="b.id === selectedId"
          class="group flex shrink-0 items-center gap-3 rounded-2xl border px-4 py-3 text-left transition"
          :class="b.id === selectedId ? 'border-transparent bg-tone-800 shadow-lg shadow-black/10' : 'border-tone-600/45 bg-tone-800/30 hover:bg-tone-800/60'"
          :style="b.id === selectedId ? { boxShadow: `inset 0 0 0 2px ${medalFor(b.name, i).ring}` } : {}"
          @click="selectedId = b.id"
        >
          <span class="h-3 w-3 shrink-0 rounded-full" :style="{ background: medalFor(b.name, i).dot }" />
          <span>
            <span class="block text-sm font-bold text-ink">{{ b.name }}</span>
            <span class="block text-xs text-tone-400">
              {{ planFor(b.id)?.teamCount ?? '–' }} teams · {{ statusOf(b.id).label }}
            </span>
          </span>
        </button>
      </nav>

      <!-- Selected bracket -->
      <section v-if="selected" class="mt-4 rounded-2xl border border-tone-600/45 bg-tone-800/40">
        <header class="flex flex-col gap-3 border-b border-tone-600/40 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 class="flex items-center gap-2 text-lg font-bold text-ink">
              <span class="h-3 w-3 rounded-full" :style="{ background: medalFor(selected.name, brackets.indexOf(selected)).dot }" />
              {{ selected.name }} bracket
            </h2>
            <p class="mt-0.5 text-sm text-tone-400">
              {{ placesLabel(selected.places) }}
              <template v-if="planFor(selected.id)?.teamCount">
                · {{ planFor(selected.id)!.teamCount }} teams in a {{ planFor(selected.id)!.bracketSize }}-team draw
                <template v-if="planFor(selected.id)!.bracketSize > planFor(selected.id)!.teamCount">
                  ({{ planFor(selected.id)!.bracketSize - planFor(selected.id)!.teamCount }} byes to top seeds)
                </template>
              </template>
              · seeded by wins, then point differential
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <Button
              v-if="selectedMatches.length && !championOf(selected.id)"
              label="Play out (test)"
              icon="pi pi-bolt"
              severity="secondary"
              outlined
              size="small"
              class="!rounded-full !border-tone-600/70 !text-tone-200"
              :loading="busy === `fill:${selected.id}`"
              @click="doFillBracket(selected)"
            />
            <Button
              :label="selectedMatches.length ? 'Regenerate' : 'Generate'"
              icon="pi pi-sitemap"
              size="small"
              class="!rounded-full !border-none !bg-amber-500 !px-4 !text-white"
              :loading="busy === `gen:${selected.id}`"
              :disabled="!!busy"
              @click="doGenerateOne(selected)"
            />
            <Button
              v-if="selectedMatches.length"
              label="Delete"
              icon="pi pi-trash"
              size="small"
              severity="danger"
              outlined
              class="!rounded-full"
              :loading="busy === `del:${selected.id}`"
              @click="doDelete(selected)"
            />
          </div>
        </header>

        <div v-if="championOf(selected.id)" class="mx-4 mt-4 flex items-center gap-3 rounded-xl px-4 py-3" :style="{ background: medalFor(selected.name, brackets.indexOf(selected)).chip }">
          <i class="pi pi-trophy text-xl" :style="{ color: medalFor(selected.name, brackets.indexOf(selected)).dot }" />
          <div>
            <div class="text-xs font-semibold uppercase tracking-wide text-tone-300">{{ selected.name }} champion</div>
            <div class="text-lg font-extrabold text-ink">{{ championOf(selected.id) }}</div>
          </div>
        </div>

        <div v-if="!selectedMatches.length" class="p-8 text-center text-sm text-tone-400">
          <p>No {{ selected.name }} matches yet.</p>
          <p class="mt-1">Score all pool matches, then press <strong class="text-tone-200">Generate</strong>.</p>
        </div>

        <!-- Rounds: horizontal on wide screens, stacked on phones -->
        <div v-else class="flex flex-col gap-6 overflow-x-auto p-4 lg:flex-row lg:gap-5">
          <div v-for="r in rounds" :key="r.round" class="flex min-w-[15rem] flex-col lg:w-60 lg:shrink-0">
            <div class="mb-2 flex items-baseline justify-between gap-2 px-1">
              <h3 class="text-sm font-bold text-ink">{{ roundName(r.round, totalRounds) }}</h3>
              <span class="text-[11px] font-medium text-tone-400">{{ formatLabel(roundFormatFor(selected, r.round, totalRounds)) }}</span>
            </div>
            <div class="flex flex-1 flex-col justify-around gap-3">
              <button
                v-for="m in r.matches"
                :key="m.id"
                type="button"
                class="group w-full overflow-hidden rounded-xl border text-left transition"
                :class="isBye(m) ? 'cursor-default border-dashed border-tone-600/50 opacity-70' : 'border-tone-600/50 bg-tone-900/60 hover:border-amber-500/60 hover:shadow-md focus-visible:outline-2 focus-visible:outline-amber-400'"
                :aria-label="isBye(m) ? 'Bye' : `Edit match: ${teamName.get(m.team1_id ?? '') ?? 'TBD'} vs ${teamName.get(m.team2_id ?? '') ?? 'TBD'}`"
                @click="openMatch(m)"
              >
                <div
                  v-for="side in [1, 2] as const"
                  :key="side"
                  class="flex items-center gap-2 px-3 py-2"
                  :class="side === 2 ? 'border-t border-tone-600/40' : ''"
                >
                  <span
                    class="min-w-0 flex-1 truncate text-sm"
                    :class="[
                      !(side === 1 ? m.team1_id : m.team2_id) ? 'italic text-tone-500' : 'text-ink',
                      m.winner_id && m.winner_id === (side === 1 ? m.team1_id : m.team2_id) ? 'font-bold' : '',
                      m.winner_id && m.team1_score != null && m.winner_id !== (side === 1 ? m.team1_id : m.team2_id) ? 'text-tone-500' : '',
                    ]"
                  >
                    {{ (side === 1 ? m.team1_id : m.team2_id) ? teamName.get((side === 1 ? m.team1_id : m.team2_id)!) : isBye(m) ? 'Bye' : 'TBD' }}
                  </span>
                  <span
                    v-for="(c, ci) in scoreCells(m, side)"
                    :key="ci"
                    class="w-6 text-right text-sm tabular-nums"
                    :class="m.winner_id === (side === 1 ? m.team1_id : m.team2_id) ? 'font-bold text-ink' : 'text-tone-400'"
                  >{{ c }}</span>
                </div>
                <div v-if="!isBye(m)" class="flex items-center justify-between border-t border-tone-600/30 bg-tone-800/40 px-3 py-1 text-[11px] text-tone-400">
                  <span>{{ m.court ? `Court ${m.court}` : ' ' }}</span>
                  <span class="font-semibold text-amber-300 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100">Edit</span>
                </div>
              </button>
            </div>
          </div>
        </div>
      </section>
    </template>

    <MatchEditDialog
      v-model:visible="editOpen"
      :match="editing"
      :teams="teams"
      :context="editing && selected ? `${selected.name} · ${roundName(editing.bracket_round ?? 1, totalRounds)}` : ''"
      :is-final="!!editing && editing.bracket_round === totalRounds"
      :bracket-name="selected?.name"
      @saved="loadAll({ quiet: true })"
    />
  </div>
</template>
