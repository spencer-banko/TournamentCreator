<script setup lang="ts">
/**
 * Admin editor for a single pool or bracket match: who plays (and refs), court/round,
 * format (1 set or best of 3), and per-set scores. Bracket results advance the winner;
 * clearing a bracket result pulls the winner back out of the next round.
 */
import { ref, computed, watch } from 'vue';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import { useToast } from 'primevue/usetoast';
import supabase from '../../lib/supabase';
import type { Match, SetScore } from '../../types/db';
import { formatFromMatch, matchResult, validateMatch, targetForSet, formatLabel } from '../../lib/scoring';
import { advanceWinnerToNextById, clearBracketResult } from '../../lib/bracket';

type TeamOpt = { id: string; full_team_name: string; pool_id?: string | null };

const props = defineProps<{
  visible: boolean;
  match: Match | null;
  teams: TeamOpt[];
  /** Optional heading context, e.g. "Pool A · Round 3" or "Gold · Semifinals". */
  context?: string;
}>();
const emit = defineEmits<{ (e: 'update:visible', v: boolean): void; (e: 'saved'): void }>();

const toast = useToast();
const saving = ref(false);

const team1 = ref<string | null>(null);
const team2 = ref<string | null>(null);
const refTeam = ref<string | null>(null);
const round = ref<number | null>(null);
const court = ref('');
const bestOf = ref<1 | 3>(1);
const targets = ref<number[]>([21]);
const sets = ref<Array<{ t1: string; t2: string }>>([]);

const isBracket = computed(() => props.match?.match_type === 'bracket');

watch(
  () => [props.visible, props.match?.id],
  () => {
    const m = props.match;
    if (!m || !props.visible) return;
    team1.value = m.team1_id;
    team2.value = m.team2_id;
    refTeam.value = m.ref_team_id;
    round.value = m.round_number;
    court.value = m.court ?? '';
    const f = formatFromMatch(m);
    bestOf.value = f.bestOf === 3 ? 3 : 1;
    targets.value = f.bestOf === 3 ? [...f.setTargets, 21, 21, 15].slice(0, 3) : [f.setTargets[0] ?? 21];
    const existing: SetScore[] =
      Array.isArray(m.set_scores) && m.set_scores.length && f.bestOf > 1
        ? m.set_scores
        : m.team1_score != null && m.team2_score != null && f.bestOf === 1
          ? [{ t1: m.team1_score, t2: m.team2_score }]
          : [];
    sets.value = existing.map((s) => ({ t1: String(s.t1), t2: String(s.t2) }));
    ensureSetRows();
  },
  { immediate: true }
);

watch(bestOf, (v) => {
  if (v === 3 && targets.value.length < 3) targets.value = [targets.value[0] ?? 21, targets.value[0] ?? 21, 15];
  if (v === 1) targets.value = [targets.value[0] ?? 21];
  ensureSetRows();
});

const teamOptions = computed(() => [
  { label: '— TBD —', value: null as string | null },
  ...props.teams
    .slice()
    .sort((a, b) => a.full_team_name.localeCompare(b.full_team_name))
    .map((t) => ({ label: t.full_team_name, value: t.id as string | null })),
]);

function parsedSets(): SetScore[] {
  return sets.value
    .filter((s) => s.t1.trim() !== '' || s.t2.trim() !== '')
    .map((s) => ({ t1: Number(s.t1), t2: Number(s.t2) }));
}

const result = computed(() => matchResult(parsedSets(), bestOf.value));

/** Show one row for 1 set; for best of 3 show 2 rows, plus a 3rd only at 1-1. */
function ensureSetRows() {
  const want = bestOf.value === 1 ? 1 : Math.max(2, matchResult(parsedSets(), 3).setsNeeded);
  while (sets.value.length < want) sets.value.push({ t1: '', t2: '' });
  while (sets.value.length > want && sets.value[sets.value.length - 1].t1 === '' && sets.value[sets.value.length - 1].t2 === '') sets.value.pop();
}
watch(sets, ensureSetRows, { deep: true });

const hasScores = computed(() => parsedSets().length > 0);
const errors = computed(() => {
  if (!hasScores.value) return [];
  return validateMatch(parsedSets(), { bestOf: bestOf.value, setTargets: targets.value, cap: null, winBy2: true });
});
const sameTeam = computed(() => !!team1.value && team1.value === team2.value);

function nameOf(id: string | null) {
  return props.teams.find((t) => t.id === id)?.full_team_name ?? 'TBD';
}

function swapSides() {
  [team1.value, team2.value] = [team2.value, team1.value];
  sets.value = sets.value.map((s) => ({ t1: s.t2, t2: s.t1 }));
}

function close() {
  emit('update:visible', false);
}

