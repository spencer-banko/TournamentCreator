<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import { useSessionStore } from '../stores/session';
import InputText from 'primevue/inputtext';
import Dropdown from 'primevue/dropdown';
import Button from 'primevue/button';
import InputNumber from 'primevue/inputnumber';
import ToggleButton from 'primevue/togglebutton';
import supabase from '../lib/supabase';
import { defaultTemplateForPoolSize } from '../lib/defaultTemplates';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import AdminTournamentListPanel from '@/components/admin/AdminTournamentListPanel.vue';
import {
  adminBtnPillPt,
  adminBtnBluePillClass,
  adminBtnDangerPillClass,
} from '@/lib/adminButtonStyles';
import type { Tournament, TournamentStatus, AdvancementRules, GameRules } from '../types/db';

type EditableTournament = {
  id: string | null;
  name: string;
  date: string; // ISO (YYYY-MM-DD)
  access_code: string;
  status: TournamentStatus;
  advancement_rules: AdvancementRules;
  game_rules: GameRules;
  bracket_started: boolean;
  bracket_generated_at: string | null;
};

const router = useRouter();
const route = useRoute();
const toast = useToast();
const confirm = useConfirm();
const session = useSessionStore();

const saving = ref(false);
const selectedId = ref<string | null>(null);
const tournamentListRef = ref<InstanceType<typeof AdminTournamentListPanel> | null>(null);

const statusOptions: { label: string; value: TournamentStatus }[] = [
  { label: 'Draft', value: 'draft' },
  { label: 'Setup', value: 'setup' },
  { label: 'Pool Play', value: 'pool_play' },
  { label: 'Bracket', value: 'bracket' },
  { label: 'Completed', value: 'completed' },
];

// Defaults per Bundle C
const DEFAULT_ADV_RULES: AdvancementRules = {
  pools: [
    { fromPoolSize: 3, advanceCount: 2 },
    { fromPoolSize: 4, advanceCount: 2 },
    { fromPoolSize: 5, advanceCount: 2 },
    { fromPoolSize: 6, advanceCount: 3 },
  ],
  bracketFormat: 'single_elimination',
  tiebreakers: ['head_to_head', 'set_ratio', 'point_diff', 'random'],
};

const DEFAULT_GAME_RULES: GameRules = {
  pool: {
    setTarget: 21,
    cap: 99,
    bestOf: 1,
    winBy2: true,
    setTargetByPoolSize: { '3': 21, '4': 21, '5': 21, '6': 21 },
  },
  bracket: { setTarget: 21, cap: 99, bestOf: 1, winBy2: true, thirdSetTarget: 15 },
};

const form = ref<EditableTournament>({
  id: null,
  name: '',
  date: '',
  access_code: '',
  status: 'draft',
  advancement_rules: structuredClone(DEFAULT_ADV_RULES),
  game_rules: structuredClone(DEFAULT_GAME_RULES),
  bracket_started: false,
  bracket_generated_at: null,
});


function toForm(t: Tournament | null) {
  if (!t) {
    form.value = {
      id: null,
      name: '',
      date: '',
      access_code: '',
      status: 'draft',
      advancement_rules: structuredClone(DEFAULT_ADV_RULES),
      game_rules: structuredClone(DEFAULT_GAME_RULES),
      bracket_started: false,
      bracket_generated_at: null,
    };
    return;
  }
  form.value = {
    id: t.id,
    name: t.name,
    date: t.date,
    access_code: t.access_code,
    status: t.status,
    advancement_rules: normalizeAdvancementRules(t.advancement_rules),
    game_rules: normalizeGameRules(t.game_rules),
    bracket_started: (t as any).bracket_started ?? false,
    bracket_generated_at: (t as any).bracket_generated_at ?? null,
  };
}

function normalizeAdvancementRules(r: AdvancementRules | null | undefined): AdvancementRules {
  const base = structuredClone(DEFAULT_ADV_RULES);
  if (!r) return base;
  const next: AdvancementRules = {
    pools: Array.isArray(r.pools) ? r.pools.slice() : base.pools!.slice(),
    bracketFormat: r.bracketFormat ?? base.bracketFormat,
    tiebreakers: (r.tiebreakers?.length ? r.tiebreakers : base.tiebreakers) as any,
  };
  ensurePoolsConfig(next);
  return next;
}

