<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import Dropdown from 'primevue/dropdown';
import ToggleButton from 'primevue/togglebutton';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import { generateBracket, rebuildBracket, checkBracketPrerequisites, deleteBracketAndRevertToPoolPlay, type BracketPrereqReport } from '../lib/bracket';
import { fillRandomPoolScores } from '../lib/testData';
import {
  adminBtnPillPt,
  adminBtnBluePillClass,
  adminBtnGreenPillClass,
  adminBtnOrangePillClass,
} from '@/lib/adminButtonStyles';
import type { Tournament } from '../types/db';

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
};

const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = ref<string>(session.accessCode ?? '');
const loading = ref(false);
const running = ref(false);
const manualMode = ref(false);

const prereqRunning = ref(false);
const prereqReport = ref<BracketPrereqReport | null>(null);
const lastErrors = ref<string[]>([]);
const lastOp = ref<'generate' | 'rebuild' | 'prereq' | null>(null);

const matches = ref<Match[]>([]);
const teams = ref<Team[]>([]);
const teamOptions = computed(() =>
  [{ id: null, full_team_name: '— (TBD)' } as any].concat(teams.value)
    .map((t) => ({ label: t.full_team_name, value: t.id }))
);
const teamNameById = computed(() => {
  const map: Record<string, string> = {};
  for (const t of teams.value) map[t.id] = t.full_team_name;
  return map;
});

const maxRound = computed(() => Math.max(0, ...matches.value.map(m => m.bracket_round || 0)));

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

const championName = computed(() => {
  const mr = maxRound.value;
  if (!mr) return null;
  const finalMatch = matches.value.find((m) => (m.bracket_round ?? 0) === mr && (m.bracket_match_index ?? 0) === 0) ?? null;
  if (!finalMatch) return null;
  const winId = winnerIdFor(finalMatch);
  if (!winId) return null;
  return teamNameById.value[winId] ?? 'TBD';
});

/** True if any official score, winner, or live score exists on this bracket match. */
function matchHasLoggedScore(m: Match): boolean {
  if (m.winner_id) return true;
  if (m.team1_score != null || m.team2_score != null) return true;
  if (m.is_live && (m.live_score_team1 != null || m.live_score_team2 != null)) return true;
  return false;
}

const hasAnyBracketScoreLogged = computed(() => matches.value.some(matchHasLoggedScore));

const bracketUiStatus = computed((): { label: string; severity: 'success' | 'info' | 'warn' } => {
  if (matches.value.length === 0) {
    return { label: 'Not Started', severity: 'info' };
  }
  if (championName.value) {
    return { label: 'Completed', severity: 'success' };
  }
  if (hasAnyBracketScoreLogged.value) {
    return { label: 'In Progress', severity: 'warn' };
  }
  return { label: 'Not Started', severity: 'info' };
});

function teamLabel(teamId: string | null): string {
  if (!teamId) return 'TBD';
  return teamNameById.value[teamId] ?? 'TBD';
}

function scoreForMatchSide(m: Match, side: 1 | 2): string {
  if (m.is_live) {
    const v = side === 1 ? m.live_score_team1 : m.live_score_team2;
    if (v != null) return String(v);
  }
  const v = side === 1 ? m.team1_score : m.team2_score;
  if (v != null) return String(v);
  return '—';
}

/** Styling for team name once a winner is known (from DB or derived from scores). */
function teamResultClass(m: Match, teamId: string | null): string {
  if (!teamId) return 'text-slate-500';
  const w = winnerIdFor(m);
  if (!w) return 'text-white';
  if (w === teamId) return 'text-emerald-300 font-semibold';
  const opp = teamId === m.team1_id ? m.team2_id : m.team1_id;
  if (opp && w === opp) return 'text-slate-500';
  return 'text-white';
}

async function refreshTournamentSnapshot() {
  const id = session.tournament?.id;
  if (!id) return;
  const { data, error } = await supabase.from('tournaments').select('*').eq('id', id).single();
  if (error || !data) return;
  session.tournament = data as Tournament;
}

function roundTitle(r: number) {
  const mr = maxRound.value;
  if (mr <= 1) return 'Final';
  if (mr === 2) return r === 1 ? 'Semifinals' : 'Final';
  if (mr === 3) return r === 1 ? 'Quarterfinals' : r === 2 ? 'Semifinals' : 'Final';
  return `Round ${r}`;
}