async function save() {
  const m = props.match;
  if (!m) return;
  if (sameTeam.value) {
    toast.add({ severity: 'warn', summary: 'Pick two different teams', life: 2500 });
    return;
  }
  if (hasScores.value && errors.value.length) {
    toast.add({ severity: 'warn', summary: 'Check the score', detail: errors.value[0], life: 3500 });
    return;
  }
  if (hasScores.value && (!team1.value || !team2.value)) {
    toast.add({ severity: 'warn', summary: 'Both teams are needed to record a score', life: 2500 });
    return;
  }
  saving.value = true;
  try {
    const ps = parsedSets();
    const r = matchResult(ps, bestOf.value);
    const scored = hasScores.value && r.complete;
    const payload: Record<string, unknown> = {
      team1_id: team1.value,
      team2_id: team2.value,
      court: court.value.trim() || null,
      best_of: bestOf.value,
      set_targets: targets.value,
    };
    if (!isBracket.value) {
      payload.ref_team_id = refTeam.value;
      payload.round_number = round.value;
    }
    const teamsChanged = team1.value !== m.team1_id || team2.value !== m.team2_id;
    if (scored) {
      const used = ps.slice(0, r.setsWon1 + r.setsWon2);
      Object.assign(payload, {
        set_scores: bestOf.value > 1 ? used : null,
        team1_score: bestOf.value > 1 ? r.setsWon1 : used[0].t1,
        team2_score: bestOf.value > 1 ? r.setsWon2 : used[0].t2,
        winner_id: r.winner === 1 ? team1.value : team2.value,
        is_live: false,
        live_score_team1: null,
        live_score_team2: null,
      });
    } else if (m.team1_score != null || m.winner_id || teamsChanged) {
      // Scores removed (or the matchup changed without a new score): clear the old result.
      if (isBracket.value && m.winner_id) {
        const res = await clearBracketResult(m.tournament_id, m.id);
        if (res.error) {
          toast.add({ severity: 'warn', summary: 'Could not clear result', detail: res.error, life: 4000 });
          return;
        }
      }
      // A bye keeps its automatic winner when only one team is set.
      const bye = isBracket.value && !!team1.value !== !!team2.value;
      Object.assign(payload, {
        set_scores: null,
        team1_score: null,
        team2_score: null,
        winner_id: bye ? team1.value ?? team2.value : null,
      });
    }

    const { error } = await supabase.from('matches').update(payload).eq('id', m.id);
    if (error) throw error;

    if (isBracket.value && (payload.winner_id as string | null)) {
      const adv = await advanceWinnerToNextById(m.tournament_id, m.id);
      if (adv.error && !/final|No next/i.test(adv.error)) {
        toast.add({ severity: 'warn', summary: 'Saved, but the winner was not moved forward', detail: adv.error, life: 4500 });
      }
    }
    toast.add({ severity: 'success', summary: 'Match updated', life: 1800 });
    emit('saved');
    close();
  } catch (e: any) {
    toast.add({ severity: 'error', summary: 'Save failed', detail: e?.message ?? String(e), life: 3500 });
  } finally {
    saving.value = false;
  }
}

