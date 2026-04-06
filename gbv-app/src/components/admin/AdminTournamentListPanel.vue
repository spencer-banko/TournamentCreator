<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import { EyeIcon, PencilSquareIcon, TrashIcon } from '@heroicons/vue/24/outline';
import supabase from '../../lib/supabase';
import { deleteTournamentConfirmOptions } from '../../lib/deleteTournamentConfirm';
import { useSessionStore } from '../../stores/session';
import type { Tournament } from '../../types/db';

const props = withDefaults(
  defineProps<{
    /** dashboard: View activates here + refresh stats; setup: View goes to dashboard */
    variant: 'dashboard' | 'setup';
  }>(),
  {}
);

const emit = defineEmits<{
  edit: [t: Tournament];
  /** After View on dashboard — parent should reload stats */
  'stats-refresh': [];
  /** First load finished (for deep-link edit on setup page) */
  ready: [];
}>();

const router = useRouter();
const toast = useToast();
const confirm = useConfirm();
const session = useSessionStore();

const loading = ref(false);
const deleting = ref(false);
const tournaments = ref<Tournament[]>([]);

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Upcoming / today first (ascending), then past tournaments (most recent past first). */
function sortTournamentsUpcomingFirst(list: Tournament[]): Tournament[] {
  const today = todayYmd();
  const upcoming = list.filter((t) => t.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const past = list.filter((t) => t.date < today).sort((a, b) => b.date.localeCompare(a.date));
  return [...upcoming, ...past];
}

async function loadTournaments() {
  loading.value = true;
  try {
    const { data, error } = await supabase.from('tournaments').select('*');
    if (error) {
      toast.add({ severity: 'error', summary: 'Load failed', detail: error.message, life: 3000 });
      tournaments.value = [];
      return;
    }
    tournaments.value = sortTournamentsUpcomingFirst((data || []) as Tournament[]);
  } finally {
    loading.value = false;
  }
}

function viewTournament(t: Tournament) {
  session.setAdminActiveTournament(t);
  if (props.variant === 'dashboard') {
    emit('stats-refresh');
  } else {
    router.push({ name: 'admin-dashboard' });
  }
}

function editTournament(t: Tournament) {
  if (props.variant === 'dashboard') {
    router.push({ name: 'admin-tournament-setup', query: { edit: t.id } });
  } else {
    emit('edit', t);
  }
}

function requestDeleteTournament(t: Tournament) {
  confirm.require(
    deleteTournamentConfirmOptions(t.name, () => {
      void executeDeleteTournament(t.id);
    })
  );
}

async function executeDeleteTournament(id: string) {
  deleting.value = true;
  try {
    const { error } = await supabase.from('tournaments').delete().eq('id', id);
    if (error) throw error;
    toast.add({ severity: 'success', summary: 'Tournament deleted', life: 1500 });
    if (session.getAdminActiveTournamentId() === id) {
      session.clearAdminActiveTournament({ clearPublicAccessCode: true });
    }
    await loadTournaments();
    if (props.variant === 'dashboard') {
      emit('stats-refresh');
    }
  } catch (err: any) {
    toast.add({
      severity: 'error',
      summary: 'Delete failed',
      detail: err?.message ?? 'Unknown error',
      life: 3500,
    });
  } finally {
    deleting.value = false;
  }
}

onMounted(async () => {
  await loadTournaments();
  emit('ready');
});

function getTournaments(): Tournament[] {
  return tournaments.value;
}

defineExpose({ loadTournaments, getTournaments });
</script>

<template>
  <div
    :class="[
      variant === 'dashboard'
        ? 'admin-tournament-list-panel--dashboard px-1 sm:px-2'
        : 'admin-tournament-list-panel--setup px-1 sm:px-2',
    ]"
  >
    <DataTable
      :value="tournaments"
      scrollable
      :scrollHeight="variant === 'dashboard' ? '22rem' : '32rem'"
      :class="[
        'admin-tournament-datatable rounded-xl border',
        variant === 'dashboard' || variant === 'setup'
          ? 'border-slate-600/40 bg-slate-800/35'
          : 'border-white/10',
      ]"
      :loading="loading || deleting"
      tableClass="!text-base"
      :pt="{
        table: { class: 'bg-transparent' },
        thead: {
          class:
            variant === 'dashboard' || variant === 'setup'
              ? 'bg-slate-800/95 text-slate-200'
              : 'bg-white/10 text-white',
        },
        tbody: {
          class: variant === 'dashboard' || variant === 'setup' ? 'text-slate-200' : 'text-white/90',
        },
      }"
    >
      <!-- Dashboard: # | Date | Name | Access code | Actions -->
      <template v-if="variant === 'dashboard'">
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
          field="date"
          header="Date"
          headerClass="!bg-slate-800/95 !text-slate-200 !border-slate-700/50"
          style="width: 8.5rem"
        >
          <template #body="{ data }">
            <span class="text-base font-semibold text-white">{{ (data as Tournament).date }}</span>
          </template>
        </Column>
        <Column
          field="name"
          header="Name"
          headerClass="!bg-slate-800/95 !text-slate-200 !border-slate-700/50"
        >
          <template #body="{ data }">
            <div class="text-lg font-semibold leading-snug text-white">{{ (data as Tournament).name }}</div>
          </template>
        </Column>
        <Column
          field="access_code"
          header="Access code"
          headerClass="!bg-slate-800/95 !text-slate-200 !border-slate-700/50"
          style="width: 10rem"
        >
          <template #body="{ data }">
            <span class="font-mono text-base font-medium text-white">{{ (data as Tournament).access_code }}</span>
          </template>
        </Column>
        <Column
          header="Actions"
          style="width: 8rem"
          headerClass="!bg-slate-800/95 !text-slate-200 !border-slate-700/50"
        >
          <template #body="{ data }">
            <div class="flex items-center justify-center gap-1">
              <button
                type="button"
                class="dashboard-row-action"
                aria-label="View tournament"
                :disabled="deleting"
                @click="viewTournament(data as Tournament)"
              >
                <EyeIcon class="h-6 w-6" />
              </button>
              <button
                type="button"
                class="dashboard-row-action"
                aria-label="Edit tournament"
                :disabled="deleting"
                @click="editTournament(data as Tournament)"
              >
                <PencilSquareIcon class="h-6 w-6" />
              </button>
              <button
                type="button"
                class="dashboard-row-action dashboard-row-action--danger"
                aria-label="Delete tournament"
                :disabled="deleting"
                @click="requestDeleteTournament(data as Tournament)"
              >
                <TrashIcon class="h-6 w-6" />
              </button>
            </div>
          </template>
        </Column>
      </template>

      <!-- Setup: Date | Name | Actions (same visual language as dashboard) -->
      <template v-else>
        <Column
          field="date"
          header="Date"
          headerClass="!bg-slate-800/95 !text-slate-200 !border-slate-700/50"
          style="width: 8.5rem"
        >
          <template #body="{ data }">
            <span class="text-base font-semibold text-white">{{ (data as Tournament).date }}</span>
          </template>
        </Column>
        <Column field="name" header="Name" headerClass="!bg-slate-800/95 !text-slate-200 !border-slate-700/50">
          <template #body="{ data }">
            <div class="text-lg font-semibold leading-snug text-white">{{ (data as Tournament).name }}</div>
          </template>
        </Column>
        <Column
          header="Actions"
          style="width: 8rem"
          headerClass="!bg-slate-800/95 !text-slate-200 !border-slate-700/50"
        >
          <template #body="{ data }">
            <div class="flex items-center justify-center gap-1">
              <button
                type="button"
                class="dashboard-row-action"
                aria-label="View tournament"
                :disabled="deleting"
                @click="viewTournament(data as Tournament)"
              >
                <EyeIcon class="h-6 w-6" />
              </button>
              <button
                type="button"
                class="dashboard-row-action"
                aria-label="Edit tournament"
                :disabled="deleting"
                @click="editTournament(data as Tournament)"
              >
                <PencilSquareIcon class="h-6 w-6" />
              </button>
              <button
                type="button"
                class="dashboard-row-action dashboard-row-action--danger"
                aria-label="Delete tournament"
                :disabled="deleting"
                @click="requestDeleteTournament(data as Tournament)"
              >
                <TrashIcon class="h-6 w-6" />
              </button>
            </div>
          </template>
        </Column>
      </template>
    </DataTable>
  </div>