function normalizeGameRules(r: GameRules | null | undefined): GameRules {
  const base = structuredClone(DEFAULT_GAME_RULES);
  if (!r) return base;
  const poolOverridesRaw = (r.pool as any)?.setTargetByPoolSize;
  const poolOverrides =
    poolOverridesRaw && typeof poolOverridesRaw === 'object' && !Array.isArray(poolOverridesRaw)
      ? poolOverridesRaw as Record<string, any>
      : {};
  const baseOverrides = (base.pool as any)?.setTargetByPoolSize || {};
  const mergedOverrides: Record<string, number> = { ...baseOverrides };
  for (const [k, v] of Object.entries(poolOverrides)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) mergedOverrides[String(k)] = n;
  }
  return {
    pool: {
      setTarget: r.pool?.setTarget ?? base.pool!.setTarget,
      cap: r.pool?.cap ?? base.pool!.cap,
      bestOf: r.pool?.bestOf ?? base.pool!.bestOf,
      winBy2: r.pool?.winBy2 ?? base.pool!.winBy2,
      setTargetByPoolSize: mergedOverrides,
    },
    bracket: {
      setTarget: r.bracket?.setTarget ?? base.bracket!.setTarget,
      cap: r.bracket?.cap ?? base.bracket!.cap,
      bestOf: r.bracket?.bestOf ?? base.bracket!.bestOf,
      winBy2: r.bracket?.winBy2 ?? base.bracket!.winBy2,
      thirdSetTarget: r.bracket?.thirdSetTarget ?? base.bracket!.thirdSetTarget,
    },
  };
}

function newTournament() {
  selectedId.value = null;
  toForm(null);
}

function selectTournament(t: Tournament) {
  selectedId.value = t.id;
  toForm(t);
}

function requestDeleteCurrentForm() {
  if (!form.value.id) return;
  const name =
    tournamentListRef.value?.getTournaments().find((x: Tournament) => x.id === form.value.id)?.name ??
    form.value.name;
  confirm.require({
    message: `Delete "${name}"? This cannot be undone.`,
    header: 'Delete tournament',
    icon: 'pi pi-exclamation-triangle',
    acceptClass: 'p-button-danger',
    accept: () => {
      void executeDeleteTournament(form.value.id!);
    },
  });
}

// Helpers — Advancement UI

type Tiebreaker = 'head_to_head' | 'set_ratio' | 'point_diff' | 'random';
function formatTb(tb: Tiebreaker): string { return String(tb).replace(/_/g, ' '); }

function ensurePoolsConfig(rules: AdvancementRules) {
  const sizes = [3, 4, 5, 6];
  if (!Array.isArray(rules.pools)) rules.pools = [];
  for (const s of sizes) {
    const existing = rules.pools!.find((p) => p.fromPoolSize === s);
    if (!existing) {
      const defaults: Record<number, number> = { 3: 2, 4: 2, 5: 2, 6: 3 };
      rules.pools!.push({ fromPoolSize: s, advanceCount: defaults[s] ?? Math.min(2, s) });
    }
  }
  // sort by size asc
  rules.pools!.sort((a, b) => a.fromPoolSize - b.fromPoolSize);
}

function getAdvanceCount(size: number): number {
  ensurePoolsConfig(form.value.advancement_rules);
  const found = form.value.advancement_rules.pools!.find((p) => p.fromPoolSize === size);
  return found?.advanceCount ?? 0;
}

function setAdvanceCount(size: number, value: number) {
  ensurePoolsConfig(form.value.advancement_rules);
  const max = size;
  const val = Math.max(0, Math.min(max, Number(value) || 0));
  const found = form.value.advancement_rules.pools!.find((p) => p.fromPoolSize === size);
  if (found) found.advanceCount = val;
}

const tiebreakerOptions: Tiebreaker[] = [
  'head_to_head',
  'set_ratio',
  'point_diff',
  'random',
];

function moveTiebreaker(idx: number, dir: -1 | 1) {
  const list = form.value.advancement_rules.tiebreakers || [];
  const i = idx;
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  const tmp = list[i]!;
  list[i] = list[j]!;
  list[j] = tmp;
  form.value.advancement_rules.tiebreakers = list.slice();
}

function toggleTiebreaker(v: Tiebreaker) {
  const list = (form.value.advancement_rules.tiebreakers || []) as Tiebreaker[];
  const i = list.indexOf(v);
  if (i >= 0) {
    list.splice(i, 1);
  } else {
    list.push(v);
  }
  form.value.advancement_rules.tiebreakers = list.slice();
}

// Validation and persistence

