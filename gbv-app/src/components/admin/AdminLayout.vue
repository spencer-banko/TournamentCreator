<script setup lang="ts">
/**
 * Shell for every admin page: header (tournament switcher + account), a left sidebar with the
 * tournament workflow steps and their status, and a Previous/Next bar on step pages.
 * It is the single place that decides which tournament the admin is working on.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router';
import { Menu, MenuButton, MenuItems, MenuItem } from '@headlessui/vue';
import { ChevronDownIcon, ArrowRightStartOnRectangleIcon } from '@heroicons/vue/24/outline';
import supabase from '../../lib/supabase';
import { brand } from '../../lib/brand';
import { useSessionStore } from '../../stores/session';
import { useAdminProgressStore } from '../../stores/adminProgress';
import { ADMIN_STEPS, stepForRoute, type StepStatus } from '../../lib/adminSteps';
import type { Tournament } from '../../types/db';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const progress = useAdminProgressStore();

const ready = ref(false);
const tournaments = ref<Tournament[]>([]);
const mobileNavOpen = ref(false);
const headerEl = ref<HTMLElement | null>(null);
const headerH = ref(0);
function toggleMobileNav() {
  headerH.value = headerEl.value?.offsetHeight ?? 0;
  mobileNavOpen.value = !mobileNavOpen.value;
}

const adminEmail = computed(() => session.adminUser?.email?.trim() || 'Admin');
const activeId = computed(() => session.tournament?.id ?? null);
const currentStep = computed(() => stepForRoute(route.name as string));
const currentIndex = computed(() => (currentStep.value ? ADMIN_STEPS.findIndex((s) => s.id === currentStep.value!.id) : -1));
const prevStep = computed(() => (currentIndex.value > 0 ? progress.steps[currentIndex.value - 1] : null));
const nextStepDef = computed(() => (currentIndex.value >= 0 && currentIndex.value < ADMIN_STEPS.length - 1 ? progress.steps[currentIndex.value + 1] : null));
const currentDone = computed(() => (currentIndex.value >= 0 ? progress.steps[currentIndex.value]?.status === 'done' : false));

/** Tool pages that need an active tournament (Setup can create one, Home picks one). */
const needsTournament = computed(() => {
  const name = route.name as string;
  return name !== 'admin-dashboard' && name !== 'admin-tournament-setup';
});

function stepTo(routeName: string): RouteLocationRaw {
  if (routeName === 'admin-tournament-setup' && activeId.value) return { name: routeName, query: { edit: activeId.value } };
  return { name: routeName };
}

function stepEnabled(routeName: string) {
  return routeName === 'admin-tournament-setup' || !!activeId.value;
}

const statusIcon: Record<StepStatus, string> = {
  done: 'pi-check-circle text-emerald-400',
  progress: 'pi-circle-fill text-sky-400',
  attention: 'pi-exclamation-triangle text-amber-400',
  todo: 'pi-circle text-tone-500',
};

/** Make session.tournament match the persisted active tournament before any page renders. */
async function syncActiveTournament() {
  session.initFromStorage();
  const id = session.getAdminActiveTournamentId();
  if (id) {
    if (session.tournament?.id !== id) await session.loadAdminTournamentById(id);
  } else if (session.tournament) {
    // A tournament loaded some other way (e.g. by access code) becomes the active one.
    session.setAdminActiveTournament(session.tournament as Tournament);
  }
}

async function loadTournaments() {
  const { data } = await supabase.from('tournaments').select('*').order('date', { ascending: false });
  tournaments.value = (data ?? []) as Tournament[];
}

function switchTournament(t: Tournament) {
  if (t.id === activeId.value) return;
  session.setAdminActiveTournament(t);
}

async function signOut() {
  await session.signOutAdmin();
  router.replace({ name: 'admin-login' });
}

watch(activeId, () => void progress.refresh());
const removeAfterEach = router.afterEach((to) => {
  mobileNavOpen.value = false;
  if (String(to.name ?? '').startsWith('admin-')) void progress.refresh();
});
onBeforeUnmount(removeAfterEach);

onMounted(async () => {
  await session.refreshAdminUser();
  await syncActiveTournament();
  ready.value = true;
  void progress.refresh();
  void loadTournaments();
});

