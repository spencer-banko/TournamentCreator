<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import UiAccordion from '@/components/ui/UiAccordion.vue';
import { PencilSquareIcon, TrashIcon } from '@heroicons/vue/24/outline';
import { normalizeCell } from '../lib/csv';
import {
  adminBtnPillPt,
  adminBtnBluePillClass,
  adminBtnGreenPillClass,
} from '@/lib/adminButtonStyles';

type TeamRow = {
  id: string;
  full_team_name: string;
  seed_global: number | null;
};

const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = ref<string>('');
const loading = ref(false);

// Existing teams in DB for the tournament
const teams = ref<TeamRow[]>([]);
const deletingTeamId = ref<string | null>(null);

// Manual input
const manualTeamName = ref<string>('');

function changeTournamentCode() {
  session.tournament = null as any;
  session.setAccessCode('');
  accessCode.value = '';
  teams.value = [];
}

async function loadTournamentByAccessCode() {
  if (!accessCode.value?.trim()) {
    toast.add({ severity: 'warn', summary: 'Access code required', life: 2000 });
    return;
  }
  loading.value = true;
  try {
    await session.ensureAnon();
    session.initFromStorage();
    session.setAccessCode(accessCode.value.trim());
    const t = await session.loadTournamentByCode(accessCode.value.trim());
    if (!t) {
      toast.add({ severity: 'error', summary: 'Tournament not found', life: 2500 });
      teams.value = [];
      return;
    }
    toast.add({ severity: 'success', summary: 'Tournament loaded', detail: t.name, life: 1500 });
    await loadTeams();
  } finally {
    loading.value = false;
  }
}

async function loadTeams() {
  if (!session.tournament) return;
  const { data, error } = await supabase
    .from('teams')
    .select('id,full_team_name,seed_global')
    .eq('tournament_id', session.tournament.id)
    .order('seed_global', { ascending: true })
    .order('full_team_name', { ascending: true });

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 2500 });
    teams.value = [];
    return;
  }
  teams.value = (data || []) as TeamRow[];
}

async function createTeam() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 2000 });
    return;
  }
  const name = normalizeCell(manualTeamName.value);
  if (!name) {
    toast.add({ severity: 'warn', summary: 'Team name required', life: 2000 });
    return;
  }

  // Enforce no duplicates in DB (case-insensitive) before insert (matches unique index intent)
  const existingLc = new Set(teams.value.map((t) => normalizeCell(t.full_team_name).toLowerCase()).filter(Boolean));
  const lc = name.toLowerCase();
  if (existingLc.has(lc)) {
    toast.add({ severity: 'warn', summary: 'Duplicate team name', detail: name, life: 2500 });
    return;
  }

  // Find next global seed
  let startSeed = 0;
  {
    const { data: maxSeedRows } = await supabase
      .from('teams')
      .select('seed_global')
      .eq('tournament_id', session.tournament.id)
      .not('seed_global', 'is', null)
      .order('seed_global', { ascending: false })
      .limit(1);
    if (Array.isArray(maxSeedRows) && maxSeedRows.length > 0 && typeof (maxSeedRows[0] as any).seed_global === 'number') {
      startSeed = (maxSeedRows[0] as any).seed_global as number;
    }
  }

  const payload = {
    tournament_id: session.tournament!.id,
    seeded_player_name: name, // legacy column; keep in sync
    full_team_name: name,
    seed_global: startSeed + 1,
    pool_id: null,
    seed_in_pool: null,
  };

  const { error } = await supabase.from('teams').insert(payload);
  if (error) {
    toast.add({ severity: 'error', summary: 'Insert failed', detail: error.message, life: 3000 });
    return;
  }

  manualTeamName.value = '';
  toast.add({ severity: 'success', summary: 'Team created', detail: name, life: 1500 });
  await loadTeams();
}

// Inline edit/delete
const editDialogOpen = ref(false);
const selectedTeam = ref<TeamRow | null>(null);
const editTeamName = ref<string>('');

function openEdit(team: TeamRow) {
  selectedTeam.value = team;
  editTeamName.value = normalizeCell(team.full_team_name);
  editDialogOpen.value = true;
}

