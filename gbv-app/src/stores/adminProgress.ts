import { defineStore } from 'pinia';
import supabase from '../lib/supabase';
import { checkPrerequisites } from '../lib/schedule';
import { ADMIN_STEPS, EMPTY_STATS, stepState, type ProgressStats, type StepDef, type StepState } from '../lib/adminSteps';
import { useSessionStore } from './session';

/** Tournament counts behind the admin sidebar / Home checklist step statuses. */
export const useAdminProgressStore = defineStore('adminProgress', {
  state: () => ({
    stats: { ...EMPTY_STATS } as ProgressStats,
    loading: false,
    loadedFor: null as string | null,
  }),

  getters: {
    steps(state): Array<StepDef & StepState> {
      return ADMIN_STEPS.map((d) => ({ ...d, ...stepState(d.id, state.stats) }));
    },
  },

  actions: {
    /** Reload counts for the active tournament (call after anything that changes them). */
    async refresh() {
      const session = useSessionStore();
      const t = session.tournament;
      if (!t) {
        this.stats = { ...EMPTY_STATS };
        this.loadedFor = null;
        return;
      }
      const tid = t.id;
      this.loading = true;
      try {
        const [teams, pools, matches] = await Promise.all([
          supabase.from('teams').select('pool_id').eq('tournament_id', tid),
          supabase.from('pools').select('id', { count: 'exact', head: true }).eq('tournament_id', tid),
          supabase.from('matches').select('match_type,team1_id,team2_id,team1_score,winner_id').eq('tournament_id', tid),
        ]);
        // Ignore a stale response if the admin switched tournaments meanwhile.
        if (session.tournament?.id !== tid) return;

        const teamRows = (teams.data ?? []) as Array<{ pool_id: string | null }>;
        const matchRows = (matches.data ?? []) as Array<{
          match_type: string;
          team1_id: string | null;
          team2_id: string | null;
          team1_score: number | null;
          winner_id: string | null;
        }>;
        const pool = matchRows.filter((m) => m.match_type === 'pool');
        const bracket = matchRows.filter((m) => m.match_type === 'bracket');
        const isBye = (m: (typeof bracket)[number]) => (m.team1_id == null) !== (m.team2_id == null);

        const next: ProgressStats = {
          hasTournament: true,
          teams: teamRows.length,
          teamsInPool: teamRows.filter((r) => !!r.pool_id).length,
          pools: pools.count ?? 0,
          poolMatches: pool.length,
          poolScored: pool.filter((m) => m.team1_score != null).length,
          scheduleIssues: 0,
          bracketMatches: bracket.length,
          bracketOpen: bracket.filter((m) => m.winner_id == null && !isBye(m)).length,
        };

        // Only worth checking generation prerequisites while the schedule hasn't been generated.
        if (next.poolMatches === 0 && next.pools > 0) {
          try {
            const res = await checkPrerequisites(tid);
            next.scheduleIssues = res.errors?.length ?? 0;
          } catch {
            // leave as 0
          }
        }
        if (session.tournament?.id !== tid) return;
        this.stats = next;
        this.loadedFor = tid;
      } finally {
        this.loading = false;
      }
    },
  },
});
