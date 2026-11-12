<script setup lang="ts">
import Toast from 'primevue/toast';
import ConfirmDialog from 'primevue/confirmdialog';
import { watchEffect, computed } from 'vue';
import { useRoute } from 'vue-router';
import { brand } from './lib/brand';

const route = useRoute();

/** Spacing and layout for all confirmation dialogs (e.g. tournament delete). */
const confirmDialogPt = {
  mask: { class: 'backdrop-blur-[2px]' },
  root: {
    class:
      '!max-w-lg !rounded-2xl !border !border-tone-600/60 !bg-tone-900 !shadow-2xl !ring-1 !ring-tone-700/80',
  },
  header: { class: '!border-b !border-tone-700/80 !px-8 !pb-4 !pt-8' },
  title: { class: '!text-lg !font-semibold !tracking-tight !text-ink' },
  content: { class: '!flex !items-start !gap-5 !px-8 !pb-2 !pt-2' },
  icon: { class: '!mt-0.5 !text-2xl !text-amber-400 shrink-0' },
  message: { class: '!m-0 !text-base !leading-relaxed !text-ink whitespace-pre-line' },
  footer: {
    class:
      '!flex !flex-wrap !items-center !justify-center !gap-3 !border-t !border-tone-700/80 !px-8 !pb-8 !pt-6',
  },
  pcRejectButton: {
    root: { class: '!min-w-[10rem] !justify-center !rounded-full !border !border-tone-600/70 !bg-transparent !py-2.5 !font-semibold !text-tone-200' },
  },
  pcAcceptButton: {
    root: { class: '!min-w-[10rem] !justify-center !rounded-full !border-none !bg-amber-500 !py-2.5 !font-semibold !text-white hover:!bg-amber-600' },
  },
};

// ECVA uses the light shell everywhere; GT keeps black on non-shell (legacy) routes.
const isGtPublicShell = computed(
  () =>
    brand.id === 'ecva' ||
    route.meta.publicShell === true ||
    route.meta.adminDashboardLayout === true ||
    route.name === 'admin-login'
);

watchEffect(() => {
  if (typeof document === 'undefined') return;
  const body = document.body;
  const html = document.documentElement;

  const managed = [
    'bg-gbv-bg',
    'bg-white',
    'bg-gbv-blue',
    'gbv-grad-green',
    'bg-black',
    'gbv-page-bg',
    'text-ink',
    'text-tone-100',
    'text-tone-800',
  ];
  for (const c of managed) {
    body.classList.remove(c);
    html.classList.remove(c);
  }

  const pageClasses = isGtPublicShell.value
    ? (['gbv-page-bg', 'text-tone-100'] as const)
    : (['bg-black', 'text-white'] as const);
  for (const c of pageClasses) {
    body.classList.add(c);
    html.classList.add(c);
  }

  const themeColor = isGtPublicShell.value ? getComputedStyle(document.documentElement).getPropertyValue('--brand-page-bg').trim() || '#0b1120' : '#000000';
  let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = themeColor;
});
</script>

<template>
  <div
    class="min-h-full min-h-dvh flex flex-col"
    :class="isGtPublicShell ? 'gbv-page-bg text-tone-100' : 'bg-black text-white'"
  >
    <Toast />
    <ConfirmDialog :pt="confirmDialogPt" />

    <header
      v-if="!$route.meta.fullScreen && !$route.meta.adminDashboardLayout"
      :class="$route.meta.blueLayout ? 'bg-transparent text-ink border-b border-ink/15' : 'bg-transparent text-ink border-b border-ink/15'"
    >
      <div class="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
        <h1 class="text-xl sm:text-2xl font-extrabold tracking-tight">
          {{ brand.appName }}
        </h1>
      </div>
    </header>

    <main
      class="flex-1"
      :class="{
        'mx-auto max-w-6xl w-full px-4 py-6': !$route.meta.fullScreen && !$route.meta.adminDashboardLayout,
        'w-full min-w-0': $route.meta.adminDashboardLayout,
      }"
    >
      <router-view />
    </main>

    <footer
      v-if="!$route.meta.fullScreen && !$route.meta.adminDashboardLayout"
      :class="$route.meta.blueLayout ? 'border-t border-ink/15 text-sm text-ink/80 bg-transparent' : 'border-t border-ink/15 text-sm text-ink/80 bg-transparent'"
    >
      <div class="mx-auto max-w-6xl px-4 py-4">
        © 2025 {{ brand.appName }}
      </div>
    </footer>
  </div>
</template>