function validateForm() {
  if (!form.value.name.trim()) throw new Error('Name is required');
  if (!form.value.date.trim()) throw new Error('Date is required (YYYY-MM-DD)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.value.date.trim())) {
    throw new Error('Date must be YYYY-MM-DD');
  }
  if (!form.value.access_code.trim()) throw new Error('Access code is required');

  // Advancement rules sanity
  ensurePoolsConfig(form.value.advancement_rules);
  const tb = form.value.advancement_rules.tiebreakers || [];
  if (tb.length === 0) throw new Error('At least one tiebreaker is required');
  if (!form.value.advancement_rules.bracketFormat) throw new Error('Bracket format is required');

  // Game rules sanity
  const gr = form.value.game_rules;
  const phases: Array<keyof GameRules> = ['pool', 'bracket'];
  for (const ph of phases) {
    const r: any = (gr as any)[ph] || {};
    ['setTarget', 'cap', 'bestOf'].forEach((k) => {
      if (r[k] == null || Number(r[k]) <= 0) {
        throw new Error(`Game rules (${ph}) require ${k}`);
      }
    });
    if (ph === 'pool') {
      const m = r.setTargetByPoolSize;
      if (m != null) {
        if (typeof m !== 'object' || Array.isArray(m)) throw new Error('Game rules (pool) setTargetByPoolSize must be an object');
        for (const [k, v] of Object.entries(m)) {
          const n = Number(v);
          if (!Number.isFinite(n) || n <= 0) throw new Error(`Game rules (pool) setTargetByPoolSize[${k}] must be a positive number`);
        }
      }
    }
    if (ph === 'bracket' && r.bestOf === 3) {
      if (r.thirdSetTarget == null || Number(r.thirdSetTarget) <= 0) {
        throw new Error('Game rules (bracket) require thirdSetTarget when bestOf = 3');
      }
    }
  }
}

async function saveTournament() {
  try {
    validateForm();
  } catch (err: any) {
    toast.add({ severity: 'warn', summary: 'Validation', detail: err.message, life: 3000 });
    return;
  }

  const payload: any = {
    name: form.value.name.trim(),
    date: form.value.date.trim(),
    access_code: form.value.access_code.trim(),
    status: form.value.status,
    advancement_rules: form.value.advancement_rules,
    game_rules: form.value.game_rules,
  };

  // Preserve bracket flags only via DB-generated logic; allow manual override here only if present
  if (typeof form.value.bracket_started === 'boolean') payload.bracket_started = form.value.bracket_started;
  payload.bracket_generated_at = form.value.bracket_generated_at;

  saving.value = true;
  try {
    if (form.value.id) {
      const { error } = await supabase.from('tournaments').update(payload).eq('id', form.value.id);
      if (error) throw error;
      toast.add({ severity: 'success', summary: 'Tournament updated', life: 1500 });
    } else {
      const { data: authData, error: authErr } = await supabase.auth.getUser();
      const user = authData.user;
      if (authErr || !user) {
        toast.add({
          severity: 'error',
          summary: 'Not signed in',
          detail: 'Sign in again to create a tournament.',
          life: 4000,
        });
        return;
      }
      if (user.is_anonymous) {
        toast.add({
          severity: 'error',
          summary: 'Email sign-in required',
          detail: 'Guest mode cannot create tournaments. Use Admin Login with your email and password.',
          life: 5000,
        });
        return;
      }
      await session.refreshAdminUser();
      // Let DB trigger tournaments_set_created_by set created_from JWT (avoids RLS/client uid mismatch).
      const { data, error } = await supabase.from('tournaments').insert(payload).select('*').single();
      if (error) throw error;
      toast.add({ severity: 'success', summary: 'Tournament created', life: 1500 });
      if (data) {
        const newId = (data as Tournament).id;
        selectedId.value = newId;

        // Auto-seed default schedule templates for supported pool sizes if missing
        try {
          const sizesToSeed = [3, 4, 5, 6];
          const payloads = sizesToSeed
            .map((sz) => ({
              tournament_id: newId,
              pool_size: sz,
              template_data: defaultTemplateForPoolSize(sz),
            }))
            .filter((p) => Array.isArray(p.template_data) && p.template_data.length > 0);

          if (payloads.length > 0) {
            await Promise.all(
              payloads.map((p) =>
                supabase.from('schedule_templates').upsert(p, { onConflict: 'tournament_id,pool_size' })
              )
            );
          }
        } catch (seedErr) {
          // Non-blocking: seeding failure will be handled again in prerequisites
          console.warn('Default schedule template seeding failed:', seedErr);
        }
      }
    }
    await tournamentListRef.value?.loadTournaments();
    const list = tournamentListRef.value?.getTournaments() ?? [];
    if (selectedId.value) {
      const t = list.find((x: Tournament) => x.id === selectedId.value) || null;
      toForm(t);
    }
  } catch (err: any) {
    const hint = [err?.code, err?.details, err?.hint].filter(Boolean).join(' — ');
    const detail = hint ? `${err?.message ?? 'Unknown error'} (${hint})` : (err?.message ?? 'Unknown error');
    toast.add({ severity: 'error', summary: 'Save failed', detail, life: 6000 });
    console.error('[AdminTournamentSetup] saveTournament', err);
  } finally {
    saving.value = false;
  }
}

