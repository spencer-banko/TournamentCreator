<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import PublicLayout from '../components/layout/PublicLayout.vue';


const toast = useToast();
const route = useRoute();
const router = useRouter();
const session = useSessionStore();

const accessCodeParam = ref<string>((route.params.accessCode as string) ?? '');
const accessCodeInput = ref<string>('');
const loading = ref(false);

function resetScrollFocus() {
  if (typeof document !== 'undefined') {
    const el = document.activeElement as HTMLElement | null;
    if (el && typeof el.blur === 'function') el.blur();
  }
  if (typeof window !== 'undefined') {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }
}

/**
 * Force navigation to the tournament destination and hard-refresh to land cleanly at the top.
 * Falls back to Pools for unknown/draft/setup statuses.
 */
function navigateToTournament(code: string, status: string | undefined) {
  const name = status === 'bracket' ? 'public-bracket' : 'public-pool-list';
  const target = { name, params: { accessCode: code } as Record<string, any> };

  // Try SPA navigation first (non-blocking)
  router.replace(target).catch(() => { /* ignore redundant or async race */ });

  // Always perform a hard navigation to ensure we land cleanly without needing to scroll
  const resolved = router.resolve(target);
  if (typeof window !== 'undefined') {
    window.location.assign(resolved.href);
  }
}

async function refreshTournament(code: string) {
  loading.value = true;
  try {
    await session.ensureAnon();
    const t = await session.loadTournamentByCode(code);
    if (!t) {
      console.debug('[TournamentPublic] refreshTournament - not found', { code });
      session.clearAccessCode();
      toast.add({ severity: 'error', summary: 'Tournament does not exist', detail: '', life: 3000 });
      router.replace({ name: 'tournament-public' });
      return;
    }

    console.debug('[TournamentPublic] refreshTournament -> navigate', { code, status: t.status });
    navigateToTournament(code, t.status);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  session.initFromStorage();

  // Canonicalize URL based on stored or param code
  if (accessCodeParam.value) {
    session.setAccessCode(accessCodeParam.value);
  }
  const effectiveCode = accessCodeParam.value || session.accessCode || '';
  if (effectiveCode) {
    if (!accessCodeParam.value) {
      resetScrollFocus();
      await router.replace({ name: 'tournament-public', params: { accessCode: effectiveCode } });
    }
    await refreshTournament(effectiveCode);
  }
});

// React when the URL param accessCode changes (e.g., after saving code and canonicalizing URL)
watch(() => route.params.accessCode as string | undefined, async (newCode, oldCode) => {
  if (!newCode || newCode === oldCode) return;
  accessCodeParam.value = newCode;
  session.setAccessCode(newCode);
  await refreshTournament(newCode);
});

async function saveCode() {
  if (!accessCodeInput.value.trim()) return;
  const code = accessCodeInput.value.trim();
  resetScrollFocus();
  loading.value = true;
  try {
    await session.ensureAnon();
    const t = await session.loadTournamentByCode(code);
    if (!t) {
      console.debug('[TournamentPublic] saveCode - tournament not found', { code });
      toast.add({ severity: 'error', summary: 'Tournament does not exist', life: 3000 });
      return;
    }
    session.setAccessCode(code);
    toast.add({ severity: 'success', summary: 'Code Saved', detail: code, life: 2000 });
    console.debug('[TournamentPublic] saveCode -> navigate', { code, status: t.status });
    navigateToTournament(code, t.status);
  } finally {
    loading.value = false;
  }
}

</script>

