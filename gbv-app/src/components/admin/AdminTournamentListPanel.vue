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
        ? 'admin-tournament-list-panel--dashboard admin-row-table px-1 sm:px-2'
        : 'admin-tournament-list-panel--setup admin-row-table px-1 sm:px-2',
    ]"
  >
    <DataTable
      :value="tournaments"
      scrollable
      :scrollHeight="variant === 'dashboard' ? '22rem' : '32rem'"
      :class="[
        'admin-tournament-datatable rounded-xl border',
        variant === 'dashboard' || variant === 'setup'
          ? 'border-tone-600/40 bg-tone-800/35'
          : 'border-ink/10',
      ]"
      :loading="loading || deleting"
      tableClass="!text-base"
      :pt="{
        table: { class: 'bg-transparent' },
        thead: {
          class:
            variant === 'dashboard' || variant === 'setup'
              ? 'bg-tone-800/95 text-tone-200'
              : 'bg-ink/10 text-ink',
        },
        tbody: {
          class: variant === 'dashboard' || variant === 'setup' ? 'text-tone-200' : 'text-ink/90',
        },
      }"
    >
      <!-- Dashboard: # | Date | Name | Access code | Actions -->
      <template v-if="variant === 'dashboard'">
        <Column
          header="#"
          headerClass="!bg-tone-800/95 !text-tone-200 !border-tone-700/50"
          style="width: 2.75rem"
        >
          <template #body="{ index }">
            <span class="text-base tabular-nums text-tone-400">{{ (index as number) + 1 }}</span>
          </template>
        </Column>
        <Column
          field="date"
          header="Date"
          headerClass="!bg-tone-800/95 !text-tone-200 !border-tone-700/50"
          style="width: 8.5rem"
        >
          <template #body="{ data }">
            <span class="text-base font-semibold text-ink">{{ (data as Tournament).date }}</span>
          </template>
        </Column>
        <Column
          field="name"
          header="Name"
          headerClass="!bg-tone-800/95 !text-tone-200 !border-tone-700/50"
        >
          <template #body="{ data }">
            <div class="text-lg font-semibold leading-snug text-ink">{{ (data as Tournament).name }}</div>
          </template>
        </Column>
        <Column
          field="access_code"
          header="Access code"
          headerClass="!bg-tone-800/95 !text-tone-200 !border-tone-700/50"
          style="width: 10rem"
        >
          <template #body="{ data }">
            <span class="font-mono text-base font-medium text-ink">{{ (data as Tournament).access_code }}</span>
          </template>
        </Column>
        <Column
          header="Actions"
          style="width: 8rem"
          headerClass="!bg-tone-800/95 !text-tone-200 !border-tone-700/50"
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
          headerClass="!bg-tone-800/95 !text-tone-200 !border-tone-700/50"
          style="width: 8.5rem"
        >
          <template #body="{ data }">
            <span class="text-base font-semibold text-ink">{{ (data as Tournament).date }}</span>
          </template>
        </Column>
        <Column field="name" header="Name" headerClass="!bg-tone-800/95 !text-tone-200 !border-tone-700/50">
          <template #body="{ data }">
            <div class="text-lg font-semibold leading-snug text-ink">{{ (data as Tournament).name }}</div>
          </template>
        </Column>
        <Column
          header="Actions"
          style="width: 8rem"
          headerClass="!bg-tone-800/95 !text-tone-200 !border-tone-700/50"
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