defineExpose({ loadTournaments });
</script>

<template>
  <div class="flex min-h-dvh flex-col gbv-page-bg text-tone-100">
    <!-- Header -->
    <header ref="headerEl" class="sticky top-0 z-40 w-full shrink-0 border-b border-tone-700/60 gbv-header-bg shadow-sm shadow-black/20 backdrop-blur-md">
      <div class="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <router-link :to="{ name: 'admin-dashboard' }" class="flex min-w-0 items-center gap-3">
          <img :src="brand.logoUrl" :alt="brand.appName" class="h-8 w-auto shrink-0 drop-shadow-md" />
          <span class="hidden truncate text-lg font-bold tracking-tight text-ink md:inline">{{ brand.appName }}</span>
          <span class="rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-amber-400/95">Admin</span>
        </router-link>

        <div class="flex min-w-0 items-center gap-2">
          <!-- Tournament switcher -->
          <Menu as="div" class="relative min-w-0">
            <MenuButton
              class="inline-flex max-w-[min(55vw,20rem)] items-center gap-2 rounded-lg border border-tone-600/80 bg-tone-800/80 px-3 py-2 text-left text-sm text-tone-100 shadow-sm transition hover:border-amber-500/35 hover:bg-tone-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
              @click="loadTournaments"
            >
              <i class="pi pi-trophy shrink-0 text-xs text-tone-400" aria-hidden="true" />
              <span class="truncate font-semibold">{{ session.tournament?.name ?? 'Choose tournament' }}</span>
              <ChevronDownIcon class="h-4 w-4 shrink-0 text-tone-400" aria-hidden="true" />
            </MenuButton>
            <MenuItems class="absolute right-0 z-50 mt-2 max-h-[70vh] w-72 origin-top-right overflow-auto rounded-xl border border-tone-700/90 bg-tone-900 py-1 shadow-xl shadow-black/40 focus:outline-none">
              <div class="px-3 py-2 text-xs font-medium uppercase tracking-wide text-tone-500">Switch tournament</div>
              <MenuItem v-for="t in tournaments" :key="t.id" v-slot="{ active }">
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                  :class="[active ? 'bg-tone-800 text-ink' : 'text-tone-200', t.id === activeId ? 'font-semibold' : '']"
                  @click="switchTournament(t)"
                >
                  <i class="pi w-4 text-xs" :class="t.id === activeId ? 'pi-check text-emerald-400' : ''" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate">{{ t.name }}</span>
                  <span class="shrink-0 text-xs tabular-nums text-tone-500">{{ t.date }}</span>
                </button>
              </MenuItem>
              <div v-if="!tournaments.length" class="px-3 py-2 text-sm text-tone-400">No tournaments yet.</div>
              <div class="mt-1 border-t border-tone-800 pt-1">
                <MenuItem v-slot="{ active }">
                  <router-link
                    :to="{ name: 'admin-tournament-setup' }"
                    class="flex items-center gap-2 px-3 py-2 text-sm"
                    :class="active ? 'bg-tone-800 text-ink' : 'text-tone-300'"
                  >
                    <i class="pi pi-plus w-4 text-xs" aria-hidden="true" />New tournament
                  </router-link>
                </MenuItem>
              </div>
            </MenuItems>
          </Menu>

          <!-- Account -->
          <Menu as="div" class="relative shrink-0">
            <MenuButton
              class="inline-flex items-center gap-1 rounded-lg border border-tone-600/80 bg-tone-800/80 px-2.5 py-2 text-sm text-tone-100 transition hover:bg-tone-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50"
              aria-label="Account menu"
            >
              <i class="pi pi-user text-xs" aria-hidden="true" />
              <ChevronDownIcon class="h-4 w-4 text-tone-400" aria-hidden="true" />
            </MenuButton>
            <MenuItems class="absolute right-0 z-50 mt-2 w-56 origin-top-right rounded-xl border border-tone-700/90 bg-tone-900 py-1 shadow-xl shadow-black/40 focus:outline-none">
              <div class="border-b border-tone-800 px-3 py-2">
                <p class="text-xs font-medium uppercase tracking-wide text-tone-500">Signed in as</p>
                <p class="truncate text-sm text-tone-200">{{ adminEmail }}</p>
              </div>
              <MenuItem v-slot="{ active }">
                <button type="button" class="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-tone-200" :class="active ? 'bg-tone-800 text-ink' : ''" @click="signOut">
                  <ArrowRightStartOnRectangleIcon class="h-5 w-5 text-tone-400" aria-hidden="true" />
                  Log out
                </button>
              </MenuItem>
            </MenuItems>
          </Menu>
        </div>
      </div>

      <!-- Mobile: compact step menu -->
      <div class="border-t border-tone-700/50 px-4 py-2 lg:hidden">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm font-semibold text-ink hover:bg-tone-800/60"
          :aria-expanded="mobileNavOpen"
          @click="toggleMobileNav"
        >
          <span v-if="currentStep">Step {{ currentIndex + 1 }} of {{ ADMIN_STEPS.length }} · {{ currentStep.title }}</span>
          <span v-else-if="route.name === 'admin-schedule-templates'">Settings · Schedule Templates</span>
          <span v-else>Home</span>
          <ChevronDownIcon class="h-4 w-4 text-tone-400 transition" :class="mobileNavOpen ? 'rotate-180' : ''" aria-hidden="true" />
        </button>
      </div>
    </header>

    <div class="flex flex-1">
      <!-- Sidebar (desktop) / dropdown (mobile) share this nav -->
      <!-- Mobile backdrop: tap outside the step menu to close it -->
      <div
        v-if="mobileNavOpen"
        class="fixed inset-0 z-20 bg-black/30 lg:hidden"
        :style="{ top: `${headerH}px` }"
        aria-hidden="true"
        @click="mobileNavOpen = false"
      />
      <nav
        aria-label="Tournament steps"
        class="admin-steps-nav border-tone-700/60"
        :class="mobileNavOpen ? 'gbv-page-bg fixed inset-x-0 z-30 block max-h-[75vh] overflow-y-auto border-b shadow-xl lg:static lg:max-h-none' : 'hidden bg-tone-900/40 lg:block'"
        :style="mobileNavOpen ? { top: `${headerH}px` } : undefined"
      >
        <div class="flex flex-col gap-1 p-3 lg:sticky lg:top-[4.25rem]">
          <router-link
            :to="{ name: 'admin-dashboard' }"
            class="step-link"
            :class="route.name === 'admin-dashboard' ? 'step-link--active' : ''"
          >
            <i class="pi pi-home w-5 text-center text-tone-400" aria-hidden="true" />
            <span class="flex-1 font-semibold">Home</span>
          </router-link>

          <div class="mt-3 px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-tone-500">Run the tournament</div>
          <template v-for="(s, i) in progress.steps" :key="s.id">
            <router-link
              v-if="stepEnabled(s.routeName)"
              :to="stepTo(s.routeName)"
              class="step-link"
              :class="route.name === s.routeName ? 'step-link--active' : ''"
              :aria-current="route.name === s.routeName ? 'step' : undefined"
            >
              <span class="step-num">{{ i + 1 }}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate font-semibold">{{ s.title }}</span>
                <span v-if="activeId" class="block truncate text-xs text-tone-400">{{ s.hint }}</span>
              </span>
              <i v-if="activeId" class="pi text-sm" :class="statusIcon[s.status]" :aria-label="s.status" />
            </router-link>
            <span v-else class="step-link cursor-not-allowed opacity-50" title="Choose a tournament first">
              <span class="step-num">{{ i + 1 }}</span>
              <span class="flex-1 truncate font-semibold">{{ s.title }}</span>
            </span>
          </template>

          <div class="mt-4 px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-tone-500">Settings</div>
          <router-link
            v-if="activeId"
            :to="{ name: 'admin-schedule-templates' }"
            class="step-link"
            :class="route.name === 'admin-schedule-templates' ? 'step-link--active' : ''"
          >
            <i class="pi pi-table w-5 text-center text-tone-400" aria-hidden="true" />
            <span class="flex-1 font-semibold">Schedule Templates</span>
          </router-link>
          <router-link :to="{ name: 'tournament-public' }" class="step-link">
            <i class="pi pi-external-link w-5 text-center text-tone-400" aria-hidden="true" />
            <span class="flex-1 font-semibold">Public site</span>
          </router-link>
        </div>
      </nav>

      <!-- Content -->
      <main class="flex min-w-0 flex-1 flex-col">
        <div class="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
          <div v-if="!ready" class="py-10 text-sm text-tone-400">Loading…</div>
          <div
            v-else-if="needsTournament && !activeId"
            class="mx-auto mt-10 max-w-md rounded-2xl border border-tone-600/45 bg-tone-800/50 p-6 text-center"
          >
            <i class="pi pi-trophy text-3xl text-tone-400" aria-hidden="true" />
            <h2 class="mt-3 text-lg font-bold text-ink">Choose a tournament first</h2>
            <p class="mt-1 text-sm text-tone-400">Pick one from the switcher above, or from the list on Home.</p>
            <router-link :to="{ name: 'admin-dashboard' }" class="mt-4 inline-flex rounded-full bg-amber-500 px-5 py-2 text-sm font-semibold text-white">Go to Home</router-link>
          </div>
          <router-view v-else :key="route.name === 'admin-dashboard' ? 'home' : `${String(route.name)}:${activeId ?? 'none'}`" />
        </div>

        <!-- Previous / Next -->
        <div
          v-if="ready && currentStep && activeId"
          class="sticky bottom-0 z-20 border-t border-tone-700/60 gbv-header-bg backdrop-blur-md"
        >
          <div class="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <router-link
              v-if="prevStep"
              :to="stepTo(prevStep.routeName)"
              class="inline-flex min-w-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-tone-200 transition hover:bg-tone-800/70"
            >
              <i class="pi pi-arrow-left text-xs" aria-hidden="true" />
              <span class="truncate">{{ prevStep.title }}</span>
            </router-link>
            <router-link
              v-else
              :to="{ name: 'admin-dashboard' }"
              class="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-tone-200 transition hover:bg-tone-800/70"
            >
              <i class="pi pi-home text-xs" aria-hidden="true" />Home
            </router-link>

            <span class="hidden text-xs text-tone-500 sm:inline">Step {{ currentIndex + 1 }} of {{ ADMIN_STEPS.length }}</span>

            <router-link
              v-if="nextStepDef"
              :to="stepTo(nextStepDef.routeName)"
              class="inline-flex min-w-0 items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition"
              :class="currentDone ? 'bg-amber-500 text-white shadow hover:bg-amber-600' : 'border border-tone-600/70 text-tone-200 hover:bg-tone-800/70'"
            >
              <span class="truncate">Next: {{ nextStepDef.title }}</span>
              <i class="pi pi-arrow-right text-xs" aria-hidden="true" />
            </router-link>
            <router-link
              v-else
              :to="{ name: 'admin-dashboard' }"
              class="inline-flex items-center gap-2 rounded-full border border-tone-600/70 px-5 py-2.5 text-sm font-semibold text-tone-200 hover:bg-tone-800/70"
            >
              Back to Home<i class="pi pi-home text-xs" aria-hidden="true" />
            </router-link>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
@media (min-width: 1024px) {
  .admin-steps-nav {
    width: 16rem;
    flex-shrink: 0;
    border-right-width: 1px;
  }
}
.step-link {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  border-radius: 0.75rem;
  padding: 0.6rem 0.75rem;
  font-size: 0.9rem;
  color: var(--color-tone-200);
  transition: background-color 0.15s ease, color 0.15s ease;
}
a.step-link:hover {
  background-color: rgba(var(--ink-rgb), 0.06);
  color: var(--color-ink);
}
.step-link--active {
  background-color: color-mix(in srgb, var(--color-amber-500) 14%, transparent);
  color: var(--color-ink);
  box-shadow: inset 3px 0 0 var(--color-amber-500);
}
.step-num {
  display: inline-flex;
  height: 1.5rem;
  width: 1.5rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  border: 1px solid rgba(var(--ink-rgb), 0.2);
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--color-tone-300);
}
.step-link--active .step-num {
  border-color: var(--color-amber-500);
  background-color: var(--color-amber-500);
  color: #fff;
}
</style>
