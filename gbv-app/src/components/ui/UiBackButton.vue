<script setup lang="ts">
import { useRouter, type RouteLocationRaw } from 'vue-router';

const props = withDefaults(defineProps<{
  to?: RouteLocationRaw | null;
  ariaLabel?: string;
  onClick?: (() => void) | null;
}>(), {
  to: null,
  ariaLabel: 'Back',
  onClick: null,
});

const router = useRouter();

function handleClick() {
  if (props.onClick) {
    props.onClick();
    return;
  }
  if (props.to) {
    void router.push(props.to);
    return;
  }
  router.back();
}
</script>

<template>
  <button
    type="button"
    class="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-600/80 bg-slate-800/80 text-slate-100 shadow-sm transition-colors hover:border-amber-500/35 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50 active:scale-[0.99]"
    :aria-label="props.ariaLabel"
    :title="props.ariaLabel"
    @click="handleClick"
  >
    <i class="pi pi-arrow-left text-lg" aria-hidden="true"></i>
  </button>
</template>

