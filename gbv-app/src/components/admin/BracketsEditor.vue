<script setup lang="ts">
/**
 * Tournament Setup section: define the brackets (Gold / Silver / Bronze ...), which pool
 * finishing places feed each one, and the match format for each round.
 * Edits are kept locally and written by save(), which the setup page calls after saving the tournament.
 */
import { ref, watch, computed } from 'vue';
import Button from 'primevue/button';
import supabase from '../../lib/supabase';
import FormatPicker from './FormatPicker.vue';
import type { Bracket, BracketRoundFormat, MatchFormat } from '../../types/db';
import { defaultRoundFormats } from '../../lib/bracket';
import { medalFor, placesLabel } from '../../lib/bracketStyle';
import { DEFAULT_SINGLE_SET } from '../../lib/scoring';

type Draft = { id: string | null; name: string; places: number[]; round_formats: BracketRoundFormat[]; hasMatches: boolean };

const props = defineProps<{ tournamentId: string | null }>();

const drafts = ref<Draft[]>([]);
const removed = ref<Draft[]>([]);
const loading = ref(false);
const openFormats = ref<Record<number, boolean>>({});

const ROUND_ROWS = [
  { fromEnd: 1, label: 'Final' },
  { fromEnd: 2, label: 'Semifinals' },
  { fromEnd: 3, label: 'Quarterfinals' },
  { fromEnd: 4, label: 'Round of 16' },
  { fromEnd: 5, label: 'Round of 32' },
];
const PLACES = [1, 2, 3, 4, 5, 6];

const PRESETS: Array<{ key: string; label: string; hint: string; brackets: Array<{ name: string; places: number[] }> }> = [
  { key: 'gsb', label: 'Gold / Silver / Bronze', hint: 'Top 2, middle 2, bottom 2 of each pool', brackets: [{ name: 'Gold', places: [1, 2] }, { name: 'Silver', places: [3, 4] }, { name: 'Bronze', places: [5, 6] }] },
  { key: 'gs', label: 'Gold / Silver', hint: 'Top 2, then everyone else', brackets: [{ name: 'Gold', places: [1, 2] }, { name: 'Silver', places: [3, 4, 5, 6] }] },
  { key: 'one', label: 'Single bracket', hint: 'Top 2 of each pool', brackets: [{ name: 'Gold', places: [1, 2] }] },
];

async function load() {
  removed.value = [];
  if (!props.tournamentId) {
    drafts.value = [];
    return;
  }
  loading.value = true;
  try {
    const [{ data }, { data: ms }] = await Promise.all([
      supabase.from('brackets').select('*').eq('tournament_id', props.tournamentId).order('sort_order').order('created_at'),
      supabase.from('matches').select('bracket_id').eq('tournament_id', props.tournamentId).eq('match_type', 'bracket'),
    ]);
    const withMatches = new Set(((ms as any[]) ?? []).map((m) => m.bracket_id));
    drafts.value = ((data as Bracket[]) ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      places: Array.isArray(b.places) ? [...b.places] : [],
      round_formats: completeFormats(b.round_formats),
      hasMatches: withMatches.has(b.id),
    }));
  } finally {
    loading.value = false;
  }
}
watch(() => props.tournamentId, load, { immediate: true });

function completeFormats(existing: BracketRoundFormat[] | null | undefined): BracketRoundFormat[] {
  const defaults = defaultRoundFormats();
  return ROUND_ROWS.map((r) => {
    const e = (existing ?? []).find((x) => Number(x.fromEnd) === r.fromEnd);
    return e ? { ...e, fromEnd: r.fromEnd } : defaults.find((d) => d.fromEnd === r.fromEnd) ?? { fromEnd: r.fromEnd, ...DEFAULT_SINGLE_SET };
  });
}

function applyPreset(key: string) {
  const p = PRESETS.find((x) => x.key === key);
  if (!p) return;
  // Reuse existing rows by position so ids (and any generated matches) carry over where possible.
  const next: Draft[] = p.brackets.map((b, i) => {
    const prev = drafts.value[i];
    return prev
      ? { ...prev, name: b.name, places: [...b.places] }
      : { id: null, name: b.name, places: [...b.places], round_formats: completeFormats(null), hasMatches: false };
  });
  removed.value.push(...drafts.value.slice(p.brackets.length).filter((d) => d.id));
  drafts.value = next;
}

function addBracket() {
  const used = new Set(drafts.value.flatMap((d) => d.places));
  const free = PLACES.filter((p) => !used.has(p)).slice(0, 2);
  const names = ['Gold', 'Silver', 'Bronze', 'Copper', 'Open'];
  const name = names.find((n) => !drafts.value.some((d) => d.name.toLowerCase() === n.toLowerCase())) ?? `Bracket ${drafts.value.length + 1}`;
  drafts.value.push({ id: null, name, places: free, round_formats: completeFormats(null), hasMatches: false });
}