function groupedByRound(): Array<[number, Match[]]> {
  const map = new Map<number, Match[]>();
  for (const m of matches.value) {
    const r = m.bracket_round || 1;
    const arr = map.get(r) ?? [];
    arr.push(m);
    map.set(r, arr);
  }
  // sort rounds asc, and matches within each round by bracket_match_index (fallback to id)
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([r, arr]) => {
      const sorted = arr.slice().sort((a, b) => {
        const ai = a.bracket_match_index ?? Number.MAX_SAFE_INTEGER;
        const bi = b.bracket_match_index ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.id.localeCompare(b.id);
      });
      return [r, sorted] as [number, Match[]];
    });
}

async function ensureTournamentByCode() {
  if (!accessCode.value?.trim()) {
    toast.add({ severity: 'warn', summary: 'Access code required', life: 1500 });
    return;
  }
  loading.value = true;
  try {
    await session.ensureAnon();
    session.setAccessCode(accessCode.value.trim());
    const t = await session.loadTournamentByCode(accessCode.value.trim());
    if (!t) {
      toast.add({ severity: 'error', summary: 'Tournament not found', life: 2000 });
      return;
    }
    toast.add({ severity: 'success', summary: 'Loaded tournament', detail: t.name, life: 1500 });
    await loadTeams();
    await loadMatches();
    startBracketPolling();
  } finally {
    loading.value = false;
  }
}

async function loadTeams() {
  if (!session.tournament) return;
  const { data, error } = await supabase
    .from('teams')
    .select('id, full_team_name')
    .eq('tournament_id', session.tournament.id)
    .order('full_team_name', { ascending: true });
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 2500 });
    teams.value = [];
    return;
  }
  teams.value = (data as Team[]) ?? [];
}

async function loadMatches() {
  if (!session.tournament) {
    matches.value = [];
    return;
  }
  const { data, error } = await supabase
    .from('matches')
    .select('id,tournament_id,pool_id,round_number,team1_id,team2_id,team1_score,team2_score,is_live,live_score_team1,live_score_team2,live_owner_id,live_last_active_at,winner_id,match_type,bracket_round,bracket_match_index')
    .eq('tournament_id', session.tournament.id)
    .eq('match_type', 'bracket')
    .order('bracket_round', { ascending: true })
    .order('bracket_match_index', { ascending: true });
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load bracket', detail: error.message, life: 2500 });
    matches.value = [];
    return;
  }
  matches.value = (data as Match[]) ?? [];
  await refreshTournamentSnapshot();
}

async function doGenerate() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }
  running.value = true;
  try {
    const res = await generateBracket(session.tournament.id);
    lastOp.value = 'generate';
    const errs = res.errors || [];
    lastErrors.value = errs;
    const suffix = res.bracketSize ? ` • size ${res.bracketSize}, ${res.rounds} round(s)` : '';
    if (errs.length === 0) {
      toast.add({ severity: 'success', summary: `Generated ${res.inserted} match(es)${suffix}`, life: 2500 });
    } else {
      toast.add({ severity: 'warn', summary: `Generated ${res.inserted} with ${errs.length} error(s): ${errs[0]}`, life: 4000 });
      console.warn('generateBracket errors:', errs);
    }
    await loadMatches();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Generate failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    running.value = false;
  }
}

async function doRebuild() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }
  const confirmed = confirm('Rebuild bracket? This will delete all existing bracket matches and scores. This cannot be undone. Continue?');
  if (!confirmed) return;
  running.value = true;
  try {
    const res = await rebuildBracket(session.tournament.id);
    lastOp.value = 'rebuild';
    const errs = res.errors || [];
    lastErrors.value = errs;
    const suffix = res.bracketSize ? ` • size ${res.bracketSize}, ${res.rounds} round(s)` : '';
    if (errs.length === 0) {
      toast.add({ severity: 'success', summary: `Rebuilt with ${res.inserted} match(es)${suffix}`, life: 2500 });
    } else {
      toast.add({ severity: 'warn', summary: `Rebuilt with ${res.inserted} and ${errs.length} error(s): ${errs[0]}`, life: 4000 });
      console.warn('rebuildBracket errors:', errs);
    }
    await loadMatches();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Rebuild failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    running.value = false;
  }
}

