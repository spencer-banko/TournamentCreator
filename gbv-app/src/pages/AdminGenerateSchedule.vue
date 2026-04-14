<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import { checkPrerequisites, generateSchedule, type GenerateResult } from '../lib/schedule';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import {
  adminBtnPillPt,
  adminBtnBluePillClass,
  adminBtnGreenPillClass,
  adminBtnDangerPillClass,
} from '@/lib/adminButtonStyles';

const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = ref<string>(session.accessCode ?? '');

const loading = ref(false);
const checking = ref(false);
const generating = ref(false);
const resettingScores = ref(false);

const prereqErrors = ref<string[]>([]);
const hasMatches = ref<boolean>(false);
const lastResult = ref<GenerateResult | null>(null);

const canGenerate = computed(() => prereqErrors.value.length === 0);

async function refreshPrereqs(): Promise<boolean> {
  if (!session.tournament) return false;
  const res = await checkPrerequisites(session.tournament.id);
  prereqErrors.value = res.errors ?? [];
  return res.ok;
}

async function loadTournamentByAccessCode() {
  if (!accessCode.value?.trim()) {
    toast.add({ severity: 'warn', summary: 'Access code required', life: 2000 });
    return;
  }
  loading.value = true;
  try {
    await session.ensureAnon();
    session.setAccessCode(accessCode.value.trim());
    const t = await session.loadTournamentByCode(accessCode.value.trim());
    if (!t) {
      toast.add({ severity: 'error', summary: 'Tournament not found', life: 2500 });
      prereqErrors.value = [];
      hasMatches.value = false;
      return;
    }
    toast.add({ severity: 'success', summary: 'Tournament loaded', detail: t.name, life: 1500 });
    await checkExistingMatches();
    await refreshPrereqs();
  } finally {
    loading.value = false;
  }
}

async function checkExistingMatches() {
  if (!session.tournament) return;
  const { data, error } = await supabase
    .from('matches')
    .select('id', { count: 'exact', head: false })
    .eq('tournament_id', session.tournament.id)
    .eq('match_type', 'pool')
    .limit(1);
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to check existing matches', detail: error.message, life: 2500 });
    hasMatches.value = false;
    return;
  }
  hasMatches.value = Array.isArray(data) && data.length > 0;
}

async function runPrereqCheck() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }
  checking.value = true;
  try {
    const ok = await refreshPrereqs();
    if (ok) {
      toast.add({ severity: 'success', summary: 'All prerequisites satisfied', life: 1500 });
    } else {
      toast.add({ severity: 'warn', summary: 'Prerequisites not met', detail: `${prereqErrors.value.length} issue(s)`, life: 3000 });
    }
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Check failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    checking.value = false;
  }
}

async function deleteExistingPoolMatches() {
  if (!session.tournament) return;
  const ok = confirm('Delete all existing pool matches for this tournament? This cannot be undone.');
  if (!ok) return false;
  const { error } = await supabase
    .from('matches')
    .delete()
    .eq('tournament_id', session.tournament.id)
    .eq('match_type', 'pool');
  if (error) {
    toast.add({ severity: 'error', summary: 'Delete failed', detail: error.message, life: 3000 });
    return false;
  }
  toast.add({ severity: 'success', summary: 'Existing pool matches deleted', life: 1200 });
  hasMatches.value = false;
  return true;
}

async function runGenerate() {
  lastResult.value = null;
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }
  checking.value = true;
  try {
    const ok = await refreshPrereqs();
    if (!ok) {
      toast.add({ severity: 'warn', summary: 'Fix prerequisites first', detail: `${prereqErrors.value.length} issue(s)`, life: 2500 });
      return;
    }
  } finally {
    checking.value = false;
  }
  // Guard against duplicates
  if (hasMatches.value) {
    const proceeded = await deleteExistingPoolMatches();
    if (!proceeded) return;
  }

  generating.value = true;
  try {
    const res = await generateSchedule(session.tournament.id);
    lastResult.value = res;
    if ((res.errors ?? []).length === 0) {
      toast.add({ severity: 'success', summary: `Generated ${res.inserted} match(es)`, life: 2000 });
    } else {
      toast.add({ severity: 'warn', summary: `Generated ${res.inserted}, with ${res.errors.length} error(s)`, life: 3500 });
    }
    await checkExistingMatches();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Generation failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    generating.value = false;
  }
}

async function resetPoolMatchScores() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }

  const ok = confirm(
    'Reset all pool match scores for this tournament? This will clear submitted and live scores, and cannot be undone.'
  );
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
      .eq('tournament_id', session.tournament.id)
      .eq('match_type', 'pool')
      .select('id');

    if (error) {
      toast.add({ severity: 'error', summary: 'Reset failed', detail: error.message, life: 3000 });
      return;
    }

    const updatedCount = Array.isArray(data) ? data.length : 0;
    if (updatedCount === 0) {
      toast.add({ severity: 'warn', summary: 'No pool matches found to reset', life: 2200 });
    } else {
      toast.add({ severity: 'success', summary: `Reset scores for ${updatedCount} pool match(es)`, life: 2200 });
    }
    await checkExistingMatches();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Reset failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    resettingScores.value = false;
  }
}

