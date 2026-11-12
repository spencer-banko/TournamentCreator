<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import { useSessionStore } from '../stores/session';
import InputText from 'primevue/inputtext';
import Dropdown from 'primevue/dropdown';
import Button from 'primevue/button';
import supabase from '../lib/supabase';
import { deleteTournamentConfirmOptions } from '../lib/deleteTournamentConfirm';
import { defaultTemplateForPoolSize } from '../lib/defaultTemplates';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import AdminTournamentListPanel from '@/components/admin/AdminTournamentListPanel.vue';
import BracketsEditor from '@/components/admin/BracketsEditor.vue';
import FormatPicker from '@/components/admin/FormatPicker.vue';
import {
  adminBtnPillPt,
  adminBtnBluePillClass,
  adminBtnDangerPillClass,
} from '@/lib/adminButtonStyles';
import type { Tournament, TournamentStatus, AdvancementRules, GameRules, MatchFormat } from '../types/db';

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
const bracketsRef = ref<InstanceType<typeof BracketsEditor> | null>(null);
const POOL_SIZES = [3, 4, 5, 6] as const;

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
  tiebreakers: ['point_diff', 'head_to_head', 'set_ratio'],
};

const DEFAULT_GAME_RULES: GameRules = {
  pool: {
    setTarget: 21,
    cap: 99,
    bestOf: 1,
    winBy2: true,
    setTargetByPoolSize: { '3': 21, '4': 21, '5': 21, '6': 21 },
    formatBySize: {
      '3': { bestOf: 1, setTargets: [21], cap: null, winBy2: true },
      '4': { bestOf: 1, setTargets: [21], cap: null, winBy2: true },
      '5': { bestOf: 1, setTargets: [21], cap: null, winBy2: true },
      '6': { bestOf: 1, setTargets: [21], cap: null, winBy2: true },
    },
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
      formatBySize: Object.fromEntries(
        POOL_SIZES.map((sz) => {
          const k = String(sz);
          const f = (r.pool as any)?.formatBySize?.[k] as MatchFormat | undefined;
          const legacyTarget = mergedOverrides[k] ?? r.pool?.setTarget ?? 21;
          return [k, f ? { bestOf: f.bestOf === 3 ? 3 : 1, setTargets: f.setTargets?.length ? f.setTargets : [legacyTarget], cap: f.cap ?? null, winBy2: f.winBy2 !== false }
                       : { bestOf: 1, setTargets: [legacyTarget], cap: null, winBy2: true }];
        })
      ),
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
  confirm.require(
    deleteTournamentConfirmOptions(name, () => {
      void executeDeleteTournament(form.value.id!);
    })
  );
}

// Helpers — pool formats
function poolFormat(sz: number): MatchFormat {
  return (form.value.game_rules.pool?.formatBySize?.[String(sz)] as MatchFormat) ?? { bestOf: 1, setTargets: [21], cap: null, winBy2: true };
}
function setPoolFormat(sz: number, f: MatchFormat) {
  const pool = (form.value.game_rules.pool ??= {});
  pool.formatBySize = { ...(pool.formatBySize ?? {}), [String(sz)]: f };
  // keep legacy single-target field in sync for older readers
  pool.setTargetByPoolSize = { ...(pool.setTargetByPoolSize ?? {}), [String(sz)]: f.setTargets[0] ?? 21 };
}
function poolMatchesPerTeam(sz: number): string {
  if (sz === 6) return 'each team plays 4 of 5';
  if (sz === 3) return poolFormat(3).bestOf === 3 ? 'each pair meets once' : 'each pair meets twice';
  return 'round robin';
}

/**
 * If the 3-team format switched between 1 set and best of 3 and the stored schedule is still
 * the untouched default for the old format, swap in the default for the new one.
 */
async function syncDefaultTemplates(tournamentId: string) {
  for (const sz of POOL_SIZES) {
    const bestOf = poolFormat(sz).bestOf;
    const other = bestOf === 3 ? 1 : 3;
    const oldDefault = JSON.stringify(defaultTemplateForPoolSize(sz, other));
    const newDefault = defaultTemplateForPoolSize(sz, bestOf);
    if (oldDefault === JSON.stringify(newDefault)) continue;
    const { data } = await supabase.from('schedule_templates').select('id,template_data').eq('tournament_id', tournamentId).eq('pool_size', sz).maybeSingle();
    if (data && JSON.stringify((data as any).template_data) === oldDefault) {
      await supabase.from('schedule_templates').update({ template_data: newDefault }).eq('id', (data as any).id);
    }
  }
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
  const bracketErrors = bracketsRef.value?.errors ?? [];
  if (bracketErrors.length) throw new Error(bracketErrors[0]);

  // Game rules sanity
  const gr = form.value.game_rules;
  const phases: Array<keyof GameRules> = ['pool'];
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
      await bracketsRef.value?.save(form.value.id);
      await syncDefaultTemplates(form.value.id);
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
        try {
          await bracketsRef.value?.save(newId);
        } catch (bErr: any) {
          toast.add({ severity: 'warn', summary: 'Brackets not saved', detail: bErr?.message ?? String(bErr), life: 5000 });
        }
        selectedId.value = newId;

        // Auto-seed default schedule templates for supported pool sizes if missing
        try {
          const sizesToSeed = [3, 4, 5, 6];
          const payloads = sizesToSeed
            .map((sz) => ({
              tournament_id: newId,
              pool_size: sz,
              template_data: defaultTemplateForPoolSize(sz, poolFormat(sz).bestOf),
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
  <div class="admin-tool-page -mx-4 min-h-dvh gbv-page-bg px-4 py-8 text-tone-100">
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
        class="!rounded-xl !border-tone-600/70 !text-tone-200 hover:!border-amber-500/35 hover:!bg-tone-800/80 hover:!text-amber-100"
        @click="router.push({ name: 'admin-dashboard' })"
      />
    </UiSectionHeading>

    <div class="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-5">
      <!-- Left: Tournaments list (wider column for readability) -->
      <div class="sm:col-span-2">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-lg font-semibold text-ink">Tournaments</h3>
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
        <div class="rounded-xl border border-tone-600/45 bg-tone-800/50 p-4 shadow-lg shadow-black/20">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label class="mb-2 block text-sm font-medium text-tone-300">Name</label>
              <InputText v-model="form.name" class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900" placeholder="e.g. Fall Classic 2025" />
            </div>
            <div>
              <label class="mb-2 block text-sm font-medium text-tone-300">Date (YYYY-MM-DD)</label>
              <InputText v-model="form.date" class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900" placeholder="2025-10-12" />
            </div>
            <div>
              <label class="mb-2 block text-sm font-medium text-tone-300">Access Code</label>
              <InputText v-model="form.access_code" class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900" placeholder="GOJACKETS2025" />
            </div>
            <div>
              <label class="mb-2 block text-sm font-medium text-tone-300">Status</label>
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

        <!-- Pool formats -->
        <section class="mt-6 rounded-xl border border-tone-600/45 bg-tone-800/50 p-4 shadow-lg shadow-black/10">
          <h3 class="text-sm font-semibold text-ink">Pool play format</h3>
          <p class="mt-0.5 text-xs text-tone-400">How each pool match is played, by pool size. Applied when the pool schedule is generated.</p>
          <div class="mt-3 grid gap-2">
            <div
              v-for="sz in POOL_SIZES"
              :key="sz"
              class="grid grid-cols-1 items-center gap-2 rounded-lg border border-tone-600/40 bg-tone-900/30 px-3 py-2 sm:grid-cols-[8.5rem_1fr]"
            >
              <div>
                <div class="text-sm font-semibold text-tone-100">{{ sz }}-team pools</div>
                <div class="text-[11px] text-tone-400">{{ poolMatchesPerTeam(sz) }}</div>
              </div>
              <FormatPicker :modelValue="poolFormat(sz)" :label="`${sz}-team pool`" show-cap @update:modelValue="(f) => setPoolFormat(sz, f)" />
            </div>
          </div>
        </section>

        <!-- Brackets -->
        <div class="mt-6">
          <BracketsEditor ref="bracketsRef" :tournament-id="form.id" />
        </div>

        <!-- Tiebreakers -->
        <section class="mt-6 rounded-xl border border-tone-600/45 bg-tone-800/50 p-4 shadow-lg shadow-black/10">
          <h3 class="text-sm font-semibold text-ink">Pool standings tiebreakers</h3>
          <p class="mt-0.5 text-xs text-tone-400">Teams are ranked in their pool by wins first, then these in order.</p>
          <ul class="mt-3 space-y-2">
            <li
              v-for="(tb, idx) in (form.advancement_rules.tiebreakers || [])"
              :key="tb"
              class="flex items-center justify-between rounded-md border border-tone-600/40 bg-tone-900/30 px-3 py-1.5"
            >
              <div class="text-sm capitalize text-tone-200"><span class="mr-2 text-tone-500">{{ idx + 1 }}.</span>{{ formatTb(tb as any) }}</div>
              <div class="flex items-center gap-1">
                <Button icon="pi pi-arrow-up" text rounded size="small" aria-label="Move up" :disabled="idx === 0" @click="moveTiebreaker(idx, -1)" />
                <Button icon="pi pi-arrow-down" text rounded size="small" aria-label="Move down" :disabled="idx === (form.advancement_rules.tiebreakers || []).length - 1" @click="moveTiebreaker(idx, 1)" />
                <Button icon="pi pi-times" text rounded size="small" severity="danger" :aria-label="`Remove ${formatTb(tb as any)}`" @click="toggleTiebreaker(tb as any)" />
              </div>
            </li>
          </ul>
          <div class="mt-2 flex flex-wrap gap-2">
            <button
              v-for="opt in tiebreakerOptions.filter((o) => o !== 'random' && !((form.advancement_rules.tiebreakers || []) as string[]).includes(o))"
              :key="opt"
              type="button"
              class="rounded-full border border-dashed border-tone-600/70 px-3 py-1 text-xs font-semibold capitalize text-tone-300 hover:border-amber-500/60 hover:text-ink"
              @click="toggleTiebreaker(opt)"
            >
              + {{ formatTb(opt) }}
            </button>
          </div>
        </section>

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