function removeBracket(i: number) {
  const [d] = drafts.value.splice(i, 1);
  if (d?.id) removed.value.push(d);
}

function move(i: number, dir: -1 | 1) {
  const j = i + dir;
  if (j < 0 || j >= drafts.value.length) return;
  const arr = drafts.value.slice();
  [arr[i], arr[j]] = [arr[j], arr[i]];
  drafts.value = arr;
}

function togglePlace(d: Draft, p: number) {
  d.places = d.places.includes(p) ? d.places.filter((x) => x !== p) : [...d.places, p].sort((a, b) => a - b);
}

/** Which other bracket already takes a place (for the conflict hint). */
function ownerOf(p: number, self: Draft): string | null {
  return drafts.value.find((d) => d !== self && d.places.includes(p))?.name ?? null;
}

function formatFor(d: Draft, fromEnd: number): MatchFormat {
  return d.round_formats.find((r) => r.fromEnd === fromEnd) ?? { ...DEFAULT_SINGLE_SET };
}
function setFormat(d: Draft, fromEnd: number, f: MatchFormat) {
  d.round_formats = d.round_formats.map((r) => (r.fromEnd === fromEnd ? { ...f, fromEnd } : r));
}
function formatSummary(d: Draft): string {
  const sf = formatFor(d, 2);
  const early = formatFor(d, 3);
  const a = sf.bestOf === 3 ? `Semis & final best of 3 (${sf.setTargets.join('-')})` : `Semis 1 set to ${sf.setTargets[0]}`;
  const b = early.bestOf === 3 ? 'earlier rounds best of 3' : `earlier rounds 1 set to ${early.setTargets[0]}`;
  return `${a}; ${b}`;
}

const errors = computed(() => {
  const out: string[] = [];
  const names = new Set<string>();
  for (const d of drafts.value) {
    const n = d.name.trim().toLowerCase();
    if (!n) out.push('Every bracket needs a name.');
    else if (names.has(n)) out.push(`Two brackets are named "${d.name.trim()}".`);
    names.add(n);
    if (!d.places.length) out.push(`${d.name || 'A bracket'} has no pool places selected.`);
  }
  for (const p of PLACES) {
    const owners = drafts.value.filter((d) => d.places.includes(p));
    if (owners.length > 1) out.push(`Pool place ${p} is in both ${owners.map((o) => o.name).join(' and ')}.`);
  }
  return [...new Set(out)];
});

/** Persist drafts for the given tournament id. Throws on error. */
async function save(tournamentId: string) {
  if (errors.value.length) throw new Error(errors.value[0]);
  for (const d of removed.value) {
    if (!d.id) continue;
    const { error } = await supabase.from('brackets').delete().eq('id', d.id);
    if (error) throw new Error(`Could not remove ${d.name}: ${error.message}`);
  }
  // Two-phase rename avoids the unique (tournament, name) index tripping on swaps.
  for (const [i, d] of drafts.value.entries()) {
    if (d.id) await supabase.from('brackets').update({ name: `__tmp_${i}_${d.id.slice(0, 6)}` }).eq('id', d.id);
  }
  for (const [i, d] of drafts.value.entries()) {
    const row = { tournament_id: tournamentId, name: d.name.trim(), sort_order: i, places: d.places, round_formats: d.round_formats };
    if (d.id) {
      const { error } = await supabase.from('brackets').update(row).eq('id', d.id);
      if (error) throw new Error(`Could not save ${d.name}: ${error.message}`);
    } else {
      const { data, error } = await supabase.from('brackets').insert(row).select('id').single();
      if (error) throw new Error(`Could not add ${d.name}: ${error.message}`);
      d.id = (data as any).id;
    }
  }
  removed.value = [];
}

defineExpose({ save, reload: load, errors });
</script>

