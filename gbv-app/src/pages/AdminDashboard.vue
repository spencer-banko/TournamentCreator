<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { Menu, MenuButton, MenuItems, MenuItem } from '@headlessui/vue';
import {
  ChevronDownIcon,
  ArrowRightStartOnRectangleIcon,
  ClipboardDocumentIcon,
  CheckIcon,
} from '@heroicons/vue/24/outline';
import { useSessionStore } from '../stores/session';
import UiListItem from '@/components/ui/UiListItem.vue';
import AdminTournamentListPanel from '@/components/admin/AdminTournamentListPanel.vue';
import supabase from '../lib/supabase';
import { useToast } from 'primevue/usetoast';

const router = useRouter();
const session = useSessionStore();
const toast = useToast();

const copyFeedback = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

const adminEmail = computed(() => {
  const e = session.adminUser?.email?.trim();
  return e && e.length > 0 ? e : 'Admin';
});

async function signOut() {
  await session.signOutAdmin();
  router.replace({ name: 'admin-login' });
}

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
    toast.add({
      severity: 'warn',
      summary: 'Copy failed',
      detail: 'Your browser blocked clipboard access.',
      life: 3000,
    });
  }
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer);
});

const restoringTournament = ref(false);

async function restoreAdminTournament() {
  session.initFromStorage();
  const id = session.getAdminActiveTournamentId();
  if (!id) {
    session.tournament = null;
    return;
  }
  restoringTournament.value = true;
  try {
    const t = await session.loadAdminTournamentById(id);
    if (!t) {
      session.setAdminActiveTournamentId(null);
      toast.add({
        severity: 'warn',
        summary: 'Tournament unavailable',
        detail: 'Pick another tournament from the list below.',
        life: 4000,
      });
    }
  } finally {
    restoringTournament.value = false;
  }
}

const stats = ref({
  totalTeams: 0,
  teamsNamed: 0,
  teamsInPool: 0,
  poolMatches: 0,
  bracketMatches: 0,
  loading: false,
});

function resetStats() {
  stats.value.totalTeams = 0;
  stats.value.teamsNamed = 0;
  stats.value.teamsInPool = 0;
  stats.value.poolMatches = 0;
  stats.value.bracketMatches = 0;
}

async function loadStats() {
  if (!session.tournament) {
    resetStats();
    return;
  }
  stats.value.loading = true;
  try {
    const tId = session.tournament.id;

    const { data: teams, error: tErr } = await supabase
      .from('teams')
      .select('full_team_name, pool_id')
      .eq('tournament_id', tId);

    if (!tErr && teams) {
      stats.value.totalTeams = teams.length;
      stats.value.teamsInPool = teams.filter((t) => !!t.pool_id).length;
      stats.value.teamsNamed = teams.filter((t) => (t.full_team_name || '').trim().length > 0).length;
    }

    const { count: poolCount } = await supabase
      .from('matches')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', tId)
      .eq('match_type', 'pool');

    stats.value.poolMatches = poolCount || 0;

    const { count: bracketCount } = await supabase
      .from('matches')
      .select('*', { count: 'exact', head: true })
      .eq('tournament_id', tId)
      .eq('match_type', 'bracket');

    stats.value.bracketMatches = bracketCount || 0;
  } catch (err: any) {
    console.error('Failed to load dashboard stats:', err);
    toast.add({
      severity: 'error',
      summary: 'Stats failed to load',
      detail: err?.message ?? 'Unknown error',
      life: 3000,
    });
  } finally {
    stats.value.loading = false;
  }
}

async function onTournamentListStatsRefresh() {
  await loadStats();
}

type NavItem = {
  to: any | null;
  title: string;
  desc: string;
  icon: string;
  disabled?: boolean;
  badge?: string | number;
  badgeSeverity?: 'success' | 'warn' | 'danger' | 'info';
};

