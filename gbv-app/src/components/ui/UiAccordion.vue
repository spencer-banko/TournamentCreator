<script setup lang="ts">
import { ref, watch } from 'vue';

interface Props {
  title: string;
  open?: boolean;         // controlled v-model:open
  defaultOpen?: boolean;  // uncontrolled initial state
  disabled?: boolean;
  subtitle?: string;
}
const props = defineProps<Props>();
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();

const isOpen = ref<boolean>(props.open ?? props.defaultOpen ?? false);

watch(
  () => props.open,
  (v) => {
    if (typeof v === 'boolean') isOpen.value = v;
  }
);

function toggle() {
  if (props.disabled) return;
  const next = !isOpen.value;
  isOpen.value = next;
  emit('update:open', next);
}
</script>

<template>
  <div class="w-full rounded-lg border border-white/15 bg-white/5">
    <div
      class="flex items-stretch justify-between gap-2 sm:gap-3"
      :class="[disabled ? 'opacity-60' : '']"
    >
      <button
        type="button"
        class="min-w-0 flex-1 px-4 py-3 text-left"
        :class="[disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-white/5']"
        @click="toggle"
        :aria-expanded="isOpen"
        :disabled="disabled"
      >
        <div class="font-semibold tracking-wide truncate">
          {{ title }}
        </div>
        <div v-if="subtitle" class="text-sm text-white/80 truncate">
          {{ subtitle }}
        </div>
      </button>
      <div class="flex shrink-0 items-center gap-1 pr-2 sm:gap-2 sm:pr-3">
        <slot name="actions" />
        <button
          type="button"
          class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400/50 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="disabled"
          :aria-expanded="isOpen"
          aria-label="Expand or collapse section"
          @click="toggle"
        >
          <i class="pi text-lg" :class="isOpen ? 'pi-chevron-up' : 'pi-chevron-down'"></i>
        </button>
      </div>
    </div>

    <div v-show="isOpen" class="px-4 pb-4 pt-1">
      <slot />
    </div>
  </div>
</template>

<style scoped>
</style>