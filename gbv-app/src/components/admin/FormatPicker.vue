<script setup lang="ts">
/** Compact editor for a match format: 1 set vs best of 3, per-set targets, optional cap. */
import { computed } from 'vue';
import type { MatchFormat } from '../../types/db';

const props = withDefaults(defineProps<{ modelValue: MatchFormat; showCap?: boolean; label?: string }>(), { showCap: false, label: '' });
const emit = defineEmits<{ (e: 'update:modelValue', v: MatchFormat): void }>();

const f = computed(() => props.modelValue);

function setBestOf(n: 1 | 3) {
  const first = f.value.setTargets[0] ?? 21;
  emit('update:modelValue', {
    ...f.value,
    bestOf: n,
    setTargets: n === 3 ? [first, f.value.setTargets[1] ?? first, f.value.setTargets[2] ?? 15] : [first],
  });
}
function setTarget(i: number, v: string) {
  const n = Math.max(1, Math.min(99, Number(v) || 0));
  const t = f.value.setTargets.slice();
  t[i] = n;
  emit('update:modelValue', { ...f.value, setTargets: t });
}
function setCap(v: string) {
  const n = Number(v);
  emit('update:modelValue', { ...f.value, cap: Number.isFinite(n) && n > 0 ? n : null });
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <div class="inline-flex rounded-full border border-tone-600/70 bg-tone-900/40 p-0.5" role="radiogroup" :aria-label="label ? `${label} format` : 'Match format'">
      <button
        v-for="opt in [1, 3] as const"
        :key="opt"
        type="button"
        role="radio"
        :aria-checked="f.bestOf === opt"
        class="rounded-full px-3 py-1 text-xs font-semibold transition"
        :class="f.bestOf === opt ? 'bg-amber-500 text-white shadow-sm' : 'text-tone-300 hover:text-ink'"
        @click="setBestOf(opt)"
      >
        {{ opt === 1 ? '1 set' : 'Best of 3' }}
      </button>
    </div>
    <div class="flex items-center gap-1 text-xs text-tone-400">
      <span>to</span>
      <input
        v-for="(t, i) in f.setTargets"
        :key="i"
        :value="t"
        type="number"
        min="1"
        max="99"
        :aria-label="`${label} set ${i + 1} target`"
        class="w-11 rounded-md border border-tone-600/70 bg-paper px-1 py-1 text-center text-sm font-semibold text-slate-900"
        @change="setTarget(i, ($event.target as HTMLInputElement).value)"
      />
    </div>
    <label v-if="showCap" class="flex items-center gap-1 text-xs text-tone-400">
      <span>cap</span>
      <input
        :value="f.cap ?? ''"
        type="number"
        min="1"
        placeholder="none"
        :aria-label="`${label} cap`"
        class="w-14 rounded-md border border-tone-600/70 bg-paper px-1 py-1 text-center text-sm text-slate-900 placeholder:text-slate-400"
        @change="setCap(($event.target as HTMLInputElement).value)"
      />
    </label>
  </div>
</template>
