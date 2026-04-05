<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Button from 'primevue/button';
import supabase from '../../lib/supabase';
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
  confirm.require({
    message: `Delete "${t.name}"? This cannot be undone.`,
    header: 'Delete tournament',
    icon: 'pi pi-exclamation-triangle',
    acceptClass: 'p-button-danger',
    accept: () => {
      void executeDeleteTournament(t.id);
    },
  });
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
        ? 'admin-tournament-list-panel--dashboard px-4 sm:px-5'
        : 'admin-tournament-list-panel--setup px-1 sm:px-2',
    ]"
  >
    <DataTable
      :value="tournaments"
      :size="variant === 'dashboard' ? 'small' : undefined"
      scrollable
      :scrollHeight="variant === 'dashboard' ? '22rem' : '32rem'"
      class="admin-tournament-datatable rounded-xl border border-white/10"
      :loading="loading || deleting"
      :tableClass="variant === 'dashboard' ? '!text-sm' : '!text-base'"
      :pt="{
        table: { class: 'bg-transparent' },
        thead: { class: 'bg-white/10 text-white' },
        tbody: { class: 'text-white/90' },
      }"
    >
      <!-- Dashboard: # | Date | Name | Access code | Actions -->
      <template v-if="variant === 'dashboard'">
        <Column header="#" headerClass="!bg-white/10 !text-white" style="width: 2.75rem">
          <template #body="{ index }">
            <span class="text-white/90 tabular-nums">{{ (index as number) + 1 }}</span>
          </template>
        </Column>
        <Column field="date" header="Date" headerClass="!bg-white/10 !text-white" style="width: 7.5rem">
          <template #body="{ data }">
            <span class="font-medium text-white">{{ (data as Tournament).date }}</span>
          </template>
        </Column>
        <Column field="name" header="Name" headerClass="!bg-white/10 !text-white">
          <template #body="{ data }">
            <div class="font-medium">{{ (data as Tournament).name }}</div>
            <div class="text-xs text-white/75">{{ (data as Tournament).status }}</div>
          </template>
        </Column>
        <Column field="access_code" header="Access code" headerClass="!bg-white/10 !text-white" style="width: 9rem">
          <template #body="{ data }">
            <span class="font-mono text-sm text-white/95">{{ (data as Tournament).access_code }}</span>
          </template>
        </Column>
        <Column header="Actions" style="width: 11.5rem" headerClass="!bg-white/10 !text-white">
          <template #body="{ data }">
            <div class="flex flex-wrap gap-1">
              <Button
                label="View"
                size="small"
                text
                class="!text-white !px-1"
                :disabled="deleting"
                @click="viewTournament(data as Tournament)"
              />
              <Button
                label="Edit"
                size="small"
                text
                class="!text-white !px-1"
                :disabled="deleting"
                @click="editTournament(data as Tournament)"
              />
              <Button
                label="Delete"
                size="small"
                text
                severity="danger"
                class="!px-1"
                :disabled="deleting"
                @click="requestDeleteTournament(data as Tournament)"
              />
            </div>
          </template>
        </Column>
      </template>

      <!-- Setup: Name (detail) | Actions -->
      <template v-else>
        <Column field="name" header="Name" headerClass="!bg-white/10 !text-white">
          <template #body="{ data }">
            <div class="font-medium leading-snug">{{ (data as Tournament).name }}</div>
            <div class="mt-1 text-sm text-white/80">{{ (data as Tournament).date }} · {{ (data as Tournament).status }}</div>
          </template>
        </Column>
        <Column header="Actions" style="width: 11.5rem" headerClass="!bg-white/10 !text-white">
          <template #body="{ data }">
            <div class="flex flex-wrap gap-1">
              <Button
                label="View"
                size="small"
                text
                class="!text-white !px-1"
                :disabled="deleting"
                @click="viewTournament(data as Tournament)"
              />
              <Button
                label="Edit"
                size="small"
                text
                class="!text-white !px-1"
                :disabled="deleting"
                @click="editTournament(data as Tournament)"
              />
              <Button
                label="Delete"
                size="small"
                text
                severity="danger"
                class="!px-1"
                :disabled="deleting"
                @click="requestDeleteTournament(data as Tournament)"
              />
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

.admin-tournament-list-panel--dashboard :deep(.p-datatable-thead > tr > th) {
  padding-left: 1.125rem;
  padding-right: 0.75rem;
  padding-top: 0.75rem;
  padding-bottom: 0.75rem;
}
.admin-tournament-list-panel--dashboard :deep(.p-datatable-tbody > tr > td) {
  padding-left: 1.125rem;
  padding-right: 0.75rem;
  padding-top: 1rem;
  padding-bottom: 1rem;
  vertical-align: middle;
}
.admin-tournament-list-panel--dashboard :deep(.p-datatable-thead > tr > th:first-child),
.admin-tournament-list-panel--dashboard :deep(.p-datatable-tbody > tr > td:first-child) {
  padding-left: 1.25rem;
}
.admin-tournament-list-panel--dashboard :deep(.p-datatable-tbody > tr + tr > td) {
  border-top-color: rgba(255, 255, 255, 0.12);
}

/* Setup: taller rows + more vertical rhythm; first column inset from table edge */
.admin-tournament-list-panel--setup :deep(.p-datatable-thead > tr > th) {
  padding-top: 0.875rem;
  padding-bottom: 0.875rem;
  padding-left: 1.125rem;
  padding-right: 0.75rem;
}
.admin-tournament-list-panel--setup :deep(.p-datatable-tbody > tr > td) {
  padding-top: 1rem;
  padding-bottom: 1rem;
  padding-left: 1.125rem;
  padding-right: 0.75rem;
  vertical-align: middle;
}
.admin-tournament-list-panel--setup :deep(.p-datatable-thead > tr > th:first-child),
.admin-tournament-list-panel--setup :deep(.p-datatable-tbody > tr > td:first-child) {
  padding-left: 1.5rem;
}
.admin-tournament-list-panel--setup :deep(.p-datatable-tbody > tr + tr > td) {
  border-top-color: rgba(255, 255, 255, 0.12);
}
</style>