<template>
  <section class="rounded-xl border border-tone-600/45 bg-tone-800/50 p-4 shadow-lg shadow-black/10">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="text-sm font-semibold text-ink">Brackets</h3>
        <p class="mt-0.5 max-w-md text-xs text-tone-400">
          After pool play, teams go to a bracket by where they finished in their pool. Within a bracket they're seeded by wins, then point differential.
        </p>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="p in PRESETS"
          :key="p.key"
          type="button"
          :title="p.hint"
          class="rounded-full border border-tone-600/60 px-3 py-1 text-xs font-semibold text-tone-200 transition hover:border-amber-500/60 hover:text-ink"
          @click="applyPreset(p.key)"
        >
          {{ p.label }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="mt-4 text-sm text-tone-400">Loading brackets…</div>

    <div v-else-if="!drafts.length" class="mt-4 rounded-lg border border-dashed border-tone-600/60 p-5 text-center text-sm text-tone-400">
      No brackets yet. Pick a preset above or
      <button type="button" class="font-semibold text-amber-300 underline-offset-2 hover:underline" @click="addBracket">add one</button>.
      <div class="mt-1 text-xs">Without brackets, the top 2 of each pool play one bracket.</div>
    </div>

    <ol v-else class="mt-4 grid gap-3">
      <li v-for="(d, i) in drafts" :key="d.id ?? `new-${i}`" class="rounded-lg border border-tone-600/45 bg-tone-900/30">
        <div class="flex flex-wrap items-center gap-3 p-3">
          <span class="h-3 w-3 shrink-0 rounded-full" :style="{ background: medalFor(d.name, i).dot }" aria-hidden="true" />
          <input
            v-model="d.name"
            :aria-label="`Bracket ${i + 1} name`"
            class="w-32 rounded-md border border-tone-600/60 bg-paper px-2 py-1 text-sm font-semibold text-slate-900"
          />
          <div class="flex items-center gap-1" role="group" :aria-label="`${d.name} pool places`">
            <span class="mr-1 text-xs text-tone-400">Pool places</span>
            <button
              v-for="p in PLACES"
              :key="p"
              type="button"
              :aria-pressed="d.places.includes(p)"
              :title="ownerOf(p, d) && !d.places.includes(p) ? `Already in ${ownerOf(p, d)}` : `${p}${p === 1 ? 'st' : p === 2 ? 'nd' : p === 3 ? 'rd' : 'th'} place`"
              class="h-7 w-7 rounded-full text-xs font-bold transition"
              :class="
                d.places.includes(p)
                  ? ownerOf(p, d)
                    ? 'bg-red-600 text-white'
                    : 'bg-amber-500 text-white'
                  : ownerOf(p, d)
                    ? 'border border-dashed border-tone-600/60 text-tone-500'
                    : 'border border-tone-600/70 text-tone-300 hover:border-amber-500/60'
              "
              @click="togglePlace(d, p)"
            >
              {{ p }}
            </button>
          </div>
          <div class="ml-auto flex items-center">
            <Button icon="pi pi-arrow-up" text rounded size="small" :disabled="i === 0" aria-label="Move up" class="!text-tone-300" @click="move(i, -1)" />
            <Button icon="pi pi-arrow-down" text rounded size="small" :disabled="i === drafts.length - 1" aria-label="Move down" class="!text-tone-300" @click="move(i, 1)" />
            <Button icon="pi pi-trash" text rounded size="small" severity="danger" :aria-label="`Remove ${d.name}`" @click="removeBracket(i)" />
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2 border-t border-tone-600/35 px-3 py-2 text-xs">
          <span class="text-tone-400">{{ placesLabel(d.places) }} · {{ formatSummary(d) }}</span>
          <button type="button" class="font-semibold text-amber-300 hover:underline" :aria-expanded="!!openFormats[i]" @click="openFormats[i] = !openFormats[i]">
            {{ openFormats[i] ? 'Hide round formats' : 'Edit round formats' }}
          </button>
        </div>
        <div v-if="openFormats[i]" class="grid gap-2 border-t border-tone-600/35 p-3">
          <div v-for="r in ROUND_ROWS" :key="r.fromEnd" class="grid grid-cols-[7rem_1fr] items-center gap-2">
            <span class="text-xs font-semibold text-tone-300">{{ r.label }}</span>
            <FormatPicker :modelValue="formatFor(d, r.fromEnd)" :label="`${d.name} ${r.label}`" @update:modelValue="(f) => setFormat(d, r.fromEnd, f)" />
          </div>
          <p class="text-xs text-tone-500">Rounds that a smaller bracket doesn't have are ignored.</p>
        </div>
        <p v-if="d.hasMatches" class="border-t border-tone-600/35 px-3 py-2 text-xs text-amber-300">
          This bracket has already been generated. Changes take effect when you regenerate it on the Brackets page.
        </p>
      </li>
    </ol>

    <div class="mt-3 flex items-center justify-between gap-3">
      <button v-if="drafts.length" type="button" class="text-xs font-semibold text-amber-300 hover:underline" @click="addBracket">+ Add bracket</button>
      <span v-else />
      <span v-if="!tournamentId" class="text-xs text-tone-500">Saved together with the tournament.</span>
    </div>
    <ul v-if="errors.length" class="mt-2 grid gap-1 text-xs text-red-300">
      <li v-for="e in errors" :key="e">{{ e }}</li>
    </ul>
  </section>
</template>