async function applyEdit() {
  if (!session.tournament || !selectedTeam.value) return;
  const name = normalizeCell(editTeamName.value);
  if (!name) {
    toast.add({ severity: 'warn', summary: 'Team name required', life: 2000 });
    return;
  }

  const { error } = await supabase
    .from('teams')
    .update({ full_team_name: name, seeded_player_name: name })
    .eq('id', selectedTeam.value.id)
    .eq('tournament_id', session.tournament.id);

  if (error) {
    toast.add({ severity: 'error', summary: 'Update failed', detail: error.message, life: 3000 });
    return;
  }

  toast.add({ severity: 'success', summary: 'Team updated', life: 1200 });
  editDialogOpen.value = false;
  selectedTeam.value = null;
  await loadTeams();
}

async function deleteTeam(team: TeamRow) {
  if (!session.tournament) return;
  const ok = confirm(`Delete "${team.full_team_name}"? This cannot be undone.`);
  if (!ok) return;
  deletingTeamId.value = team.id;
  try {
    const { error } = await supabase.from('teams').delete().eq('id', team.id).eq('tournament_id', session.tournament.id);
    if (error) {
      toast.add({ severity: 'error', summary: 'Delete failed', detail: error.message, life: 3000 });
      return;
    }
    toast.add({ severity: 'success', summary: 'Team deleted', life: 1200 });
    await loadTeams();
  } finally {
    deletingTeamId.value = null;
  }
}

onMounted(async () => {
  try {
    await session.ensureAnon();
    session.initFromStorage();

    if (session.tournament) {
      await loadTeams();
      return;
    }

    if (session.accessCode) {
      accessCode.value = session.accessCode;
      const t = await session.loadTournamentByCode(session.accessCode);
      if (t) await loadTeams();
    }
  } catch {
    // ignore
  }
});
</script>

