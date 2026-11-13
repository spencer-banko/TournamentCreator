<script setup lang="ts">
/**
 * Admin Home: the active tournament, its step-by-step progress with a "Continue" shortcut,
 * and the list of tournaments. Header, tournament switcher and step sidebar come from AdminLayout.
 */
import { ref, computed, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { ClipboardDocumentIcon, CheckIcon } from '@heroicons/vue/24/outline';
import { useSessionStore } from '../stores/session';
import { useAdminProgressStore } from '../stores/adminProgress';
import { nextStep, type StepStatus } from '../lib/adminSteps';
import AdminTournamentListPanel from '@/components/admin/AdminTournamentListPanel.vue';
import { useToast } from 'primevue/usetoast';

const router = useRouter();
const session = useSessionStore();
const progress = useAdminProgressStore();
const toast = useToast();

const copyFeedback = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

function formatEventDateRange(ymd: string | undefined): string {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '—';
  const d = new Date(`${ymd}T12:00:00`);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

async function copyAccessCode() {
  const code = session.tournament?.access_code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    copyFeedback.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyFeedback.value = false;
    }, 2000);
  } catch {
    toast.add({ severity: 'warn', summary: 'Copy failed', detail: 'Your browser blocked clipboard access.', life: 3000 });
  }
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer);
});

const activeTitle = computed(() => session.tournament?.name ?? 'None selected');
const activeSubtitle = computed(() => (session.tournament ? '' : 'Choose a tournament below and use View to activate it.'));

const continueStep = computed(() => nextStep(progress.stats));
const allDone = computed(() => progress.steps.every((s) => s.status === 'done'));

function goToStep(routeName: string) {
  if (routeName === 'admin-tournament-setup' && session.tournament) {
    router.push({ name: routeName, query: { edit: session.tournament.id } });
  } else {
    router.push({ name: routeName });
  }
}

const statusIcon: Record<StepStatus, string> = {
  done: 'pi-check-circle text-emerald-400',
  progress: 'pi-circle-fill text-sky-400',
  attention: 'pi-exclamation-triangle text-amber-400',
  todo: 'pi-circle text-tone-500',
};
const statusLabel: Record<StepStatus, string> = {
  done: 'Done',
  progress: 'In progress',
  attention: 'Needs attention',
  todo: 'Not started',
};

async function onTournamentListStatsRefresh() {
  await progress.refresh();
}
</script>