async function executeDeleteTournament(id: string) {
  saving.value = true;
  try {
    const { error } = await supabase.from('tournaments').delete().eq('id', id);
    if (error) throw error;
    toast.add({ severity: 'success', summary: 'Tournament deleted', life: 1500 });
    if (session.getAdminActiveTournamentId() === id) {
      session.clearAdminActiveTournament({ clearPublicAccessCode: true });
    }
    if (selectedId.value === id) {
      selectedId.value = null;
      toForm(null);
    }
    await tournamentListRef.value?.loadTournaments();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Delete failed', detail: err?.message ?? 'Unknown error', life: 3500 });
  } finally {
    saving.value = false;
  }
}

function onTournamentListReady() {
  const editId = typeof route.query.edit === 'string' ? route.query.edit : '';
  if (!editId) return;
  const list = tournamentListRef.value?.getTournaments() ?? [];
  const t = list.find((x: Tournament) => x.id === editId);
  if (t) selectTournament(t);
  router.replace({ path: route.path, query: {} });
}

onMounted(async () => {
  await session.refreshAdminUser();
});
</script>

<template>
  <div class="admin-tool-page -mx-4 min-h-dvh bg-[#0b1120] px-4 py-8 text-slate-100">
    <div class="mx-auto max-w-6xl">
    <UiSectionHeading
      variant="dashboard"
      title="Tournament Setup"
      subtitle="Create and edit tournaments, rules, and status."
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

    <div class="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-5">
      <!-- Left: Tournaments list (wider column for readability) -->
      <div class="sm:col-span-2">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-lg font-semibold text-white">Tournaments</h3>
          <Button
            label="New"
            icon="pi pi-plus"
            :class="adminBtnBluePillClass"
            :pt="adminBtnPillPt"
            @click="newTournament"
          />
        </div>

        <div class="mt-3">
          <AdminTournamentListPanel
            ref="tournamentListRef"
            variant="setup"
            @edit="selectTournament"
            @ready="onTournamentListReady"
          />
        </div>
      </div>

      <!-- Right: Editor -->
      <div class="sm:col-span-3">
        <!-- Basics -->
        <div class="rounded-xl border border-slate-600/45 bg-slate-800/50 p-4 shadow-lg shadow-black/20">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="mb-2 block text-sm font-medium text-slate-300">Name</label>
              <InputText v-model="form.name" class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900" placeholder="e.g. Fall Classic 2025" />
            </div>
            <div>
              <label class="mb-2 block text-sm font-medium text-slate-300">Date (YYYY-MM-DD)</label>
              <InputText v-model="form.date" class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900" placeholder="2025-10-12" />
            </div>
            <div>
              <label class="mb-2 block text-sm font-medium text-slate-300">Access Code</label>
              <InputText v-model="form.access_code" class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900" placeholder="GOJACKETS2025" />
            </div>
            <div>
              <label class="mb-2 block text-sm font-medium text-slate-300">Status</label>
              <Dropdown
                v-model="form.status"
                :options="statusOptions"
                optionLabel="label"
                optionValue="value"
                class="w-full !rounded-xl"
                :pt="{ input: { class: '!py-3 !px-4 !text-base !rounded-xl' } }"
              />
            </div>
          </div>
        </div>

        <!-- Rules -->
        <div class="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <!-- Advancement Rules -->
          <div class="rounded-xl border border-slate-600/45 bg-slate-800/50 p-4 shadow-lg shadow-black/20">
            <div class="text-sm font-semibold text-white">Advancement Rules</div>

            <div class="mt-3 space-y-3">
              <div class="rounded-lg border border-slate-600/40 bg-slate-900/30 p-3">
                <div class="text-sm font-medium text-slate-200">Advancers per Pool Size</div>
                <div class="mt-2 grid grid-cols-1 gap-3">
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-sm text-slate-300">3 teams</div>
                    <Dropdown
                      :options="[0,1,2,3]"
                      :modelValue="getAdvanceCount(3)"
                      @update:modelValue="(v:any) => setAdvanceCount(3, v)"
                      class="!rounded-xl w-32"
                      :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                    />
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-sm text-slate-300">4 teams</div>
                    <Dropdown
                      :options="[0,1,2,3,4]"
                      :modelValue="getAdvanceCount(4)"
                      @update:modelValue="(v:any) => setAdvanceCount(4, v)"
                      class="!rounded-xl w-32"
                      :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                    />
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-sm text-slate-300">5 teams</div>
                    <Dropdown
                      :options="[0,1,2,3,4,5]"
                      :modelValue="getAdvanceCount(5)"
                      @update:modelValue="(v:any) => setAdvanceCount(5, v)"
                      class="!rounded-xl w-32"
                      :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                    />
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-sm text-slate-300">6 teams</div>
                    <Dropdown
                      :options="[0,1,2,3,4,5,6]"
                      :modelValue="getAdvanceCount(6)"
                      @update:modelValue="(v:any) => setAdvanceCount(6, v)"
                      class="!rounded-xl w-32"
                      :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                    />
                  </div>
                </div>
              </div>

              <div class="rounded-lg border border-slate-600/40 bg-slate-900/30 p-3">
                <div class="text-sm font-medium text-slate-200">Bracket Format</div>
                <Dropdown
                  v-model="form.advancement_rules.bracketFormat"
                  :options="[
                    { label: 'Single Elimination', value: 'single_elimination' },
                    { label: 'Best-of-3 Single Elim (Finals)', value: 'best_of_3_single_elim' }
                  ]"
                  optionLabel="label"
                  optionValue="value"
                  class="w-full !rounded-xl mt-2"
                  :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                />
              </div>

              <div class="rounded-lg border border-slate-600/40 bg-slate-900/30 p-3">
                <div class="text-sm font-medium text-slate-200">Tiebreakers (reorder with arrows)</div>
                <ul class="mt-2 space-y-2">
                  <li
                    v-for="(tb, idx) in (form.advancement_rules.tiebreakers || [])"
                    :key="tb"
                    class="flex items-center justify-between rounded-md border border-slate-600/40 bg-slate-900/30 p-2"
                  >
                    <div class="text-sm capitalize text-slate-200">
                      {{ formatTb(tb as any) }}
                    </div>
                    <div class="flex items-center gap-1">
                      <Button icon="pi pi-arrow-up" text rounded @click="moveTiebreaker(idx, -1)" />
                      <Button icon="pi pi-arrow-down" text rounded @click="moveTiebreaker(idx, 1)" />
                    </div>
                  </li>
                </ul>
                <div class="mt-3 flex flex-wrap gap-2">
                  <Button
                    v-for="opt in tiebreakerOptions"
                    :key="opt"
                    :label="(((form.advancement_rules.tiebreakers || []) as any[]).includes(opt) ? 'Remove ' : 'Add ') + formatTb(opt as any)"
                    size="small"
                    :severity="((form.advancement_rules.tiebreakers || []) as any[]).includes(opt) ? 'danger' : 'secondary'"
                    outlined
                    class="!rounded-xl"
                    @click="toggleTiebreaker(opt)"
                  />
                </div>
              </div>
            </div>
          </div>

          <!-- Game Rules -->
          <div class="rounded-xl border border-slate-600/45 bg-slate-800/50 p-4 shadow-lg shadow-black/20">
            <div class="text-sm font-semibold text-white">Game Rules</div>

            <div class="mt-3 grid grid-cols-1 gap-4">
              <div class="rounded-lg border border-slate-600/40 bg-slate-900/30 p-3">
                <div class="text-sm font-semibold text-white">Pool Play</div>
                <div class="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs text-slate-300 mb-1">Set Target</label>
                    <InputNumber v-model="form.game_rules.pool!.setTarget" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                  </div>
                  <div>
                    <label class="block text-xs text-slate-300 mb-1">Cap</label>
                    <InputNumber v-model="form.game_rules.pool!.cap" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                  </div>
                  <div class="col-span-2 rounded-lg border border-slate-600/40 bg-slate-900/30 p-3">
                    <div class="text-xs font-semibold text-slate-200">Set Target by Pool Size</div>
                    <div class="mt-2 grid grid-cols-2 gap-3">
                      <div>
                        <label class="block text-xs text-slate-300 mb-1">3 teams</label>
                        <InputNumber v-model="form.game_rules.pool!.setTargetByPoolSize!['3']" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                      </div>
                      <div>
                        <label class="block text-xs text-slate-300 mb-1">4 teams</label>
                        <InputNumber v-model="form.game_rules.pool!.setTargetByPoolSize!['4']" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                      </div>
                      <div>
                        <label class="block text-xs text-slate-300 mb-1">5 teams</label>
                        <InputNumber v-model="form.game_rules.pool!.setTargetByPoolSize!['5']" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                      </div>
                      <div>
                        <label class="block text-xs text-slate-300 mb-1">6 teams</label>
                        <InputNumber v-model="form.game_rules.pool!.setTargetByPoolSize!['6']" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                      </div>
                    </div>
                    <div class="mt-2 text-xs text-slate-400">
                      Overrides the Pool Play Set Target for matches in pools of that size.
                    </div>
                  </div>
                  <div>
                    <label class="block text-xs text-slate-300 mb-1">Best Of</label>
                    <Dropdown
                      v-model="form.game_rules.pool!.bestOf"
                      :options="[1,3]"
                      class="w-full !rounded-xl"
                      :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                    />
                  </div>
                  <div class="flex items-end">
                    <div class="flex items-center gap-2">
                      <span class="text-sm text-slate-300">Win by 2</span>
                      <ToggleButton v-model="form.game_rules.pool!.winBy2" onLabel="Yes" offLabel="No" />
                    </div>
                  </div>
                </div>
              </div>

              <div class="rounded-lg border border-slate-600/40 bg-slate-900/30 p-3">
                <div class="text-sm font-semibold text-white">Bracket</div>
                <div class="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs text-slate-300 mb-1">Set Target</label>
                    <InputNumber v-model="form.game_rules.bracket!.setTarget" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                  </div>
                  <div>
                    <label class="block text-xs text-slate-300 mb-1">Cap</label>
                    <InputNumber v-model="form.game_rules.bracket!.cap" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                  </div>
                  <div>
                    <label class="block text-xs text-slate-300 mb-1">Best Of</label>
                    <Dropdown
                      v-model="form.game_rules.bracket!.bestOf"
                      :options="[1,3]"
                      class="w-full !rounded-xl"
                      :pt="{ input: { class: '!py-2 !px-3 !text-sm !rounded-xl' } }"
                    />
                  </div>
                  <div class="flex items-end">
                    <div class="flex items-center gap-2">
                      <span class="text-sm text-slate-300">Win by 2</span>
                      <ToggleButton v-model="form.game_rules.bracket!.winBy2" onLabel="Yes" offLabel="No" />
                    </div>
                  </div>
                  <div v-if="form.game_rules.bracket!.bestOf === 3">
                    <label class="block text-xs text-slate-300 mb-1">Third Set Target</label>
                    <InputNumber v-model="form.game_rules.bracket!.thirdSetTarget" :min="1" class="w-full" :pt="{ input: { class: '!w-full !py-2 !px-3 !rounded-xl' } }" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Bracket flags -->
        <div class="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div class="rounded-xl border border-slate-600/45 bg-slate-800/50 p-4 shadow-lg shadow-black/20">
            <div class="text-sm text-slate-200">Bracket Started</div>
            <div class="mt-1 font-semibold text-white">{{ form.bracket_started ? 'Yes' : 'No' }}</div>
            <div class="mt-2 text-xs text-slate-300">Generated at: {{ form.bracket_generated_at || '—' }}</div>
            <div class="mt-2 text-xs text-slate-300">Note: This is managed by the bracket engine.</div>
          </div>
        </div>

        <!-- Actions -->
        <div class="mt-6 flex items-center gap-3">
          <Button
            :loading="saving"
            label="Save"
            icon="pi pi-save"
            :class="adminBtnBluePillClass"
            :pt="adminBtnPillPt"
            @click="saveTournament"
          />
          <Button
            v-if="form.id"
            :loading="saving"
            label="Delete"
            icon="pi pi-trash"
            severity="danger"
            :class="adminBtnDangerPillClass"
            :pt="adminBtnPillPt"
            @click="requestDeleteCurrentForm"
          />
        </div>
      </div>
    </div>
    </div>
  </div>
</template>