<template>
  <div class="admin-tool-page -mx-4 min-h-dvh bg-[#0b1120] px-4 py-8 text-slate-100">
    <div class="mx-auto max-w-6xl">
    <UiSectionHeading
      variant="dashboard"
      title="Teams"
      subtitle="Recommended: create teams + pools in one step by uploading a Pools CSV on the Pools & Seeds page."
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

    <!-- Tournament context -->
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
      <div v-else class="flex items-center justify-between">
        <div class="text-sm text-slate-300">
          Tournament:
          <span class="font-semibold text-white">{{ session.tournament?.name }}</span>
          <span class="ml-2 text-slate-400">({{ session.accessCode }})</span>
        </div>
        <Button
          label="Change"
          severity="secondary"
          text
          class="!rounded-xl !text-slate-200 hover:!bg-slate-800/80 hover:!text-amber-100"
          icon="pi pi-external-link"
          @click="changeTournamentCode"
        />
      </div>
    </div>

    <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <!-- Preferred workflow -->
      <div class="rounded-xl border border-slate-600/45 bg-slate-800/50 p-4 shadow-lg shadow-black/20">
        <div class="text-sm font-semibold text-white">Preferred: Pools CSV Import</div>
        <div class="mt-2 text-sm text-slate-300">
          To auto-generate teams + pools (and pool seeds), go to <span class="font-semibold text-white">Pools &amp; Seeds</span> and use
          <span class="font-mono text-slate-200">pool1,pool2,pool3,pool4</span> columns in the template.
        </div>
        <div class="mt-3">
          <Button
            label="Go to Pools & Seeds"
            icon="pi pi-external-link"
            :class="adminBtnGreenPillClass"
            :pt="adminBtnPillPt"
            @click="router.push({ name: 'admin-pools-seeds' })"
          />
        </div>
      </div>

      <!-- Manual Add / Existing Players -->
      <div>
        <UiAccordion title="Manual Add / Existing Teams" :defaultOpen="true">
          <div class="grid gap-4">
            <div class="grid grid-cols-1 gap-3 items-end sm:grid-cols-2">
              <div>
                <label class="mb-2 block text-sm font-medium text-slate-300">Team Name</label>
                <InputText
                  v-model="manualTeamName"
                  placeholder="e.g. Alice + Bob"
                  class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900"
                />
              </div>
              <div class="flex">
                <Button
                  :disabled="!manualTeamName.trim()"
                  label="Create Team"
                  icon="pi pi-check"
                  :class="adminBtnBluePillClass"
                  :pt="adminBtnPillPt"
                  @click="createTeam"
                />
              </div>
            </div>

            <div class="admin-teams-list">
            <!-- Mobile-first existing teams list (matches tournament list panel look) -->
            <div class="lg:hidden rounded-xl border border-slate-600/40 bg-slate-800/35 overflow-hidden">
              <div
                v-for="(t, idx) in teams"
                :key="t.id"
                class="px-4 py-3 border-t border-slate-600/35 first:border-t-0 transition-colors hover:bg-slate-900/40"
              >
                <div class="flex items-start justify-between gap-2">
                  <span class="text-base tabular-nums text-slate-400 shrink-0">{{ idx + 1 }}</span>
                  <div class="min-w-0 flex-1">
                    <div class="text-lg font-semibold leading-snug text-white">{{ t.full_team_name }}</div>
                    <div class="mt-0.5 text-sm text-slate-300">
                      Global seed: <span class="font-semibold text-white">{{ t.seed_global ?? '—' }}</span>
                    </div>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      class="dashboard-row-action"
                      aria-label="Edit team"
                      :disabled="deletingTeamId !== null"
                      @click="openEdit(t)"
                    >
                      <PencilSquareIcon class="h-6 w-6" />
                    </button>
                    <button
                      type="button"
                      class="dashboard-row-action dashboard-row-action--danger"
                      aria-label="Delete team"
                      :disabled="deletingTeamId !== null"
                      @click="deleteTeam(t)"
                    >
                      <TrashIcon class="h-6 w-6" />
                    </button>
                  </div>
                </div>
              </div>
              <div v-if="teams.length === 0" class="px-4 py-4 text-sm text-slate-400">No teams yet.</div>
            </div>

            <!-- Desktop DataTable (aligned with dashboard tournament table) -->
            <div class="hidden lg:block px-1 sm:px-2">
              <DataTable
                :value="teams"
                scrollable
                scrollHeight="22rem"
                class="admin-tournament-datatable rounded-xl border border-slate-600/40 bg-slate-800/35"
                tableClass="!text-base"
                :pt="{
                  table: { class: 'bg-transparent' },
                  thead: { class: 'bg-slate-800/95 text-slate-200' },
                  tbody: { class: 'text-slate-200' },
                }"
              >
                <Column
                  header="#"
                  headerClass="!bg-slate-800/95 !text-slate-200 !border-slate-700/50"
                  style="width: 2.75rem"
                >
                  <template #body="{ index }">
                    <span class="text-base tabular-nums text-slate-400">{{ (index as number) + 1 }}</span>
                  </template>
                </Column>
                <Column
                  field="full_team_name"
                  header="Team name"
                  headerClass="!bg-slate-800/95 !text-slate-200 !border-slate-700/50"
                >
                  <template #body="{ data }">
                    <div class="text-lg font-semibold leading-snug text-white">
                      {{ (data as TeamRow).full_team_name }}
                    </div>
                  </template>
                </Column>
                <Column
                  field="seed_global"
                  header="Global seed"
                  headerClass="!bg-slate-800/95 !text-slate-200 !border-slate-700/50"
                  style="width: 9rem"
                >
                  <template #body="{ data }">
                    <span class="text-base font-semibold text-white">{{
                      (data as TeamRow).seed_global ?? '—'
                    }}</span>
                  </template>
                </Column>
                <Column
                  header="Actions"
                  style="width: 6.5rem"
                  headerClass="!bg-slate-800/95 !text-slate-200 !border-slate-700/50"
                >
                  <template #body="{ data }">
                    <div class="flex items-center justify-center gap-1">
                      <button
                        type="button"
                        class="dashboard-row-action"
                        aria-label="Edit team"
                        :disabled="deletingTeamId !== null"
                        @click="openEdit(data as TeamRow)"
                      >
                        <PencilSquareIcon class="h-6 w-6" />
                      </button>
                      <button
                        type="button"
                        class="dashboard-row-action dashboard-row-action--danger"
                        aria-label="Delete team"
                        :disabled="deletingTeamId !== null"
                        @click="deleteTeam(data as TeamRow)"
                      >
                        <TrashIcon class="h-6 w-6" />
                      </button>
                    </div>
                  </template>
                </Column>
              </DataTable>
            </div>
            </div>

            <!-- Inline editor -->
            <div
              v-if="editDialogOpen"
              class="rounded-xl border border-slate-600/45 bg-slate-800/50 p-4 shadow-lg shadow-black/20"
            >
              <div class="text-sm font-semibold text-white">Edit Team</div>
              <div class="mt-3 grid grid-cols-1 gap-3 items-end sm:grid-cols-2">
                <div class="sm:col-span-2">
                  <label class="mb-2 block text-sm font-medium text-slate-300">Team Name</label>
                  <InputText v-model="editTeamName" class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900" />
                </div>
              </div>
              <div class="mt-3 flex gap-2">
                <Button
                  label="Save"
                  icon="pi pi-save"
                  :class="adminBtnBluePillClass"
                  :pt="adminBtnPillPt"
                  @click="applyEdit"
                />
                <Button
                  label="Cancel"
                  severity="secondary"
                  outlined
                  class="!rounded-xl !border-slate-600/70 !text-slate-200 hover:!border-amber-500/35 hover:!bg-slate-800/80 hover:!text-amber-100"
                  @click="editDialogOpen = false"
                />
              </div>
            </div>
          </div>
        </UiAccordion>
      </div>
    </div>
    </div>
  </div>
