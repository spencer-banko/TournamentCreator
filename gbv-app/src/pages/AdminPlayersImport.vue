<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import { useConfirmAsync } from '../lib/useConfirmAsync';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import Button from 'primevue/button';
import DataTable, { type DataTableRowReorderEvent } from 'primevue/datatable';
import Column from 'primevue/column';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import { useAdminProgressStore } from '../stores/adminProgress';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import { PencilSquareIcon, TrashIcon, ChevronUpIcon, ChevronDownIcon } from '@heroicons/vue/24/outline';
import { normalizeCell, objectsToCsv } from '../lib/csv';
import { parseTeamList, mergeSeeds, moveItem } from '../lib/teamImport';
import {
  adminBtnPillPt,
  adminBtnBluePillClass,
  adminBtnGreenPillClass,
} from '@/lib/adminButtonStyles';

type TeamRow = {
  id: string;
  full_team_name: string;
  seed_global: number | null;
  pool_id: string | null;
};

const router = useRouter();
const toast = useToast();
const askConfirm = useConfirmAsync();
const session = useSessionStore();
const progress = useAdminProgressStore();


// Teams as stored in the DB (sorted by seed) and the local working order (index 0 = seed 1)
const teams = ref<TeamRow[]>([]);
const order = ref<TeamRow[]>([]);
const deletingTeamId = ref<string | null>(null);
const saving = ref(false);

// ---------- Tournament loading ----------

function sortBySeed(rows: TeamRow[]): TeamRow[] {
  return rows.slice().sort((a, b) => {
    if (a.seed_global == null && b.seed_global == null) return a.full_team_name.localeCompare(b.full_team_name);
    if (a.seed_global == null) return 1;
    if (b.seed_global == null) return -1;
    return a.seed_global - b.seed_global;
  });
}

async function loadTeams() {
  void progress.refresh(); // keep sidebar step statuses current
  if (!session.tournament) return;
  const { data, error } = await supabase
    .from('teams')
    .select('id,full_team_name,seed_global,pool_id')
    .eq('tournament_id', session.tournament.id);

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 2500 });
    teams.value = [];
    order.value = [];
    return;
  }
  teams.value = sortBySeed((data || []) as TeamRow[]);
  order.value = teams.value.slice();
}

// ---------- Seed order (drag / arrows / typed seed) ----------

/** True when the on-screen order differs from the seeds stored in the DB (incl. gaps). */
const seedsDirty = computed(() => order.value.some((t, i) => t.seed_global !== i + 1));
const hasPools = computed(() => teams.value.some((t) => t.pool_id));

function onRowReorder(e: DataTableRowReorderEvent) {
  order.value = e.value as TeamRow[];
}

function moveBy(idx: number, delta: number) {
  order.value = moveItem(order.value, idx, idx + delta);
}

function onSeedInput(idx: number, e: Event) {
  const input = e.target as HTMLInputElement;
  const n = Number(input.value);
  if (!Number.isInteger(n) || n < 1) {
    input.value = String(idx + 1);
    return;
  }
  const target = Math.min(n, order.value.length) - 1;
  if (target === idx) {
    input.value = String(idx + 1);
    return;
  }
  order.value = moveItem(order.value, idx, target);
}

function discardSeedChanges() {
  order.value = teams.value.slice();
}

/**
 * Persist `ids` as seeds 1..N. teams(tournament_id, seed_global) is uniquely indexed and not
 * deferrable, so clear the tournament's seeds first, then write the new ones.
 */
async function writeSeeds(ids: string[]): Promise<boolean> {
  if (!session.tournament) return false;
  const tid = session.tournament.id;
  const { error: clearErr } = await supabase.from('teams').update({ seed_global: null }).eq('tournament_id', tid);
  if (clearErr) {
    toast.add({ severity: 'error', summary: 'Saving seeds failed', detail: clearErr.message, life: 3500 });
    return false;
  }
  const results = await Promise.all(
    ids.map((id, i) => supabase.from('teams').update({ seed_global: i + 1 }).eq('id', id).eq('tournament_id', tid)),
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) {
    toast.add({ severity: 'error', summary: 'Saving seeds failed', detail: failed.error.message, life: 3500 });
    return false;
  }
  return true;
}

async function saveSeeds() {
  saving.value = true;
  try {
    const ok = await writeSeeds(order.value.map((t) => t.id));
    if (ok) toast.add({ severity: 'success', summary: 'Seeds saved', life: 1500 });
    await loadTeams();
  } finally {
    saving.value = false;
  }
}

