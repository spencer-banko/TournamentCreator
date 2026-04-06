<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import Button from 'primevue/button';

const router = useRouter();
const session = useSessionStore();

const email = ref('');
const password = ref('');
const loading = ref(false);
const errorMsg = ref<string | null>(null);

async function signIn(e: Event) {
  e.preventDefault();
  errorMsg.value = null;
  loading.value = true;
  try {
    await session.signInAdminWithEmail(email.value, password.value);
    router.replace({ name: 'admin-dashboard' });
  } catch (err: any) {
    errorMsg.value = err?.message ?? 'Login failed';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <section class="relative min-h-dvh w-full overflow-hidden bg-[#0b1120] text-slate-100">
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
          <h1 class="text-3xl font-extrabold tracking-tight text-white drop-shadow-md sm:text-4xl">Admin Console</h1>
          <p class="mt-3 text-base text-slate-400 sm:text-lg">
            Manage players, pools, schedules, and brackets.
          </p>
        </div>

        <div
          class="public-hero-card mt-8 rounded-2xl border border-slate-600/45 bg-gradient-to-br from-slate-800/90 via-slate-800/75 to-[#1a2740]/95 p-4 shadow-xl shadow-black/30 backdrop-blur-sm sm:p-6"
        >
          <form class="space-y-5" @submit="signIn">
            <div
              v-if="errorMsg"
              class="rounded-lg border border-red-500/40 bg-red-950/35 p-3 text-sm text-red-200"
            >
              {{ errorMsg }}
            </div>

            <div class="space-y-2">
              <label class="text-sm font-semibold text-slate-200">Email</label>
              <InputText
                v-model="email"
                type="email"
                placeholder="admin@example.com"
                class="w-full !rounded-2xl !border-slate-300/90 !px-5 !py-4 !text-base !bg-white !shadow-lg !text-slate-900"
                required
              />
            </div>

            <div class="space-y-2">
              <label class="text-sm font-semibold text-slate-200">Password</label>
              <Password
                v-model="password"
                :feedback="false"
                toggleMask
                class="w-full"
                inputClass="!rounded-2xl !border !border-slate-300/90 !px-5 !py-4 !text-base !bg-white !shadow-lg !text-slate-900"
                placeholder="••••••••"
                required
              />
            </div>

            <Button
              type="submit"
              :disabled="loading"
              label="Sign In"
              icon="pi pi-lock-open"
              class="!w-full !rounded-2xl !px-6 !py-4 !text-lg !font-semibold !shadow-lg border-none text-white gbv-grad-blue"
            />
          </form>

          <div class="mt-6 text-center text-sm text-slate-400">
            Public site:
            <router-link
              class="font-medium text-amber-400/90 underline decoration-amber-500/40 underline-offset-2 hover:text-amber-300"
              :to="{ name: 'tournament-public' }"
            >
              Tournament
            </router-link>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.public-hero-card {
  box-shadow:
    0 0 0 1px rgba(251, 191, 36, 0.06),
    0 25px 50px -12px rgba(0, 0, 0, 0.5);
}
</style>
