<script setup lang="ts">
import { RouterLink } from 'vue-router';

interface Props {
  title: string;
  description?: string;
  to?: any;
  icon?: string; // primeicons class suffix, e.g., "pi-users"
  disabled?: boolean;
  badge?: string | number;
  badgeSeverity?: 'success' | 'warn' | 'danger' | 'info';
  /** Admin dashboard: slate surfaces, gold hover accents */
  cohesive?: boolean;
  /** Single card tile (no bottom divider between stacked items) */
  standaloneCard?: boolean;
}
const props = defineProps<Props>();
</script>

<template>
  <component
    :is="props.to && !props.disabled ? RouterLink : 'div'"
    :to="props.to as any"
    class="group relative flex items-center gap-3 rounded-none"
    :class="[
      props.standaloneCard ? 'h-full min-h-[4.5rem] border-0 px-5 py-4' : 'border-b px-4 py-3.5 last:border-b-0',
      props.standaloneCard ? '' : props.cohesive ? 'border-slate-700/55' : 'border-white/15',
      'transition-colors duration-150',
      props.disabled
        ? 'opacity-60 cursor-not-allowed'
        : props.cohesive
          ? 'hover:bg-slate-800/55 hover:border-amber-500/15 cursor-pointer'
          : 'hover:bg-white/5 cursor-pointer',
    ]"
    role="button"
    :aria-disabled="props.disabled || undefined"
  >
    <div class="shrink-0">
      <i
        :class="[
          'pi',
          props.icon || 'pi-circle',
          'text-xl',
          props.cohesive ? 'text-slate-400 transition-colors group-hover:text-amber-400/90' : 'text-white',
        ]"
      ></i>
    </div>
    <div class="min-w-0 flex-1">
      <div
        :class="[
          'font-semibold tracking-wide truncate',
          props.cohesive ? 'text-slate-100 group-hover:text-white' : '',
        ]"
      >
        {{ props.title }}
      </div>
      <div
        v-if="props.description"
        :class="['text-sm truncate', props.cohesive ? 'text-slate-500 group-hover:text-slate-400' : 'text-white/80']"
      >
        {{ props.description }}
      </div>
    </div>
    <div class="shrink-0 flex items-center gap-2">
      <slot name="badge">
        <div
          v-if="props.badge"
          class="rounded-md px-2 py-0.5 text-xs font-medium"
          :class="[
            props.cohesive && props.badgeSeverity === 'success'
              ? 'border border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
              : props.cohesive && props.badgeSeverity === 'warn'
                ? 'border border-amber-500/30 bg-amber-500/10 text-amber-200'
                : props.cohesive && props.badgeSeverity === 'danger'
                  ? 'border border-red-500/25 bg-red-500/10 text-red-300'
                  : props.cohesive
                    ? 'border border-slate-600/50 bg-slate-800/80 text-slate-300'
                    : '',
            !props.cohesive && props.badgeSeverity === 'success' ? 'bg-green-500/20 text-green-300' : '',
            !props.cohesive && props.badgeSeverity === 'warn' ? 'bg-amber-500/20 text-amber-300' : '',
            !props.cohesive && props.badgeSeverity === 'danger' ? 'bg-red-500/20 text-red-300' : '',
            !props.cohesive && props.badgeSeverity === 'info' ? 'bg-white/10 text-white/70' : '',
            !props.cohesive && !props.badgeSeverity ? 'bg-white/10 text-white/70' : '',
          ]"
        >
          {{ props.badge }}
        </div>
      </slot>
      <slot name="actions">
        <i
          v-if="props.to && !props.disabled"
          :class="[
            'pi pi-chevron-right',
            props.cohesive ? 'text-slate-500 transition-colors group-hover:text-amber-400/85' : 'text-white/80',
          ]"
        ></i>
      </slot>
    </div>
  </component>
</template>

<style scoped>
</style>