const navItems = computed<NavItem[]>(() => {
  const s = stats.value;
  const hasTournament = !!session.tournament;

  const unpooled = s.totalTeams - s.teamsInPool;

  const needsTournament = (item: Omit<NavItem, 'disabled' | 'desc'> & { desc: string }): NavItem => ({
    ...item,
    desc: hasTournament ? item.desc : 'Use View on a tournament in the list above.',
    disabled: !hasTournament,
  });

  return [
    {
      to: { name: 'admin-tournament-setup' },
      title: 'Tournament Setup',
      desc: 'Create new tournaments or edit rules in the form.',
      icon: 'pi-cog',
    },
    needsTournament({
      to: { name: 'admin-players-import' },
      title: 'Players Import',
      desc: 'Upload CSV or add/remove teams manually.',
      icon: 'pi-upload',
      badge: hasTournament ? (s.totalTeams > 0 ? 'Ready' : undefined) : undefined,
      badgeSeverity: 'success',
    }),
    needsTournament({
      to: { name: 'admin-pools-seeds' },
      title: 'Pools & Seeds',
      desc: 'Assign teams to pools; set seeds.',
      icon: 'pi-sort-alt',
      badge: hasTournament
        ? unpooled > 0
          ? `${unpooled} unassigned`
          : s.totalTeams > 0
            ? 'Ready'
            : undefined
        : undefined,
      badgeSeverity: unpooled > 0 ? 'warn' : 'success',
    }),
    needsTournament({
      to: { name: 'admin-schedule-templates' },
      title: 'Schedule Templates',
      desc: 'Define templates for 3–6 team pools.',
      icon: 'pi-table',
    }),
    needsTournament({
      to: { name: 'admin-generate-schedule' },
      title: 'Generate Schedule',
      desc: 'Run prerequisites and create pool-play matches.',
      icon: 'pi-cog',
      badge: hasTournament ? (s.poolMatches > 0 ? 'Generated' : 'Not Started') : undefined,
      badgeSeverity: s.poolMatches > 0 ? 'success' : 'info',
    }),
    needsTournament({
      to: { name: 'admin-bracket' },
      title: 'Bracket',
      desc: 'Generate or manage playoff bracket.',
      icon: 'pi-sitemap',
      badge: hasTournament ? (s.bracketMatches > 0 ? 'Generated' : undefined) : undefined,
      badgeSeverity: s.bracketMatches > 0 ? 'success' : undefined,
    }),
  ];
});

const activeTitle = computed(() => {
  if (restoringTournament.value) return 'Loading…';
  if (session.tournament) return session.tournament.name;
  return 'None selected';
});

const activeSubtitle = computed(() =>
  session.tournament ? '' : 'Choose a tournament below and use View to activate it.'
);

onMounted(async () => {
  await session.refreshAdminUser();
  await restoreAdminTournament();
  if (session.tournament) await loadStats();
  else resetStats();
});
</script>