onMounted(async () => {
  if (!session.tournament) return;
  await checkExistingMatches();
  await refreshPrereqs();
});

</script>

<template>
  <div class="admin-tool-page -mx-4 min-h-dvh bg-[#0b1120] px-4 py-8 text-slate-100">
    <div class="mx-auto max-w-6xl">
    <UiSectionHeading
      variant="dashboard"
      title="Generate Schedule"
      subtitle="Validate prerequisites and generate pool-play matches using schedule templates."
      :divider="true"
    >
      <Button
        label="Back"
        icon="pi pi-arrow-left"
        severity="secondary"
        outlined
        class="!rounded-xl !border-slate-600/70 !text-slate-200 hover:!border-amber-500/35 hover:!bg-slate-800/80 hover:!text-amber-100"
        @click="router.push({ name: 'admin-dashboard' })"
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
            @click="loadTournamentByAccessCode"
          />
        </div>
      </div>
      <div v-else class="text-sm text-slate-300">
        Loaded: <span class="font-semibold text-white">{{ session.tournament.name }}</span>
        <span class="ml-2 text-slate-400">({{ session.accessCode }})</span>
      </div>
    </div>

    <div v-if="session.tournament" class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
      <!-- Status / actions -->
      <div class="lg:col-span-1">
        <div class="rounded-xl border border-slate-600/45 bg-slate-800/50 p-4 shadow-lg shadow-black/20">
          <div class="flex items-center justify-between">
            <div class="text-sm font-medium text-slate-200">Existing pool matches</div>
            <Tag :value="hasMatches ? 'Yes' : 'No'" :severity="hasMatches ? 'warn' : 'success'" />
          </div>
          <div class="mt-4 grid gap-3">
            <Button
              :loading="checking"
              label="Check Prerequisites"
              icon="pi pi-search"
              :class="adminBtnBluePillClass"
              :pt="adminBtnPillPt"
              @click="runPrereqCheck"
            />
            <Button
              :disabled="!canGenerate"
              :loading="generating"
              label="Generate Schedule"
              icon="pi pi-cog"
              :class="adminBtnGreenPillClass"
              :pt="adminBtnPillPt"
              @click="runGenerate"
            />
            <div class="rounded-xl border border-red-500/45 bg-red-500/10 p-3 shadow-lg shadow-red-950/25">
              <Button
                :loading="resettingScores"
                label="Reset Scores"
                icon="pi pi-refresh"
                :class="adminBtnDangerPillClass"
                :pt="adminBtnPillPt"
                @click="resetPoolMatchScores"
              />
            </div>
            <div
              v-if="hasMatches"
              class="rounded-xl border border-red-500/45 bg-red-500/10 p-3 shadow-lg shadow-red-950/25"
            >
              <Button
                :loading="generating"
                label="Delete Existing Pool Matches"
                icon="pi pi-trash"
                severity="danger"
                :class="adminBtnDangerPillClass"
                :pt="adminBtnPillPt"
                @click="deleteExistingPoolMatches"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Prereq results and last result -->
      <div class="lg:col-span-2">
        <div class="rounded-xl border border-slate-600/45 bg-slate-800/50 p-4 shadow-lg shadow-black/20">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold text-white">Prerequisite Results</h3>
            <Tag :value="prereqErrors.length === 0 ? 'OK' : 'Issues'" :severity="prereqErrors.length === 0 ? 'success' : 'warn'" />
          </div>
          <div class="mt-3">
            <div v-if="prereqErrors.length === 0" class="text-sm text-emerald-300/95">
              All prerequisite checks passed. You can generate the schedule.
            </div>
            <ul v-else class="list-disc list-inside text-sm text-amber-200/95">
              <li v-for="(e, idx) in prereqErrors" :key="idx">{{ e }}</li>
            </ul>
          </div>
        </div>

        <div v-if="lastResult" class="mt-6 rounded-xl border border-slate-600/45 bg-slate-800/50 p-4 shadow-lg shadow-black/20">
          <h3 class="text-lg font-semibold text-white">Last Generation Result</h3>
          <p class="mt-1 text-sm text-slate-300">
            Inserted: <span class="font-semibold text-white">{{ lastResult.inserted }}</span>
          </p>
          <div v-if="(lastResult.errors || []).length > 0" class="mt-2">
            <div class="text-sm font-medium text-amber-200/95">Errors:</div>
            <ul class="list-disc list-inside text-sm text-amber-200/95">
              <li v-for="(e, idx) in lastResult.errors" :key="idx">{{ e }}</li>
            </ul>
          </div>
          <div v-else class="mt-2 text-sm text-emerald-300/95">No errors reported.</div>
        </div>
      </div>
    </div>

    <div class="mt-10 border-t border-slate-800 pt-6 text-sm text-slate-400">
      Note: Generation uses admin-defined templates per pool size. Supported pool sizes are 3–6. Ensure templates exist for each size in use.
    </div>
    </div>
  </div>
</template>

<style scoped>
</style>