<template>
  <!-- Hero Login (Access Code) -->
  <section v-if="!session.accessCode" class="relative min-h-dvh w-full overflow-hidden bg-[#0b1120] text-slate-100">
    <div
      class="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-amber-500/12 blur-3xl"
      aria-hidden="true"
    />
    <div
      class="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-[#2d51a6]/20 blur-3xl"
      aria-hidden="true"
    />
    <div class="relative z-10 flex min-h-dvh w-full items-center justify-center px-4 py-12">
      <div class="w-full max-w-xl">
        <div class="text-center">
          <div class="mb-8 flex flex-col items-center">
            <img
              src="@/assets/GBVLogo.png"
              alt="GTBV Logo"
              class="mx-auto block h-auto max-h-[32vh] w-auto max-w-[min(512px,90vw)] object-contain drop-shadow-xl"
            />
            <img
              src="@/assets/GatorBeachVolleyball.png"
              alt="GT Beach Volleyball"
              class="mx-auto mt-4 block h-auto max-h-[32vh] w-auto max-w-[min(512px,90vw)] object-contain drop-shadow-xl"
            />
          </div>
          <h1 class="text-3xl font-extrabold tracking-tight text-white drop-shadow-md sm:text-4xl">
            Enter the tournament code to continue.
          </h1>
          <p class="mt-3 text-base text-slate-400 sm:text-lg">Pool play, bracket, and live scores — one code away.</p>
        </div>

        <div
          class="public-hero-card mt-8 rounded-2xl border border-slate-600/45 bg-gradient-to-br from-slate-800/90 via-slate-800/75 to-[#1a2740]/95 p-4 shadow-xl shadow-black/30 backdrop-blur-sm sm:p-6"
        >
          <label class="sr-only">Tournament Access Code</label>
          <div class="flex flex-col gap-3 sm:flex-row">
            <InputText
              v-model="accessCodeInput"
              placeholder="e.g. GOJACKETS"
              class="w-full !rounded-2xl !border-slate-300/90 !px-5 !py-4 !text-xl !bg-white !shadow-lg !text-slate-900"
            />
            <Button
              label="Continue"
              icon="pi pi-arrow-right"
              @click="saveCode"
              class="!rounded-2xl !px-6 !py-4 !text-xl !font-semibold !shadow-lg border-none text-white gbv-grad-blue"
            />
          </div>
          <p class="mt-3 text-sm text-slate-400">Access code is provided by the president.</p>
          <div class="mt-3 text-center text-sm text-slate-400">
            Admin? Go to
            <router-link
              class="font-medium text-amber-400/90 underline decoration-amber-500/40 underline-offset-2 hover:text-amber-300"
              :to="{ name: 'admin-login' }"
            >
              Admin Login
            </router-link>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Main Public Redirect Controller -->
  <PublicLayout v-else>
    <section class="p-5 sm:p-7">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h2 class="text-2xl font-semibold tracking-tight text-white">Tournament</h2>
          <p class="mt-1 text-slate-400">
            Redirecting you to Pools or Bracket based on tournament phase…
          </p>
        </div>
        <div v-if="loading" class="text-sm text-slate-400">Loading…</div>
      </div>

      <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <router-link
          :to="{ name: 'public-pool-list', params: { accessCode: session.accessCode } }"
          class="rounded-xl border border-slate-600/45 bg-slate-800/50 p-5 text-center shadow-lg shadow-black/25 transition-colors hover:border-amber-500/25 hover:bg-slate-800/65"
        >
          <div class="text-lg font-semibold text-white">Go to Pools</div>
          <div class="mt-1 text-sm text-slate-400">Standings & schedule</div>
        </router-link>

        <router-link
          :to="{ name: 'public-bracket', params: { accessCode: session.accessCode } }"
          class="rounded-xl border border-slate-600/45 bg-slate-800/50 p-5 text-center shadow-lg shadow-black/25 transition-colors hover:border-amber-500/25 hover:bg-slate-800/65"
        >
          <div class="text-lg font-semibold text-white">Go to Bracket</div>
          <div class="mt-1 text-sm text-slate-400">Playoff bracket</div>
        </router-link>
      </div>

      <div class="mt-6 text-center text-sm text-slate-400">
        Admin? Go to
        <router-link
          class="font-medium text-amber-400/90 underline decoration-amber-500/40 underline-offset-2 hover:text-amber-300"
          :to="{ name: 'admin-login' }"
        >
          Admin Login
        </router-link>
      </div>
    </section>
  </PublicLayout>
</template>

<style scoped>
.public-hero-card {
  box-shadow:
    0 0 0 1px rgba(251, 191, 36, 0.06),
    0 25px 50px -12px rgba(0, 0, 0, 0.5);
}
</style>