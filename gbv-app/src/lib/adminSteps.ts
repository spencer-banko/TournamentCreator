/**
 * The admin workflow, in the order a tournament is run, and the pure rules that turn tournament
 * counts into a status + short hint for each step. Used by the admin sidebar, the Previous/Next
 * bar and the Home progress checklist.
 */

export type StepId = 'setup' | 'teams' | 'pools' | 'schedule' | 'brackets';
export type StepStatus = 'done' | 'progress' | 'attention' | 'todo';

export type StepDef = { id: StepId; title: string; routeName: string; icon: string };

export const ADMIN_STEPS: StepDef[] = [
  { id: 'setup', title: 'Setup', routeName: 'admin-tournament-setup', icon: 'pi-cog' },
  { id: 'teams', title: 'Teams', routeName: 'admin-players-import', icon: 'pi-users' },
  { id: 'pools', title: 'Pools & Seeds', routeName: 'admin-pools-seeds', icon: 'pi-sort-alt' },
  { id: 'schedule', title: 'Pool Schedule', routeName: 'admin-pool-matches', icon: 'pi-calendar' },
  { id: 'brackets', title: 'Brackets', routeName: 'admin-bracket', icon: 'pi-sitemap' },
];

export type ProgressStats = {
  hasTournament: boolean;
  teams: number;
  teamsInPool: number;
  pools: number;
  poolMatches: number;
  poolScored: number;
  /** Problems that would block generating the pool schedule (only checked before generation). */
  scheduleIssues: number;
  bracketMatches: number;
  /** Bracket matches still to be decided (byes excluded). */
  bracketOpen: number;
};

export const EMPTY_STATS: ProgressStats = {
  hasTournament: false,
  teams: 0,
  teamsInPool: 0,
  pools: 0,
  poolMatches: 0,
  poolScored: 0,
  scheduleIssues: 0,
  bracketMatches: 0,
  bracketOpen: 0,
};

export type StepState = { status: StepStatus; hint: string };

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function stepState(id: StepId, s: ProgressStats): StepState {
  switch (id) {
    case 'setup':
      return s.hasTournament ? { status: 'done', hint: 'Details & rules' } : { status: 'todo', hint: 'Create or pick one' };
    case 'teams':
      if (s.teams >= 2) return { status: 'done', hint: plural(s.teams, 'team') };
      if (s.teams === 1) return { status: 'progress', hint: '1 team' };
      return { status: 'todo', hint: 'No teams yet' };
    case 'pools': {
      if (s.teams === 0) return { status: 'todo', hint: 'Add teams first' };
      if (s.pools === 0) return { status: 'todo', hint: 'No pools yet' };
      const unassigned = s.teams - s.teamsInPool;
      if (unassigned > 0) return { status: 'attention', hint: `${unassigned} unassigned` };
      return { status: 'done', hint: plural(s.pools, 'pool') };
    }
    case 'schedule':
      if (s.poolMatches === 0) {
        if (s.pools > 0 && s.scheduleIssues > 0) return { status: 'attention', hint: plural(s.scheduleIssues, 'issue') };
        return { status: 'todo', hint: 'Not generated' };
      }
      if (s.poolScored >= s.poolMatches) return { status: 'done', hint: `All ${s.poolMatches} scored` };
      return { status: 'progress', hint: `${s.poolScored}/${s.poolMatches} scored` };
    case 'brackets':
      if (s.bracketMatches === 0) return { status: 'todo', hint: 'Not generated' };
      if (s.bracketOpen === 0) return { status: 'done', hint: 'Complete' };
      return { status: 'progress', hint: `${plural(s.bracketOpen, 'match', 'matches')} left` };
  }
}

/** The step to continue with: the first one that isn't done (or the last step when all are). */
export function nextStep(s: ProgressStats): StepDef {
  return ADMIN_STEPS.find((d) => stepState(d.id, s).status !== 'done') ?? ADMIN_STEPS[ADMIN_STEPS.length - 1]!;
}

export function stepForRoute(routeName: string | null | undefined): StepDef | null {
  return ADMIN_STEPS.find((d) => d.routeName === routeName) ?? null;
}