async function doDeleteBracket() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }
  const confirmed = confirm('Delete bracket? This will remove all bracket matches and revert the tournament to Pool Play. This cannot be undone. Continue?');
  if (!confirmed) return;
  running.value = true;
  try {
    const res = await deleteBracketAndRevertToPoolPlay(session.tournament.id);
    if (res.errors.length === 0) {
      toast.add({ severity: 'success', summary: `Deleted bracket (${res.deleted} match(es)) and reverted to Pool Play`, life: 3000 });
    } else {
      toast.add({ severity: 'warn', summary: `Delete completed with ${res.errors.length} issue(s)`, detail: res.errors[0], life: 4000 });
      console.warn('deleteBracketAndRevertToPoolPlay errors:', res.errors);
    }
    await loadMatches();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Delete failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    running.value = false;
  }
}

async function doCheckPrereq() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }
  prereqRunning.value = true;
  try {
    const report = await checkBracketPrerequisites(session.tournament.id);
    prereqReport.value = report;
    lastOp.value = 'prereq';
    const ecount = report.errors.length;
    if (report.ok) {
      const sizeInfo = report.stats.bracketSize > 0 ? ` • size ${report.stats.bracketSize}, ${report.stats.rounds} round(s)` : '';
      toast.add({
        severity: 'success',
        summary: `Ready: ${report.stats.poolCount} pool(s), ${report.stats.teamCount} team(s)`,
        detail: `Advancers expected ${report.stats.expectedAdvancers}, actual ${report.stats.actualAdvancers || '—'}${sizeInfo}`,
        life: 3500
      });
    } else {
      toast.add({
        severity: 'warn',
        summary: `Prerequisites found ${ecount} blocker(s)`,
        detail: report.errors[0],
        life: 4500
      });
    }
    console.log('Bracket prerequisites report:', report);
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Prereq check failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    prereqRunning.value = false;
  }
}

async function doFillPoolScores() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }
  const confirmed = confirm('Are you sure? This will randomly fill scores for all unscored pool matches in this tournament. This cannot be undone.');
  if (!confirmed) return;

  running.value = true;
  try {
    const res = await fillRandomPoolScores(session.tournament.id);
    const errs = res.errors || [];
    if (errs.length === 0) {
      toast.add({ severity: 'success', summary: `Filled ${res.updated} pool match(es)`, life: 2000 });
    } else {
      toast.add({ severity: 'warn', summary: `Filled ${res.updated}, with ${errs.length} error(s)`, life: 3500 });
      console.warn('fillRandomPoolScores errors:', errs);
    }
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Fill failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    running.value = false;
  }
}

async function updateTeam(m: Match, side: 'team1_id' | 'team2_id', value: string | null) {
  if (!session.tournament) return;
  const { error } = await supabase
    .from('matches')
    .update({ [side]: value })
    .eq('id', m.id)
    .eq('match_type', 'bracket');
  if (error) {
    toast.add({ severity: 'error', summary: 'Update failed', detail: error.message, life: 2500 });
    return;
  }
  // refresh
  await loadMatches();
}