<template>
  <div class="admin-dashboard-shell min-h-dvh flex flex-col bg-[#0b1120] text-slate-100">
    <!-- Top navigation -->
    <header
      class="w-full shrink-0 border-b border-slate-700/60 bg-slate-800/90 shadow-sm shadow-black/20 backdrop-blur-md"
    >
      <div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div class="min-w-0">
          <div class="truncate text-lg font-bold tracking-tight text-white sm:text-xl">
            GT Beach Volleyball
            <span
              class="ml-2 inline-block rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-amber-400/95"
            >
              Admin
            </span>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-1 sm:gap-2">
          <Menu as="div" class="relative z-50 text-left">
            <MenuButton
              type="button"
              class="inline-flex max-w-[min(100vw-8rem,16rem)] items-center gap-2 rounded-lg border border-slate-600/80 bg-slate-800/80 px-3 py-2 text-left text-sm text-slate-100 shadow-sm transition hover:border-amber-500/35 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50 sm:max-w-xs"
            >
              <span class="truncate font-medium">{{ adminEmail }}</span>
              <ChevronDownIcon class="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
            </MenuButton>

            <transition
              enter-active-class="transition duration-100 ease-out"
              enter-from-class="scale-95 opacity-0"
              enter-to-class="scale-100 opacity-100"
              leave-active-class="duration-75 ease-in"
              leave-from-class="scale-100 opacity-100"
              leave-to-class="scale-95 opacity-0"
            >
              <MenuItems
                class="absolute right-0 z-50 mt-2 w-56 origin-top-right rounded-xl border border-slate-700/90 bg-slate-900 py-1 shadow-xl shadow-black/40 ring-1 ring-black/20 focus:outline-none"
              >
                <div class="border-b border-slate-800 px-3 py-2">
                  <p class="text-xs font-medium uppercase tracking-wide text-slate-500">Signed in as</p>
                  <p class="truncate text-sm text-slate-200">{{ adminEmail }}</p>
                </div>
                <MenuItem v-slot="{ active }">
                  <button
                    type="button"
                    class="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-slate-200"
                    :class="active ? 'bg-slate-800 text-white' : ''"
                    @click="signOut"
                  >
                    <ArrowRightStartOnRectangleIcon class="h-5 w-5 text-slate-400" aria-hidden="true" />
                    <span>Log out</span>
                  </button>
                </MenuItem>
              </MenuItems>
            </transition>
          </Menu>
        </div>
      </div>
    </header>

    <div class="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <p class="text-base font-medium text-slate-400 sm:text-lg">Tournament setup and day-of operations</p>
      <h1 class="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl lg:text-5xl">Admin Dashboard</h1>

      <!-- Active tournament hero -->
      <div
        class="admin-hero-card relative mt-8 overflow-hidden rounded-2xl border border-slate-600/45 bg-gradient-to-br from-slate-800/90 via-slate-800/75 to-[#1a2740]/95 p-6 shadow-xl shadow-black/30 sm:p-8"
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
                class="font-['Plus_Jakarta_Sans',system-ui,sans-serif] text-3xl font-extrabold leading-tight text-white sm:text-4xl lg:text-[2.35rem]"
              >
                {{ activeTitle }}
              </h2>

              <div
                v-if="session.tournament"
                class="mt-5 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-slate-600/40 bg-slate-800/40 px-2.5 py-1.5 sm:gap-x-3"
              >
                <div class="flex flex-wrap items-baseline gap-x-1.5 leading-tight">
                  <span class="text-sm font-medium text-slate-300 sm:text-base">Public access code:</span>
                  <span class="font-mono text-sm font-bold tracking-wide text-white sm:text-base">
                    {{ session.tournament.access_code }}
                  </span>
                </div>
                <button
                  type="button"
                  class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-500/45 bg-slate-700/50 px-2.5 py-1.5 text-sm font-medium text-slate-100 transition hover:border-amber-500/35 hover:bg-slate-700/70 hover:text-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
                  @click="copyAccessCode"
                >
                  <CheckIcon v-if="copyFeedback" class="h-4 w-4 text-emerald-400" aria-hidden="true" />
                  <ClipboardDocumentIcon v-else class="h-4 w-4 text-slate-300" aria-hidden="true" />
                  <span>{{ copyFeedback ? 'Copied!' : 'Copy code' }}</span>
                </button>
              </div>
            </div>

            <div
              v-if="session.tournament"
              class="flex w-full shrink-0 flex-col gap-5 rounded-xl border border-slate-600/40 bg-slate-800/45 px-5 py-4 sm:min-w-[12rem] lg:mt-0 lg:w-auto lg:max-w-[15rem] lg:rounded-none lg:border-0 lg:border-l-2 lg:border-solid lg:border-slate-500/45 lg:bg-transparent lg:px-0 lg:pb-0 lg:pl-8 lg:pt-0"
            >
              <div>
                <div class="text-sm font-semibold uppercase tracking-wide text-slate-300">Date range</div>
                <div class="mt-1 text-lg font-semibold text-white">
                  {{ formatEventDateRange(session.tournament.date) }}
                </div>
              </div>
              <div>
                <div class="text-sm font-semibold uppercase tracking-wide text-slate-300">Teams</div>
                <div class="mt-1 flex items-baseline gap-2">
                  <span class="text-2xl font-bold tabular-nums text-white">
                    {{ stats.loading ? '…' : stats.totalTeams }}
                  </span>
                  <span v-if="!stats.loading" class="text-base text-slate-300">registered</span>
                </div>
              </div>
            </div>
          </div>

          <p v-if="activeSubtitle" class="max-w-xl text-sm text-slate-400">
            {{ activeSubtitle }}
          </p>
        </div>
      </div>

      <!-- Your tournaments -->
      <section class="mt-10">
        <h2 class="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Your Tournaments</h2>
        <p class="mt-2 max-w-3xl text-base leading-relaxed text-slate-400 sm:text-lg">
          Upcoming events first. Use the actions to work with each tournament.
        </p>

        <div
          class="admin-tournaments-table-wrap mt-4 overflow-hidden rounded-xl border border-slate-600/45 bg-slate-800/50 p-1 sm:p-2"
        >
          <AdminTournamentListPanel variant="dashboard" @stats-refresh="onTournamentListStatsRefresh" />
        </div>
      </section>

      <!-- Action grid -->
      <section class="mt-10">
        <h2 class="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Quick Actions</h2>
        <p class="mt-2 max-w-3xl text-base leading-relaxed text-slate-400 sm:text-lg">
          Jump to setup, pools, schedule, and bracket tools.
        </p>

        <div class="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
          <div
            v-for="it in navItems"
            :key="it.title"
            class="overflow-hidden rounded-xl border border-slate-600/45 bg-slate-800/50 shadow-lg shadow-black/25 transition hover:border-amber-500/25 hover:shadow-xl hover:shadow-black/35"
          >
            <UiListItem
              cohesive
              standaloneCard
              :title="it.title"
              :description="it.desc"
              :to="it.to"
              :icon="it.icon"
              :disabled="it.disabled"
              :badge="it.badge"
              :badgeSeverity="it.badgeSeverity"
            />
          </div>
        </div>
      </section>

      <div class="mt-10 border-t border-slate-800 pt-6 text-sm text-slate-500">
        Public site:
        <router-link
          class="font-medium text-amber-400/90 underline decoration-amber-500/40 underline-offset-2 hover:text-amber-300"
          :to="{ name: 'tournament-public' }"
        >
          Tournament view
        </router-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
.admin-hero-card {
  box-shadow:
    0 0 0 1px rgba(251, 191, 36, 0.06),
    0 25px 50px -12px rgba(0, 0, 0, 0.5);
}
</style>
