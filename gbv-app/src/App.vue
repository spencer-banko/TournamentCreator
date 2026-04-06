<script setup lang="ts">
import Toast from 'primevue/toast';
import ConfirmDialog from 'primevue/confirmdialog';
import { watchEffect, computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

const isGtPublicShell = computed(
  () =>
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
    'bg-[#0b1120]',
    'text-white',
    'text-slate-100',
    'text-slate-800',
  ];
  for (const c of managed) {
    body.classList.remove(c);
    html.classList.remove(c);
  }

  const pageClasses = isGtPublicShell.value
    ? (['bg-[#0b1120]', 'text-slate-100'] as const)
    : (['bg-black', 'text-white'] as const);
  for (const c of pageClasses) {
    body.classList.add(c);
    html.classList.add(c);
  }

  const themeColor = isGtPublicShell.value ? '#0b1120' : '#000000';
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
    :class="isGtPublicShell ? 'bg-[#0b1120] text-slate-100' : 'bg-black text-white'"
  >
    <Toast />
    <ConfirmDialog />

    <header
      v-if="!$route.meta.fullScreen && !$route.meta.adminDashboardLayout"
      :class="$route.meta.blueLayout ? 'bg-transparent text-white border-b border-white/15' : 'bg-transparent text-white border-b border-white/15'"
    >
      <div class="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
        <h1 class="text-xl sm:text-2xl font-extrabold tracking-tight">
          GT Beach Volleyball
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
      :class="$route.meta.blueLayout ? 'border-t border-white/15 text-sm text-white/80 bg-transparent' : 'border-t border-white/15 text-sm text-white/80 bg-transparent'"
    >
      <div class="mx-auto max-w-6xl px-4 py-4">
        © 2025 GT Beach Volleyball
      </div>
    </footer>
  </div>
</template>