async function clearScore() {
  sets.value = [];
  ensureSetRows();
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :draggable="false"
    :dismissableMask="true"
    :header="isBracket ? 'Edit bracket match' : 'Edit pool match'"
    :style="{ width: 'min(36rem, calc(100vw - 2rem))' }"
    :pt="{
      root: { class: '!rounded-2xl !border !border-tone-600/60 !bg-tone-900 !text-ink !shadow-2xl' },
      header: { class: '!bg-transparent !text-ink !px-6 !pt-5 !pb-2' },
      content: { class: '!bg-transparent !px-6 !pb-2' },
      footer: { class: '!bg-transparent !px-6 !pb-5 !pt-3' },
    }"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <div v-if="match" class="grid gap-5">
      <div v-if="context" class="-mt-1 text-sm font-medium text-tone-400">{{ context }}</div>

      <!-- Teams -->
      <section class="grid gap-3">
        <div class="grid grid-cols-[1fr_auto] items-end gap-2">
          <label class="grid gap-1.5">
            <span class="text-xs font-semibold uppercase tracking-wide text-tone-400">Team 1</span>
            <Select v-model="team1" :options="teamOptions" optionLabel="label" optionValue="value" filter class="w-full" placeholder="TBD" />
          </label>
          <Button
            icon="pi pi-arrow-right-arrow-left"
            text
            rounded
            aria-label="Swap teams"
            title="Swap teams"
            class="!mb-0.5 !rotate-90 !text-tone-300 hover:!text-amber-300"
            @click="swapSides"
          />
        </div>
        <label class="grid gap-1.5 pr-12">
          <span class="text-xs font-semibold uppercase tracking-wide text-tone-400">Team 2</span>
          <Select v-model="team2" :options="teamOptions" optionLabel="label" optionValue="value" filter class="w-full" placeholder="TBD" />
        </label>
        <p v-if="sameTeam" class="text-sm font-medium text-red-300">Team 1 and Team 2 must be different.</p>
      </section>

      <!-- Logistics -->
      <section class="grid grid-cols-2 gap-3" :class="isBracket ? '' : 'sm:grid-cols-3'">
        <label v-if="!isBracket" class="col-span-2 grid gap-1.5 sm:col-span-1">
          <span class="text-xs font-semibold uppercase tracking-wide text-tone-400">Ref</span>
          <Select v-model="refTeam" :options="teamOptions" optionLabel="label" optionValue="value" filter class="w-full" placeholder="None" />
        </label>
        <label v-if="!isBracket" class="grid gap-1.5">
          <span class="text-xs font-semibold uppercase tracking-wide text-tone-400">Order</span>
          <InputText :modelValue="round == null ? '' : String(round)" type="number" min="1" class="w-full" @update:modelValue="(v) => (round = v ? Number(v) : null)" />
        </label>
        <label class="grid gap-1.5">
          <span class="text-xs font-semibold uppercase tracking-wide text-tone-400">Court</span>
          <InputText v-model="court" placeholder="e.g. 3" class="w-full" />
        </label>
      </section>

      <!-- Format -->
      <section class="grid gap-2">
        <span class="text-xs font-semibold uppercase tracking-wide text-tone-400">Format</span>
        <div class="flex flex-wrap items-center gap-2">
          <div class="inline-flex rounded-full border border-tone-600/70 bg-tone-800/60 p-1" role="radiogroup" aria-label="Match format">
            <button
              v-for="opt in [1, 3]"
              :key="opt"
              type="button"
              role="radio"
              :aria-checked="bestOf === opt"
              class="rounded-full px-4 py-1.5 text-sm font-semibold transition"
              :class="bestOf === opt ? 'bg-amber-500 text-white shadow' : 'text-tone-300 hover:text-ink'"
              @click="bestOf = opt as 1 | 3"
            >
              {{ opt === 1 ? '1 set' : 'Best of 3' }}
            </button>
          </div>
          <div class="flex items-center gap-1.5 text-sm text-tone-300">
            <span>to</span>
            <input
              v-for="(_, i) in targets"
              :key="i"
              v-model.number="targets[i]"
              type="number"
              min="1"
              :aria-label="`Set ${i + 1} target`"
              class="w-14 rounded-lg border border-tone-600/70 bg-paper px-2 py-1 text-center text-sm font-semibold text-slate-900"
            />
          </div>
        </div>
      </section>

      <!-- Score -->
      <section class="grid gap-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold uppercase tracking-wide text-tone-400">Score</span>
          <button v-if="hasScores" type="button" class="text-xs font-semibold text-amber-300 hover:underline" @click="clearScore">Clear score</button>
        </div>
        <div class="overflow-hidden rounded-xl border border-tone-600/60">
          <div class="grid grid-cols-[1fr_repeat(var(--cols),3.5rem)] items-center gap-x-2 bg-tone-800/70 px-3 py-2 text-xs font-semibold text-tone-400" :style="{ '--cols': sets.length }">
            <span>Team</span>
            <span v-for="(_, i) in sets" :key="i" class="text-center">{{ bestOf > 1 ? `Set ${i + 1}` : 'Pts' }}<span class="block font-normal text-tone-500">to {{ targetForSet({ bestOf, setTargets: targets }, i + 1) }}</span></span>
          </div>
          <div
            v-for="side in [1, 2] as const"
            :key="side"
            class="grid grid-cols-[1fr_repeat(var(--cols),3.5rem)] items-center gap-x-2 border-t border-tone-600/40 px-3 py-2"
            :style="{ '--cols': sets.length }"
          >
            <span class="truncate text-sm font-semibold" :class="result.winner === side ? 'text-emerald-300' : 'text-ink'">
              {{ nameOf(side === 1 ? team1 : team2) }}
              <span v-if="result.winner === side" class="ml-1 text-[10px] font-bold uppercase tracking-wide">Won</span>
            </span>
            <input
              v-for="(s, i) in sets"
              :key="i"
              v-model="s[side === 1 ? 't1' : 't2']"
              inputmode="numeric"
              :aria-label="`${nameOf(side === 1 ? team1 : team2)} set ${i + 1}`"
              class="w-full rounded-lg border border-tone-600/70 bg-paper px-1 py-1.5 text-center text-base font-bold tabular-nums text-slate-900"
            />
          </div>
        </div>
        <ul v-if="errors.length" class="grid gap-1 text-sm text-red-300">
          <li v-for="e in errors" :key="e">{{ e }}</li>
        </ul>
        <p v-else-if="hasScores && result.complete" class="text-sm text-tone-300">
          {{ nameOf(result.winner === 1 ? team1 : team2) }} win{{ bestOf > 1 ? ` ${Math.max(result.setsWon1, result.setsWon2)}–${Math.min(result.setsWon1, result.setsWon2)}` : '' }}.
          <span v-if="isBracket">They'll move to the next round.</span>
        </p>
        <p v-else class="text-xs text-tone-500">{{ formatLabel({ bestOf, setTargets: targets }) }}. Leave blank to keep the match unplayed.</p>
      </section>
    </div>

    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <Button label="Cancel" text class="!text-tone-300" @click="close" />
        <Button label="Save match" icon="pi pi-check" :loading="saving" class="!rounded-full !border-none !bg-amber-500 !px-5 !text-white" @click="save" />
      </div>
    </template>
  </Dialog>
</template>