function back() {
  router.push({ name: 'admin-dashboard' });
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

function stopBracketPolling() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startBracketPolling() {
  stopBracketPolling();
  if (!session.tournament) return;
  refreshTimer = setInterval(() => void loadMatches(), 8_000);
}

function onWindowFocus() {
  if (session.tournament) void loadMatches();
}

onMounted(async () => {
  await session.refreshAdminUser(); // guard handled by router meta
  window.addEventListener('focus', onWindowFocus);
  if (session.accessCode && !session.tournament) {
    try {
      await session.ensureAnon();
      await session.loadTournamentByCode(session.accessCode);
    } catch { /* ignore */ }
  }
  if (session.tournament) {
    await loadTeams();
    await loadMatches();
    startBracketPolling();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('focus', onWindowFocus);
  stopBracketPolling();
});
</script>

<template>
  <div class="admin-bracket-page -mx-4 min-h-dvh bg-[#0b1120] px-4 py-8 text-slate-100">
    <UiSectionHeading
      variant="dashboard"
      title="Admin Bracket"
      subtitle="Generate, rebuild, and optionally manually adjust bracket matches."
      :divider="true"
    >
      <Button
        label="Back"
        icon="pi pi-arrow-left"
        severity="secondary"
        outlined
        class="!rounded-xl !border-slate-600/70 !text-slate-200 hover:!border-amber-500/35 hover:!bg-slate-800/80 hover:!text-amber-100"
        @click="back"
      />
    </UiSectionHeading>

    <!-- Tournament loader / context -->
    <div class="mt-2 rounded-xl border border-slate-600/45 bg-slate-800/50 p-4 shadow-lg shadow-black/20">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end" v-if="!session.tournament">
        <div class="sm:col-span-2">
          <label class="mb-2 block text-sm font-medium text-slate-300">Tournament Access Code</label>
          <InputText
            v-model="accessCode"
            placeholder="e.g. GOJACKETS2025"
            class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900"
          />
        </div>
        <div class="flex">
          <Button
            :loading="loading"
            label="Load Tournament"
            icon="pi pi-search"
            :class="adminBtnBluePillClass"
            :pt="adminBtnPillPt"
            @click="ensureTournamentByCode"
          />
        </div>
      </div>
      <div v-else class="text-sm text-slate-300">
        Loaded: <span class="font-semibold text-white">{{ session.tournament.name }}</span>
        <span class="ml-2 text-slate-400">({{ session.accessCode }})</span>
      </div>
    </div>

    <div v-if="session.tournament" class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
      <!-- Actions -->
      <div class="lg:col-span-1">
        <div class="rounded-xl border border-slate-600/45 bg-slate-800/50 p-4 shadow-lg shadow-black/20">
          <div class="flex items-center justify-between">
            <div class="text-sm font-semibold text-slate-200">Bracket Controls</div>
          </div>
          <div class="mt-3 grid gap-3">
            <Button
              :loading="prereqRunning"
              label="Check Bracket Prerequisites"
              icon="pi pi-check-circle"
              :class="adminBtnBluePillClass"
              :pt="adminBtnPillPt"
              @click="doCheckPrereq"
            />
            <Button
              :loading="running"
              label="Generate Bracket"
              icon="pi pi-sitemap"
              :class="adminBtnGreenPillClass"
              :pt="adminBtnPillPt"
              @click="doGenerate"
            />
            <Button
              :loading="running"
              label="Fill Pool Scores Randomly"
              icon="pi pi-random"
              :class="adminBtnBluePillClass"
              :pt="adminBtnPillPt"
              @click="doFillPoolScores"
            />
            <Button
              :loading="running"
              label="Rebuild Bracket"
              icon="pi pi-refresh"
              :class="adminBtnOrangePillClass"
              :pt="adminBtnPillPt"
              @click="doRebuild"
            />
            <Button
              :loading="running"
              label="Delete Bracket"
              icon="pi pi-trash"
              severity="danger"
              :pt="adminBtnPillPt"
              class="!w-full !justify-center !rounded-full !border !border-red-400/45 !bg-red-600/85 !px-5 !py-3 !font-semibold !text-white shadow-md shadow-red-900/30 transition-all duration-150 hover:!border-red-300/65 hover:!bg-red-500/90 disabled:!opacity-70"
              @click="doDeleteBracket"
            />
            <div
              class="mt-2 flex w-full items-center justify-between gap-4 rounded-full border border-slate-600/55 bg-slate-800/65 py-2 pl-5 pr-2 shadow-inner shadow-black/25"
            >
              <span class="text-sm font-semibold tracking-wide text-slate-200">Manual Mode</span>
              <ToggleButton
                v-model="manualMode"
                onLabel="On"
                offLabel="Off"
                onIcon="pi pi-pencil"
                offIcon="pi pi-lock"
                aria-label="Toggle manual bracket editing"
                class="manual-mode-toggle"
                :pt="{
                  root: {
                    class:
                      '!min-h-[2.75rem] !min-w-[6.5rem] !rounded-full !border-2 !font-semibold !text-sm !transition-all !duration-200 focus-visible:!outline-none focus-visible:!ring-2 focus-visible:!ring-amber-400/55 focus-visible:!ring-offset-2 focus-visible:!ring-offset-[#0b1120]',
                  },
                  label: { class: '!px-1' },
                  icon: { class: '!text-base' },
                }"
              />
            </div>
          </div>
          <div class="mt-4 text-xs text-slate-400">
            Status:
            <Tag :value="bracketUiStatus.label" :severity="bracketUiStatus.severity" />
            <div class="mt-1 text-slate-500">
              Generated at: {{ session.tournament.bracket_generated_at || '—' }}
            </div>
          </div>

          <!-- Diagnostics Panel -->
          <div
            class="mt-4 rounded-xl border border-slate-600/40 bg-slate-900/50 p-3 text-xs text-slate-400 shadow-inner shadow-black/20"
          >
            <div class="flex items-center justify-between">
              <div class="text-sm font-semibold text-slate-200">Diagnostics</div>
              <Tag
                v-if="prereqReport"
                :value="prereqReport.ok ? 'Ready' : 'Blocked'"
                :severity="prereqReport.ok ? 'success' : 'warn'"
              />
            </div>

            <div v-if="prereqReport" class="mt-2 space-y-2">
              <div class="text-slate-300">
                Pools: {{ prereqReport.stats.poolCount }},
                Teams: {{ prereqReport.stats.teamCount }}
                • Expected advancers: {{ prereqReport.stats.expectedAdvancers }},
                Actual: {{ prereqReport.stats.actualAdvancers || '—' }}
                <span v-if="prereqReport.stats.bracketSize > 0">
                  • Size {{ prereqReport.stats.bracketSize }}, Rounds {{ prereqReport.stats.rounds }}
                </span>
              </div>

              <div v-if="prereqReport.errors.length">
                <div class="mb-1 font-medium text-white">Errors</div>
                <ul class="list-disc list-inside text-slate-300">
                  <li v-for="(e, i) in prereqReport.errors" :key="'pe'+i">{{ e }}</li>
                </ul>
              </div>

              <div v-if="prereqReport.unscored.length">
                <div class="mb-1 font-medium text-white">Unscored pool matches</div>
                <ul class="list-disc list-inside max-h-40 overflow-auto pr-2 text-slate-300">
                  <li v-for="u in prereqReport.unscored" :key="'u'+u.matchId">
                    {{ (u.poolName || 'Unknown Pool') }} • {{ u.matchId.slice(0, 8) }}
                  </li>
                </ul>
              </div>

              <div v-if="prereqReport.infos.length">
                <div class="mb-1 font-medium text-white">Info</div>
                <ul class="list-disc list-inside text-slate-300">
                  <li v-for="(e, i) in prereqReport.infos" :key="'pi'+i">{{ e }}</li>
                </ul>
              </div>
            </div>

            <div v-else class="mt-2 text-slate-500">
              Run "Check Bracket Prerequisites" to analyze readiness.
            </div>

            <div v-if="lastErrors.length && (lastOp === 'generate' || lastOp === 'rebuild')" class="mt-3">
              <div class="mb-1 font-medium text-white">Last {{ lastOp }} errors</div>
              <ul class="list-disc list-inside text-slate-300">
                <li v-for="(e, i) in lastErrors" :key="'le'+i">{{ e }}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      <!-- Bracket Matches -->
      <div class="lg:col-span-2">
        <div
          v-if="matches.length === 0"
          class="rounded-xl border border-slate-600/45 bg-slate-800/50 p-6 text-sm text-slate-400 shadow-lg shadow-black/20"
        >
          No bracket matches yet.
        </div>

        <div v-else class="grid gap-6">
          <div
            v-if="championName"
            class="admin-bracket-champion relative overflow-hidden rounded-2xl border border-amber-500/25 bg-gradient-to-br from-slate-800/95 via-slate-800/80 to-[#1a2740]/95 p-5 text-center text-white shadow-xl shadow-black/30"
          >
            <div
              class="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-amber-500/15 blur-3xl"
              aria-hidden="true"
            />
            <div class="relative text-2xl font-extrabold leading-tight text-white">
              {{ championName }} WON!! 🎉🎉
            </div>
            <div class="relative mt-1 font-medium text-slate-300">
              Thank you for playing!
            </div>
          </div>
          <div
            v-for="[r, arr] in groupedByRound()"
            :key="r"
            class="overflow-hidden rounded-xl border border-slate-600/45 bg-slate-800/50 shadow-lg shadow-black/20"
          >
            <div class="border-b border-slate-600/45 bg-slate-800/60 px-4 py-3">
              <div class="text-sm font-semibold text-white">{{ roundTitle(r) }}</div>
            </div>
            <div class="grid gap-3 p-4">
              <div
                v-for="m in arr"
                :key="m.id"
                class="rounded-xl border border-slate-600/40 bg-slate-800/40 p-4"
              >
                <div class="flex items-center justify-between">
                  <div class="text-xs text-slate-400">
                    Match {{ m.id.slice(0, 8) }} • {{ m.match_type === 'bracket' ? 'Bracket' : 'Pool'
                    }}{{ m.round_number != null ? ' R' + m.round_number : '' }}
                  </div>
                  <Tag v-if="m.is_live" value="LIVE" severity="danger" />
                </div>

                <div v-if="manualMode" class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <label class="mb-1 block text-xs font-medium text-slate-400">Team 1</label>
                    <Dropdown
                      :modelValue="m.team1_id"
                      :options="teamOptions"
                      optionLabel="label"
                      optionValue="value"
                      class="w-full"
                      :pt="{ root: { class: 'w-full' } }"
                      @update:modelValue="(val: string | null) => updateTeam(m, 'team1_id', val as string | null)"
                    />
                  </div>
                  <div>
                    <label class="mb-1 block text-xs font-medium text-slate-400">Team 2</label>
                    <Dropdown
                      :modelValue="m.team2_id"
                      :options="teamOptions"
                      optionLabel="label"
                      optionValue="value"
                      class="w-full"
                      :pt="{ root: { class: 'w-full' } }"
                      @update:modelValue="(val: string | null) => updateTeam(m, 'team2_id', val as string | null)"
                    />
                  </div>
                </div>

                <div
                  class="mt-3 rounded-lg border border-slate-600/35 bg-slate-900/30 px-3 py-2.5"
                  :class="m.is_live ? 'ring-1 ring-red-500/25' : ''"
                >
                  <div v-if="m.is_live" class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-red-300/90">
                    Live scores (updates on refresh)
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex min-w-0 flex-1 items-center gap-2">
                      <span :class="['min-w-0 truncate text-sm', teamResultClass(m, m.team1_id)]">
                        {{ teamLabel(m.team1_id) }}
                      </span>
                      <span
                        v-if="winnerIdFor(m) && winnerIdFor(m) === m.team1_id"
                        class="shrink-0 rounded-md bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-300"
                      >
                        Won
                      </span>
                    </div>
                    <span class="shrink-0 tabular-nums text-lg font-bold text-slate-100">{{
                      scoreForMatchSide(m, 1)
                    }}</span>
                  </div>
                  <div class="my-2 border-t border-slate-600/35" />
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex min-w-0 flex-1 items-center gap-2">
                      <span :class="['min-w-0 truncate text-sm', teamResultClass(m, m.team2_id)]">
                        {{ teamLabel(m.team2_id) }}
                      </span>
                      <span
                        v-if="winnerIdFor(m) && winnerIdFor(m) === m.team2_id"
                        class="shrink-0 rounded-md bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-300"
                      >
                        Won
                      </span>
                    </div>
                    <span class="shrink-0 tabular-nums text-lg font-bold text-slate-100">{{
                      scoreForMatchSide(m, 2)
                    }}</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="px-4 pb-4">
              <Button
                label="Refresh"
                icon="pi pi-refresh"
                size="small"
                severity="secondary"
                outlined
                class="!rounded-xl !border-slate-600/70 !text-slate-200 hover:!border-amber-500/35 hover:!bg-slate-800/80"
                @click="loadMatches"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="mt-10 border-t border-slate-800 pt-6 text-sm text-slate-500">
      Notes:
      <ul class="mt-2 list-disc list-inside text-slate-400">
        <li>Policy A: Top 2 advance per pool; bracket size up to 8 with byes to top seeds.</li>
        <li>Rebuild is blocked once the bracket has started (any bracket match goes live or is scored).</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.admin-bracket-champion {
  box-shadow:
    0 0 0 1px rgba(251, 191, 36, 0.08),
    0 20px 40px -12px rgba(0, 0, 0, 0.45);
}

/* Manual mode toggle: obvious off (muted) vs on (amber pill), same family as Generate/Rebuild CTAs */
.admin-bracket-page :deep(.manual-mode-toggle.p-togglebutton:not(.p-togglebutton-checked)) {
  background: rgb(30 41 59 / 0.95) !important;
  border-color: rgb(100 116 139 / 0.7) !important;
  color: rgb(226 232 240) !important;
}

.admin-bracket-page :deep(.manual-mode-toggle.p-togglebutton.p-togglebutton-checked) {
  background: linear-gradient(135deg, #f5931a 0%, #faa237 100%) !important;
  border-color: rgb(251 191 36 / 0.55) !important;
  color: white !important;
  box-shadow:
    0 0 0 3px rgba(251, 191, 36, 0.22),
    0 8px 20px -8px rgba(0, 0, 0, 0.45);
}

.admin-bracket-page :deep(.manual-mode-toggle.p-togglebutton:not(.p-togglebutton-checked):hover:not(:disabled)) {
  border-color: rgb(148 163 184 / 0.85) !important;
  background: rgb(51 65 85 / 0.85) !important;
}

.admin-bracket-page :deep(.manual-mode-toggle.p-togglebutton.p-togglebutton-checked:hover:not(:disabled)) {
  filter: brightness(1.06);
}
</style>