</template>

<style scoped>
/* Match AdminTournamentListPanel dashboard tournament table */
.admin-teams-list .admin-tournament-datatable :deep(.p-datatable-table-container) {
  scrollbar-color: rgba(255, 255, 255, 0.35) rgba(255, 255, 255, 0.06);
}

.admin-teams-list :deep(.p-datatable-thead > tr > th) {
  padding-left: 1.125rem;
  padding-right: 0.75rem;
  padding-top: 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid rgb(51 65 85 / 0.45);
  font-size: 1rem !important;
  font-weight: 700 !important;
  letter-spacing: 0.045em;
  text-transform: uppercase;
}

.admin-teams-list :deep(.p-datatable-tbody > tr > td) {
  padding-left: 1.125rem;
  padding-right: 0.75rem;
  padding-top: 1.125rem;
  padding-bottom: 1.125rem;
  vertical-align: middle;
  border-color: rgb(51 65 85 / 0.35);
  transition: background-color 0.15s ease;
}

.admin-teams-list :deep(.p-datatable-tbody > tr:hover > td) {
  background-color: rgb(30 41 59 / 0.45) !important;
}

.admin-teams-list :deep(.p-datatable-thead > tr > th:first-child),
.admin-teams-list :deep(.p-datatable-tbody > tr > td:first-child) {
  padding-left: 1.25rem;
}

.admin-teams-list :deep(.p-datatable-tbody > tr + tr > td) {
  border-top-color: rgb(51 65 85 / 0.35);
}

.admin-teams-list .dashboard-row-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.5rem;
  padding: 0.375rem;
  color: rgb(148 163 184);
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}

.admin-teams-list .dashboard-row-action:focus-visible {
  outline: 2px solid rgb(251 191 36 / 0.55);
  outline-offset: 2px;
}

.admin-teams-list .dashboard-row-action--danger:focus-visible {
  outline-color: rgb(248 113 113 / 0.55);
}

.admin-teams-list .dashboard-row-action:hover:not(:disabled) {
  color: rgb(251 191 36);
  background-color: rgb(251 191 36 / 0.12);
}

.admin-teams-list .dashboard-row-action--danger:hover:not(:disabled) {
  color: rgb(248 113 113);
  background-color: rgb(248 113 113 / 0.12);
}

.admin-teams-list .dashboard-row-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
