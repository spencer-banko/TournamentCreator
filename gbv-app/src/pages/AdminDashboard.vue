<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';
import UiListItem from '@/components/ui/UiListItem.vue';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import AdminTournamentListPanel from '@/components/admin/AdminTournamentListPanel.vue';
import supabase from '../lib/supabase';
import { useToast } from 'primevue/usetoast';

const router = useRouter();
const session = useSessionStore();
const toast = useToast();

async function signOut() {
  await session.signOutAdmin();
  router.replace({ name: 'admin-login' });
}

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

const leftItems = computed(() => {
  const all = navItems.value;
  const mid = Math.ceil(all.length / 2);
  return all.slice(0, mid);
});

const rightItems = computed(() => {
  const all = navItems.value;
  const mid = Math.ceil(all.length / 2);
  return all.slice(mid);
});

onMounted(async () => {
  await restoreAdminTournament();
  if (session.tournament) await loadStats();
  else resetStats();
});
</script>

<template>
  <section class="mx-auto w-full max-w-5xl px-4 py-6">
    <UiSectionHeading
      title="Admin Dashboard"
      subtitle="Tournament setup and day-of operations."
      :divider="true"
    >
      <button
        class="rounded-md border border-white/30 px-3 py-1.5 text-sm hover:bg-white/10"
        @click="signOut"
      >
        Sign Out
      </button>
    </UiSectionHeading>

    <div class="mb-6 rounded-xl border border-white/15 bg-white/5 p-4">
      <div class="flex flex-col gap-1">
        <div class="text-sm text-white/80">Active tournament</div>
        <div class="font-semibold truncate">
          {{
            restoringTournament
              ? 'Loading…'
              : session.tournament
                ? session.tournament.name
                : 'None selected — use View below'
          }}
        </div>
        <div v-if="session.tournament" class="text-sm text-white/80">
          Public access code:
          <span class="font-mono">{{ session.tournament.access_code }}</span>
        </div>
      </div>

      <div class="mt-4 border-t border-white/10 pt-4">
        <div class="mb-2 text-sm font-semibold text-white/90">Your tournaments</div>
        <AdminTournamentListPanel variant="dashboard" @stats-refresh="onTournamentListStatsRefresh" />
      </div>
    </div>

    <div class="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
      <div>
        <div class="rounded-lg border border-white/15 overflow-hidden">
          <UiListItem
            v-for="it in leftItems"
            :key="it.title"
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
      <div class="mt-6 lg:mt-0">
        <div class="rounded-lg border border-white/15 overflow-hidden">
          <UiListItem
            v-for="it in rightItems"
            :key="it.title"
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
    </div>

    <div class="mt-6 text-sm text-white/80">
      Public site:
      <router-link class="underline" :to="{ name: 'tournament-public' }">Tournament View</router-link>
    </div>
  </section>
</template>

<style scoped></style>