</template>

<style scoped>
.admin-tournament-datatable :deep(.p-datatable-table-container) {
  scrollbar-color: rgba(255, 255, 255, 0.35) rgba(255, 255, 255, 0.06);
}

.admin-tournament-list-panel--dashboard :deep(.p-datatable-thead > tr > th),
.admin-tournament-list-panel--setup :deep(.p-datatable-thead > tr > th) {
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
.admin-tournament-list-panel--dashboard :deep(.p-datatable-tbody > tr > td),
.admin-tournament-list-panel--setup :deep(.p-datatable-tbody > tr > td) {
  padding-left: 1.125rem;
  padding-right: 0.75rem;
  padding-top: 1.125rem;
  padding-bottom: 1.125rem;
  vertical-align: middle;
  border-color: rgb(51 65 85 / 0.35);
  transition: background-color 0.15s ease;
}
.admin-tournament-list-panel--dashboard :deep(.p-datatable-tbody > tr:hover > td),
.admin-tournament-list-panel--setup :deep(.p-datatable-tbody > tr:hover > td) {
  background-color: rgb(30 41 59 / 0.45) !important;
}
.admin-tournament-list-panel--dashboard :deep(.p-datatable-thead > tr > th:first-child),
.admin-tournament-list-panel--dashboard :deep(.p-datatable-tbody > tr > td:first-child),
.admin-tournament-list-panel--setup :deep(.p-datatable-thead > tr > th:first-child),
.admin-tournament-list-panel--setup :deep(.p-datatable-tbody > tr > td:first-child) {
  padding-left: 1.25rem;
}
.admin-tournament-list-panel--dashboard :deep(.p-datatable-tbody > tr + tr > td),
.admin-tournament-list-panel--setup :deep(.p-datatable-tbody > tr + tr > td) {
  border-top-color: rgb(51 65 85 / 0.35);
}

.admin-tournament-list-panel--dashboard .dashboard-row-action,
.admin-tournament-list-panel--setup .dashboard-row-action {
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
.admin-tournament-list-panel--dashboard .dashboard-row-action:focus-visible,
.admin-tournament-list-panel--setup .dashboard-row-action:focus-visible {
  outline: 2px solid rgb(251 191 36 / 0.55);
  outline-offset: 2px;
}
.admin-tournament-list-panel--dashboard .dashboard-row-action--danger:focus-visible,
.admin-tournament-list-panel--setup .dashboard-row-action--danger:focus-visible {
  outline-color: rgb(248 113 113 / 0.55);
}
.admin-tournament-list-panel--dashboard .dashboard-row-action:hover:not(:disabled),
.admin-tournament-list-panel--setup .dashboard-row-action:hover:not(:disabled) {
  color: rgb(251 191 36);
  background-color: rgb(251 191 36 / 0.12);
}
.admin-tournament-list-panel--dashboard .dashboard-row-action--danger:hover:not(:disabled),
.admin-tournament-list-panel--setup .dashboard-row-action--danger:hover:not(:disabled) {
  color: rgb(248 113 113);
  background-color: rgb(248 113 113 / 0.12);
}
.admin-tournament-list-panel--dashboard .dashboard-row-action:disabled,
.admin-tournament-list-panel--setup .dashboard-row-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