// ---------- Adding teams (single + bulk paste / CSV) ----------

const manualTeamName = ref<string>('');
const bulkText = ref<string>('');
const csvInput = ref<HTMLInputElement | null>(null);

const parsed = computed(() => parseTeamList(bulkText.value, teams.value.map((t) => t.full_team_name)));

/** Final seed each importable row will get once merged with the current order. */
const previewSeeds = computed(() => {
  const merged = mergeSeeds(order.value, parsed.value.importable);
  const map = new Map<number, number>();
  merged.forEach((m, i) => {
    if (m.kind === 'new') map.set(m.item.line, i + 1);
  });
  return map;
});

const previewSummary = computed(() => {
  const rows = parsed.value.rows;
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return { add: count('new'), skipped: count('duplicate') + count('exists'), errors: count('error') };
});

async function addTeams(incoming: Array<{ name: string; seed: number | null }>): Promise<boolean> {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 2000 });
    return false;
  }
  if (incoming.length === 0) return false;
  const tid = session.tournament.id;

  // Insert without seeds (avoids unique-seed collisions), then write the merged order.
  const { data, error } = await supabase
    .from('teams')
    .insert(
      incoming.map((t) => ({
        tournament_id: tid,
        seeded_player_name: t.name, // legacy column; keep in sync
        full_team_name: t.name,
        seed_global: null,
        pool_id: null,
        seed_in_pool: null,
      })),
    )
    .select('id,full_team_name');

  if (error) {
    toast.add({ severity: 'error', summary: 'Adding teams failed', detail: error.message, life: 3500 });
    return false;
  }

  const idByName = new Map((data || []).map((r: any) => [normalizeCell(r.full_team_name).toLowerCase(), r.id as string]));
  const merged = mergeSeeds(order.value, incoming);
  const ids = merged
    .map((m) => (m.kind === 'existing' ? m.item.id : idByName.get(m.item.name.toLowerCase())))
    .filter((id): id is string => !!id);

  const ok = await writeSeeds(ids);
  await loadTeams();
  if (ok) {
    toast.add({
      severity: 'success',
      summary: incoming.length === 1 ? 'Team added' : `${incoming.length} teams added`,
      life: 1800,
    });
  }
  return true;
}

async function createTeam() {
  const name = normalizeCell(manualTeamName.value);
  if (!name) return;
  if (teams.value.some((t) => normalizeCell(t.full_team_name).toLowerCase() === name.toLowerCase())) {
    toast.add({ severity: 'warn', summary: 'Duplicate team name', detail: name, life: 2500 });
    return;
  }
  saving.value = true;
  try {
    if (await addTeams([{ name, seed: null }])) manualTeamName.value = '';
  } finally {
    saving.value = false;
  }
}

async function importBulk() {
  if (parsed.value.errors.length) return;
  saving.value = true;
  try {
    if (await addTeams(parsed.value.importable.map((r) => ({ name: r.name, seed: r.seed })))) bulkText.value = '';
  } finally {
    saving.value = false;
  }
}

async function onCsvSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  bulkText.value = await file.text();
  if (csvInput.value) csvInput.value.value = '';
}