<template>
  <div>
    <p class="text-base font-medium text-tone-400 sm:text-lg">Tournament setup and day-of operations</p>
    <h1 class="mt-2 text-3xl font-bold tracking-tight text-ink sm:text-4xl">Home</h1>

      <!-- Active tournament hero -->
    <div
      class="admin-hero-card relative mt-8 overflow-hidden rounded-2xl border border-tone-600/45 bg-gradient-to-br from-tone-800/90 via-tone-800/75 to-tone-900/95 p-6 shadow-xl shadow-black/30 sm:p-8"
    >
      <div
        class="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-amber-500/10 blur-3xl"
        aria-hidden="true"
      />
      <div
        class="pointer-events-none absolute -bottom-20 -left-10 h-40 w-40 rounded-full bg-blue-500/10 blur-3xl"
        aria-hidden="true"
      />

      <div
        class="inline-flex items-center rounded-full border border-amber-500/25 bg-amber-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-amber-400/95"
      >
        Active Tournament
      </div>

      <div class="mt-6 space-y-4">
        <!-- Title row: name + compact access code under name (left); date/teams (right) -->
        <div class="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between lg:gap-10">
          <div class="min-w-0 flex-1">
            <h2
              class="font-['Plus_Jakarta_Sans',system-ui,sans-serif] text-3xl font-extrabold leading-tight text-ink sm:text-4xl lg:text-[2.35rem]"
            >
              {{ activeTitle }}
            </h2>

            <div
              v-if="session.tournament"
              class="mt-5 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-tone-600/40 bg-tone-800/40 px-2.5 py-1.5 sm:gap-x-3"
            >
              <div class="flex flex-wrap items-baseline gap-x-1.5 leading-tight">
                <span class="text-sm font-medium text-tone-300 sm:text-base">Public access code:</span>
                <span class="font-mono text-sm font-bold tracking-wide text-ink sm:text-base">
                  {{ session.tournament.access_code }}
                </span>
              </div>
              <button
                type="button"
                class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-tone-500/45 bg-tone-700/50 px-2.5 py-1.5 text-sm font-medium text-tone-100 transition hover:border-amber-500/35 hover:bg-tone-700/70 hover:text-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
                @click="copyAccessCode"
              >
                <CheckIcon v-if="copyFeedback" class="h-4 w-4 text-emerald-400" aria-hidden="true" />
                <ClipboardDocumentIcon v-else class="h-4 w-4 text-tone-300" aria-hidden="true" />
                <span>{{ copyFeedback ? 'Copied!' : 'Copy code' }}</span>
              </button>
            </div>
          </div>

          <div
            v-if="session.tournament"
            class="flex w-full shrink-0 flex-col gap-5 rounded-xl border border-tone-600/40 bg-tone-800/45 px-5 py-4 sm:min-w-[12rem] lg:mt-0 lg:w-auto lg:max-w-[15rem] lg:rounded-none lg:border-0 lg:border-l-2 lg:border-solid lg:border-tone-500/45 lg:bg-transparent lg:px-0 lg:pb-0 lg:pl-8 lg:pt-0"
          >
            <div>
              <div class="text-sm font-semibold uppercase tracking-wide text-tone-300">Date range</div>
              <div class="mt-1 text-lg font-semibold text-ink">
                {{ formatEventDateRange(session.tournament.date) }}
              </div>
            </div>
            <div>
              <div class="text-sm font-semibold uppercase tracking-wide text-tone-300">Teams</div>
              <div class="mt-1 flex items-baseline gap-2">
                <span class="text-2xl font-bold tabular-nums text-ink">
                  {{ progress.loading && !progress.loadedFor ? '…' : progress.stats.teams }}
                </span>
                <span class="text-base text-tone-300">registered</span>
              </div>
            </div>
          </div>
        </div>

        <p v-if="activeSubtitle" class="max-w-xl text-sm text-tone-400">
          {{ activeSubtitle }}
        </p>
      </div>
    </div>


    <!-- Progress: the five steps, with a shortcut to the next unfinished one -->
    <section v-if="session.tournament" class="mt-8 rounded-2xl border border-tone-600/45 bg-tone-800/50 p-5 sm:p-6">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Progress</h2>
          <p class="mt-1 text-sm text-tone-400">
            {{ allDone ? 'Every step is complete.' : 'Work through the steps in order — use the sidebar or the Next button on each page.' }}
          </p>
        </div>
        <button
          type="button"
          class="inline-flex shrink-0 items-center justify-center gap-2 rounded-full bg-amber-500 px-6 py-3 text-base font-semibold text-white shadow-lg transition hover:bg-amber-600"
          @click="goToStep(continueStep.routeName)"
        >
          {{ allDone ? 'Open' : 'Continue' }}: {{ continueStep.title }}
          <i class="pi pi-arrow-right text-sm" aria-hidden="true" />
        </button>
      </div>

      <ol class="mt-5 grid gap-2">
        <li v-for="(s, i) in progress.steps" :key="s.id">
          <button
            type="button"
            class="flex w-full items-center gap-4 rounded-xl border px-4 py-3 text-left transition hover:bg-tone-700/30"
            :class="s.id === continueStep.id && !allDone ? 'border-amber-500/50 bg-amber-500/5' : 'border-tone-600/40'"
            @click="goToStep(s.routeName)"
          >
            <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-tone-600/60 text-sm font-bold text-tone-300">{{ i + 1 }}</span>
            <span class="min-w-0 flex-1">
              <span class="block font-semibold text-ink">{{ s.title }}</span>
              <span class="block text-sm text-tone-400">{{ s.hint }}</span>
            </span>
            <span class="hidden text-xs font-medium text-tone-400 sm:inline">{{ statusLabel[s.status] }}</span>
            <i class="pi text-lg" :class="statusIcon[s.status]" :aria-label="statusLabel[s.status]" />
          </button>
        </li>
      </ol>
    </section>

      <!-- Your tournaments -->
    <section class="mt-10">
      <h2 class="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Your Tournaments</h2>
      <p class="mt-2 max-w-3xl text-base leading-relaxed text-tone-400 sm:text-lg">
        Upcoming events first. Use the actions to work with each tournament.
      </p>

      <div
        class="admin-tournaments-table-wrap mt-4 overflow-hidden rounded-xl border border-tone-600/45 bg-tone-800/50 p-1 sm:p-2"
      >
        <AdminTournamentListPanel variant="dashboard" @stats-refresh="onTournamentListStatsRefresh" />
      </div>
    </section>

  </div>
</template>

<style scoped>
.admin-hero-card {
  box-shadow:
    0 0 0 1px rgba(251, 191, 36, 0.06),
    0 25px 50px -12px rgba(0, 0, 0, 0.5);
}
</style>
