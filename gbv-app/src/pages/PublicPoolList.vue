<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import PublicLayout from '../components/layout/PublicLayout.vue';
import UiBackButton from '../components/ui/UiBackButton.vue';

type Pool = {
  id: string;
  tournament_id: string;
  name: string;
  court_assignment: string | null;
};

type TeamSeed = {
  id: string;
  pool_id: string | null;
  seed_in_pool: number | null;
  full_team_name: string;
};

const route = useRoute();
const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const loading = ref(false);
const pools = ref<Pool[]>([]);
const seededFirstNamesByPoolId = ref<Record<string, string[]>>({});
const hasBracket = computed(() => {
  const t = session.tournament;
  return !!t && (t.status === 'bracket' || t.status === 'completed' || !!t.bracket_generated_at);
});

async function ensureTournament() {
  if (!accessCode.value) return;
  await session.ensureAnon();
  if (!session.tournament) {
    const t = await session.loadTournamentByCode(accessCode.value);
    if (!t) {
      toast.add({ severity: 'warn', summary: 'Not found', detail: 'Invalid tournament code', life: 2500 });
    }
  }
}

async function loadPools() {
  if (!session.tournament) {
    pools.value = [];
    return;
  }
  const { data, error } = await supabase
    .from('pools')
    .select('*')
    .eq('tournament_id', session.tournament.id)
    .order('name', { ascending: true });

  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load pools', detail: error.message, life: 3000 });
    pools.value = [];
    return;
  }
  pools.value = (data as Pool[]) ?? [];
}

function firstNameFromFullName(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/\s+/);
  return parts[0] ?? '';
}

async function loadSeededPlayersForPools() {
  if (!session.tournament || pools.value.length === 0) {
    seededFirstNamesByPoolId.value = {};
    return;
  }

  const poolIds = pools.value.map((p) => p.id).filter(Boolean);
  if (poolIds.length === 0) {
    seededFirstNamesByPoolId.value = {};
    return;
  }

  const { data, error } = await supabase
    .from('teams')
    .select('id,pool_id,seed_in_pool,full_team_name')
    .eq('tournament_id', session.tournament.id)
    .in('pool_id', poolIds)
    .order('seed_in_pool', { ascending: true });

  if (error) {
    seededFirstNamesByPoolId.value = {};
    return;
  }

  const byPool: Record<string, TeamSeed[]> = {};
  for (const t of ((data as TeamSeed[]) ?? [])) {
    if (!t.pool_id) continue;
    if (t.seed_in_pool == null) continue;
    (byPool[t.pool_id] ??= []).push(t);
  }

  const res: Record<string, string[]> = {};
  for (const [pid, arr] of Object.entries(byPool)) {
    arr.sort((a, b) => (a.seed_in_pool ?? 9999) - (b.seed_in_pool ?? 9999));
    const names = arr
      .map((t) => firstNameFromFullName(t.full_team_name))
      .filter(Boolean);
    res[pid] = names;
  }
  seededFirstNamesByPoolId.value = res;
}

function openPool(poolId: string) {
  router.push({ name: 'public-pool-details', params: { accessCode: accessCode.value, poolId } });
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  loading.value = true;
  try {
    await ensureTournament();
    await loadPools();
    await loadSeededPlayersForPools();
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <PublicLayout>
    <section class="p-5 sm:p-7">
        <div class="mb-4 flex items-center gap-2 rounded-xl border border-slate-600/45 bg-slate-800/45 p-2">
          <router-link
            :to="{ name: 'public-pool-list', params: { accessCode } }"
            class="inline-flex items-center rounded-lg px-3 py-2 text-sm font-semibold transition-colors"
            :class="'bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/35'"
          >
            Pool Play
          </router-link>
          <router-link
            v-if="hasBracket"
            :to="{ name: 'public-bracket', params: { accessCode } }"
            class="inline-flex items-center rounded-lg px-3 py-2 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-700/60"
          >
            Bracket
          </router-link>
          <button
            v-else
            type="button"
            class="inline-flex cursor-not-allowed items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-slate-400 ring-1 ring-slate-500/35"
            @click.prevent
          >
            <i class="pi pi-lock text-xs" aria-hidden="true" />
            Bracket
          </button>
        </div>
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-start gap-3 min-w-0">
            <UiBackButton
              class="mt-0.5 shrink-0"
              :to="{ name: 'tournament-public', params: { accessCode } }"
              aria-label="Return to Tournament"
            />
            <div class="min-w-0">
              <h2 class="text-2xl font-semibold tracking-tight text-white">Pools</h2>
              <p class="mt-1 text-slate-400">
                Choose a pool to view standings and schedule.
              </p>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <router-link
              :to="{ name: 'public-leaderboard', params: { accessCode } }"
              class="inline-flex items-center whitespace-nowrap rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-300/95 transition-colors hover:border-amber-400/45 hover:bg-amber-500/15"
            >
              Leaderboard
            </router-link>
            <div v-if="loading" class="text-sm text-slate-400">Loading…</div>
          </div>
        </div>

        <div class="mt-6">
          <div v-if="pools.length === 0" class="text-sm text-slate-400">
            No pools yet.
          </div>
          <ul v-else class="grid gap-3 sm:grid-cols-2">
            <li
              v-for="p in pools"
              :key="p.id"
              class="cursor-pointer rounded-xl border border-slate-600/45 bg-slate-800/50 p-4 text-white shadow-lg shadow-black/25 transition-colors hover:border-amber-500/25 hover:bg-slate-800/65"
              @click="openPool(p.id)"
            >
              <div class="font-semibold">{{ p.name }}</div>
              <div class="text-sm text-slate-400">Court: {{ p.court_assignment || 'TBD' }}</div>
              <div v-if="seededFirstNamesByPoolId[p.id]?.length" class="mt-1 text-xs text-slate-500">
                Players: <span class="font-medium text-slate-300">{{ seededFirstNamesByPoolId[p.id].join(', ') }}</span>
              </div>
            </li>
          </ul>
        </div>
    </section>
  </PublicLayout>
</template>