function downloadTemplate() {
  const rows = [
    { team_name: 'Alex / Jordan', seed: 1 },
    { team_name: 'Sam / Taylor', seed: 2 },
    { team_name: 'Riley / Casey', seed: '' },
  ];
  const blob = new Blob([objectsToCsv(rows, ['team_name', 'seed'])], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'teams_template.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Edit / delete ----------

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
  // Keep any unsaved reordering: patch the name locally instead of reloading
  for (const list of [teams.value, order.value]) {
    const t = list.find((x) => x.id === selectedTeam.value!.id);
    if (t) t.full_team_name = name;
  }
  selectedTeam.value = null;
}

async function deleteTeam(team: TeamRow) {
  if (!session.tournament) return;
  const ok = await askConfirm(`Delete "${team.full_team_name}"? This cannot be undone.`);
  if (!ok) return;
  deletingTeamId.value = team.id;
  try {
    const { error } = await supabase.from('teams').delete().eq('id', team.id).eq('tournament_id', session.tournament.id);
    if (error) {
      toast.add({ severity: 'error', summary: 'Delete failed', detail: error.message, life: 3000 });
      return;
    }
    toast.add({ severity: 'success', summary: 'Team deleted', life: 1200 });
    const hadUnsaved = seedsDirty.value;
    teams.value = teams.value.filter((t) => t.id !== team.id);
    order.value = order.value.filter((t) => t.id !== team.id);
    // Close the seed gap automatically unless the admin is mid-reorder (Save will renumber then)
    if (!hadUnsaved && seedsDirty.value) {
      await writeSeeds(order.value.map((t) => t.id));
      await loadTeams();
    }
  } finally {
    deletingTeamId.value = null;
  }
}

onMounted(async () => {
  // AdminLayout has already resolved the active tournament.
  await session.restoreAdminTournament();
  await loadTeams();
});

const statusClass: Record<string, string> = {
  new: 'text-emerald-400',
  duplicate: 'text-tone-400',
  exists: 'text-tone-400',
  error: 'text-red-400',
};
</script>

<template>
  <div class="admin-tool-page text-tone-100">
    <div class="mx-auto max-w-6xl">
    <UiSectionHeading
      variant="dashboard"
      title="Teams"
      subtitle="Paste or upload your team list, then drag or type to set seeds."
      :divider="true"
    >
    </UiSectionHeading>

    <div class="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <!-- ================= Add teams ================= -->
      <section class="rounded-xl border border-tone-600/45 bg-tone-800/50 p-4 shadow-lg shadow-black/20">
        <h2 class="text-lg font-semibold text-ink">Add teams</h2>

        <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div class="flex-1">
            <label class="mb-2 block text-sm font-medium text-tone-300">Single team</label>
            <InputText
              v-model="manualTeamName"
              placeholder="e.g. Alice / Bob"
              class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900"
              @keydown.enter="createTeam"
            />
          </div>
          <Button
            :disabled="!manualTeamName.trim() || saving || !session.tournament"
            label="Add"
            icon="pi pi-plus"
            :class="adminBtnBluePillClass"
            :pt="adminBtnPillPt"
            @click="createTeam"
          />
        </div>

        <div class="my-5 flex items-center gap-3 text-xs font-semibold uppercase tracking-wider text-tone-500">
          <span class="h-px flex-1 bg-tone-600/45" />or add a list<span class="h-px flex-1 bg-tone-600/45" />
        </div>

        <label class="mb-2 block text-sm font-medium text-tone-300" for="bulk-teams">
          Paste one team per line — add a seed number if you have one
        </label>
        <Textarea
          id="bulk-teams"
          v-model="bulkText"
          rows="8"
          class="w-full !rounded-xl !px-4 !py-3 !bg-white !font-mono !text-sm !text-slate-900"
          :placeholder="'Alice / Bob, 1\nCara / Dee, 2\nEve / Fay\n\n(Copying straight from Google Sheets works too.)'"
        />

        <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <input ref="csvInput" type="file" accept=".csv,.tsv,.txt,text/csv" class="hidden" @change="onCsvSelected" />
          <button type="button" class="font-semibold text-amber-300 hover:underline" @click="csvInput?.click()">
            <i class="pi pi-upload mr-1 text-xs" />Upload CSV
          </button>
          <button type="button" class="font-semibold text-amber-300 hover:underline" @click="downloadTemplate">
            <i class="pi pi-download mr-1 text-xs" />Download template
          </button>
          <button v-if="bulkText" type="button" class="text-tone-400 hover:text-ink" @click="bulkText = ''">Clear</button>
        </div>

        <!-- Preview -->
        <div v-if="parsed.rows.length" class="mt-4">
          <div class="mb-2 text-sm text-tone-300">
            <span class="font-semibold text-emerald-400">{{ previewSummary.add }} to add</span>
            <span v-if="previewSummary.skipped"> · {{ previewSummary.skipped }} skipped</span>
            <span v-if="previewSummary.errors" class="text-red-400"> · {{ previewSummary.errors }} to fix</span>
          </div>
          <ul v-if="parsed.errors.length" class="mb-2 list-disc space-y-0.5 pl-5 text-sm text-red-400">
            <li v-for="err in parsed.errors" :key="err">{{ err }}</li>
          </ul>
          <div class="max-h-72 overflow-auto rounded-xl border border-tone-600/40">
            <table class="w-full text-sm">
              <thead class="sticky top-0 bg-tone-800 text-left text-xs uppercase tracking-wider text-tone-400">
                <tr>
                  <th class="px-3 py-2 w-16">Seed</th>
                  <th class="px-3 py-2">Team</th>
                  <th class="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in parsed.rows" :key="r.line" class="border-t border-tone-600/30">
                  <td class="px-3 py-2 tabular-nums text-ink">{{ r.status === 'new' ? previewSeeds.get(r.line) : '—' }}</td>
                  <td class="px-3 py-2 text-ink">{{ r.name || '(blank)' }}</td>
                  <td class="px-3 py-2" :class="statusClass[r.status]">{{ r.message ?? 'New' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="mt-3 flex items-center gap-3">
            <Button
              :disabled="!previewSummary.add || parsed.errors.length > 0 || saving || !session.tournament"
              :loading="saving"
              :label="`Add ${previewSummary.add} team${previewSummary.add === 1 ? '' : 's'}`"
              icon="pi pi-check"
              :class="adminBtnGreenPillClass"
              :pt="adminBtnPillPt"
              @click="importBulk"
            />
            <span v-if="!session.tournament" class="text-sm text-tone-400">Load a tournament first.</span>
          </div>
        </div>
      </section>

      <!-- ================= Teams & seeds ================= -->
      <section class="rounded-xl border border-tone-600/45 bg-tone-800/50 p-4 shadow-lg shadow-black/20">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="text-lg font-semibold text-ink">Teams &amp; seeds</h2>
          <span class="text-sm text-tone-400">{{ order.length }} team{{ order.length === 1 ? '' : 's' }}</span>
        </div>
        <p class="mt-1 text-sm text-tone-400">Drag rows (or use the arrows) or type a seed number. Seed 1 is the top team.</p>

        <div
          v-if="hasPools && seedsDirty"
          class="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
        >
          Pools are already set up. Changing seeds won't move teams between pools — re-run
          <button type="button" class="font-semibold underline" @click="router.push({ name: 'admin-pools-seeds' })">Auto-generate pools</button>
          if you want them rebuilt.
        </div>

        <!-- Save bar -->
        <div
          v-if="seedsDirty && order.length"
          class="sticky top-28 z-10 mt-3 lg:top-20 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-tone-900/95 px-3 py-2 shadow-lg backdrop-blur"
        >
          <span class="text-sm font-medium text-ink">Seed order not saved</span>
          <div class="flex gap-2">
            <button type="button" class="rounded-lg px-3 py-1.5 text-sm text-tone-300 hover:bg-tone-700/60 hover:text-ink" :disabled="saving" @click="discardSeedChanges">Discard</button>
            <Button
              label="Save seeds"
              icon="pi pi-save"
              :loading="saving"
              :class="adminBtnBluePillClass + ' !min-h-[2.25rem] !py-1.5 !px-4 !text-sm'"
              :pt="adminBtnPillPt"
              @click="saveSeeds"
            />
          </div>
        </div>

        <div class="admin-row-table mt-3">
          <!-- Mobile list -->
          <div class="lg:hidden overflow-hidden rounded-xl border border-tone-600/40 bg-tone-800/35">
            <div
              v-for="(t, idx) in order"
              :key="t.id"
              class="admin-row flex items-center gap-2 border-t border-tone-600/35 px-3 py-3 transition-colors first:border-t-0"
            >
              <div class="flex flex-col">
                <button type="button" class="dashboard-row-action !p-0.5" aria-label="Move up" :disabled="idx === 0" @click="moveBy(idx, -1)">
                  <ChevronUpIcon class="h-5 w-5" />
                </button>
                <button type="button" class="dashboard-row-action !p-0.5" aria-label="Move down" :disabled="idx === order.length - 1" @click="moveBy(idx, 1)">
                  <ChevronDownIcon class="h-5 w-5" />
                </button>
              </div>
              <input
                type="number"
                min="1"
                :max="order.length"
                :value="idx + 1"
                class="seed-input"
                :aria-label="`Seed for ${t.full_team_name}`"
                @change="onSeedInput(idx, $event)"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              />
              <div class="min-w-0 flex-1 text-base font-semibold leading-snug text-ink">{{ t.full_team_name }}</div>
              <button type="button" class="dashboard-row-action" aria-label="Edit team" :disabled="deletingTeamId !== null" @click="openEdit(t)">
                <PencilSquareIcon class="h-6 w-6" />
              </button>
              <button type="button" class="dashboard-row-action dashboard-row-action--danger" aria-label="Delete team" :disabled="deletingTeamId !== null" @click="deleteTeam(t)">
                <TrashIcon class="h-6 w-6" />
              </button>
            </div>
            <div v-if="order.length === 0" class="px-4 py-4 text-sm text-tone-400">No teams yet.</div>
          </div>

          <!-- Desktop table with drag-to-reorder -->
          <div class="hidden lg:block">
            <DataTable
              :value="order"
              dataKey="id"
              scrollable
              scrollHeight="32rem"
              class="rounded-xl border border-tone-600/40 bg-tone-800/35"
              tableClass="!text-base"
              :pt="{
                table: { class: 'bg-transparent' },
                thead: { class: 'bg-tone-800/95 text-tone-200' },
                tbody: { class: 'text-tone-200' },
              }"
              @row-reorder="onRowReorder"
            >
              <template #empty><span class="text-sm text-tone-400">No teams yet.</span></template>
              <Column rowReorder headerClass="!bg-tone-800/95 !border-tone-700/50" style="width: 2.5rem" :pt="{ rowReorderIcon: { class: '!text-tone-400 cursor-grab' } }" />
              <Column header="Seed" headerClass="!bg-tone-800/95 !text-tone-200 !border-tone-700/50" style="width: 6rem">
                <template #body="{ data, index }">
                  <input
                    type="number"
                    min="1"
                    :max="order.length"
                    :value="(index as number) + 1"
                    class="seed-input"
                    :aria-label="`Seed for ${(data as TeamRow).full_team_name}`"
                    @change="onSeedInput(index as number, $event)"
                    @keydown.enter="($event.target as HTMLInputElement).blur()"
                  />
                </template>
              </Column>
              <Column field="full_team_name" header="Team name" headerClass="!bg-tone-800/95 !text-tone-200 !border-tone-700/50">
                <template #body="{ data }">
                  <div class="text-lg font-semibold leading-snug text-ink">{{ (data as TeamRow).full_team_name }}</div>
                </template>
              </Column>
              <Column header="Actions" style="width: 6.5rem" headerClass="!bg-tone-800/95 !text-tone-200 !border-tone-700/50">
                <template #body="{ data }">
                  <div class="flex items-center justify-center gap-1">
                    <button type="button" class="dashboard-row-action" aria-label="Edit team" :disabled="deletingTeamId !== null" @click="openEdit(data as TeamRow)">
                      <PencilSquareIcon class="h-6 w-6" />
                    </button>
                    <button type="button" class="dashboard-row-action dashboard-row-action--danger" aria-label="Delete team" :disabled="deletingTeamId !== null" @click="deleteTeam(data as TeamRow)">
                      <TrashIcon class="h-6 w-6" />
                    </button>
                  </div>
                </template>
              </Column>
            </DataTable>
          </div>
        </div>

        <!-- Inline editor -->
        <div v-if="editDialogOpen" class="mt-4 rounded-xl border border-tone-600/45 bg-tone-800/50 p-4 shadow-lg shadow-black/20">
          <div class="text-sm font-semibold text-ink">Edit team</div>
          <div class="mt-3">
            <label class="mb-2 block text-sm font-medium text-tone-300">Team name</label>
            <InputText v-model="editTeamName" class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900" @keydown.enter="applyEdit" />
          </div>
          <div class="mt-3 flex gap-2">
            <Button label="Save" icon="pi pi-save" :class="adminBtnBluePillClass" :pt="adminBtnPillPt" @click="applyEdit" />
            <Button
              label="Cancel"
              severity="secondary"
              outlined
              class="!rounded-xl !border-tone-600/70 !text-tone-200 hover:!border-amber-500/35 hover:!bg-tone-800/80 hover:!text-amber-100"
              @click="editDialogOpen = false"
            />
          </div>
        </div>
      </section>
    </div>

    <!-- Advanced -->
    <div class="mt-6 rounded-xl border border-tone-600/35 bg-tone-800/30 p-4 text-sm text-tone-300">
      <span class="font-semibold text-ink">Advanced:</span>
      already have pools decided? Upload a Pools CSV on
      <button type="button" class="font-semibold text-amber-300 hover:underline" @click="router.push({ name: 'admin-pools-seeds' })">Pools &amp; Seeds</button>
      to create teams, pools and pool seeds in one step (this replaces all existing teams).
    </div>
    </div>
  </div>
</template>

<style scoped>
.seed-input {
  width: 3.75rem;
  border-radius: 0.5rem;
  border: 1px solid rgba(var(--ink-rgb), 0.18);
  background: var(--color-paper);
  color: #0f172a;
  padding: 0.3rem 0.4rem;
  text-align: center;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.seed-input:focus {
  outline: 2px solid color-mix(in srgb, var(--color-amber-400) 55%, transparent);
  outline-offset: 1px;
}
</style>
