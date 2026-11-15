/**
 * Pure standings + bracket-seeding logic shared by the bracket engine and the public pages,
 * so what players see in pool standings is exactly what decides Gold/Silver/Bronze placement.
 */
import type { AdvancementRules } from '../types/db';
import { teamStats, emptyStats, isCompleted, type ScoredMatch, type TeamStats } from './scoring';

export type Tiebreaker = NonNullable<AdvancementRules['tiebreakers']>[number];

/** Default: most wins, then total point differential (ECVA rule), then head-to-head, then set ratio. */
export const DEFAULT_TIEBREAKERS: Tiebreaker[] = ['point_diff', 'head_to_head', 'set_ratio'];

export type StandingTeam = {
  id: string;
  full_team_name: string;
  pool_id: string | null;
  seed_in_pool: number | null;
  seed_global?: number | null;
};

export type StandingMatch = ScoredMatch & { pool_id?: string | null };

export type Standing = TeamStats & {
  teamId: string;
  name: string;
  poolId: string | null;
  seed: number | null;
  seedGlobal: number | null;
  /** Set ratio = sets won / sets played (0 when none played). */
  setRatio: number;
  /** 1-based finishing place in the pool (filled by rankPool). */
  place: number;
  /** Legacy aliases used by existing templates. */
  wins: number;
  losses: number;
  setWon: number;
  setLost: number;
};

function headToHead(matches: StandingMatch[], aId: string, bId: string): number {
  let aWins = 0;
  let bWins = 0;
  for (const m of matches) {
    if (!isCompleted(m)) continue;
    const pair = (m.team1_id === aId && m.team2_id === bId) || (m.team1_id === bId && m.team2_id === aId);
    if (!pair) continue;
    if (m.winner_id === aId) aWins++;
    else if (m.winner_id === bId) bWins++;
  }
  if (aWins === bWins) return 0;
  return aWins > bWins ? -1 : 1;
}

/**
 * Rank one pool. Primary key: match wins. Then the configured tiebreakers in order.
 * Head-to-head is only applied when exactly two teams are tied on wins.
 */
export function rankPool(
  teams: StandingTeam[],
  matches: StandingMatch[],
  tiebreakers: Tiebreaker[] = DEFAULT_TIEBREAKERS
): Standing[] {
  const ids = new Set(teams.map((t) => t.id));
  const poolMatches = matches.filter((m) => (m.team1_id && ids.has(m.team1_id)) || (m.team2_id && ids.has(m.team2_id)));
  const stats = teamStats(poolMatches);
  const rows: Standing[] = teams.map((t) => {
    const s = stats.get(t.id) ?? emptyStats();
    const setsTotal = s.gameWins + s.gameLosses;
    return {
      ...s,
      teamId: t.id,
      name: t.full_team_name,
      poolId: t.pool_id,
      seed: t.seed_in_pool,
      seedGlobal: t.seed_global ?? null,
      setRatio: setsTotal > 0 ? s.gameWins / setsTotal : 0,
      place: 0,
      wins: s.matchWins,
      losses: s.matchLosses,
      setWon: s.gameWins,
      setLost: s.gameLosses,
    };
  });

  const order = tiebreakers.length ? tiebreakers : DEFAULT_TIEBREAKERS;
  rows.sort((a, b) => {
    if (b.matchWins !== a.matchWins) return b.matchWins - a.matchWins;
    for (const tb of order) {
      if (tb === 'point_diff') {
        if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
      } else if (tb === 'set_ratio') {
        if (b.setRatio !== a.setRatio) return b.setRatio - a.setRatio;
      } else if (tb === 'head_to_head') {
        const tied = rows.filter((x) => x.matchWins === a.matchWins);
        if (tied.length === 2) {
          const h = headToHead(poolMatches, a.teamId, b.teamId);
          if (h !== 0) return h;
        }
      }
      // 'random' falls through to the deterministic fallbacks below
    }
    if (a.seed != null && b.seed != null && a.seed !== b.seed) return a.seed - b.seed;
    return a.name.localeCompare(b.name);
  });
  rows.forEach((r, i) => (r.place = i + 1));
  return rows;
}

/** Rank every pool. Returns poolId -> standings (place filled). */
export function rankAllPools(
  teams: StandingTeam[],
  matches: StandingMatch[],
  tiebreakers: Tiebreaker[] = DEFAULT_TIEBREAKERS
): Map<string, Standing[]> {
  const byPool = new Map<string, StandingTeam[]>();
  for (const t of teams) {
    if (!t.pool_id) continue;
    const arr = byPool.get(t.pool_id) ?? [];
    arr.push(t);
    byPool.set(t.pool_id, arr);
  }
  const out = new Map<string, Standing[]>();
  for (const [poolId, poolTeams] of byPool) {
    const pm = matches.filter((m) => m.pool_id == null || m.pool_id === poolId);
    out.set(poolId, rankPool(poolTeams, pm, tiebreakers));
  }
  return out;
}

/**
 * Seed order for a bracket fed by the given pool places (1-based).
 * Seeding across pools: most game (set) wins, then total point differential,
 * then better pool finish, then original global seed, then name.
 */
export function seedForPlaces(standingsByPool: Map<string, Standing[]>, places: number[]): Standing[] {
  const wanted = new Set(places);
  const picked: Standing[] = [];
  for (const rows of standingsByPool.values()) {
    for (const r of rows) if (wanted.has(r.place)) picked.push(r);
  }
  picked.sort((a, b) => {
    if (b.gameWins !== a.gameWins) return b.gameWins - a.gameWins;
    if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
    if (a.place !== b.place) return a.place - b.place;
    if (a.seedGlobal != null && b.seedGlobal != null && a.seedGlobal !== b.seedGlobal) return a.seedGlobal - b.seedGlobal;
    return a.name.localeCompare(b.name);
  });
  return picked;
}

/** Next power of two >= n (min 2). Returns -1 when above max. */
export function bracketSizeFor(n: number, max = 64): number {
  if (n <= 2) return 2;
  let p = 2;
  while (p < n) p <<= 1;
  return p > max ? -1 : p;
}

/** Standard seed slot order, e.g. 8 -> [1,8,4,5,2,7,3,6]. */
export function seedSlotsForSize(B: number): number[] {
  if (B < 2 || (B & (B - 1)) !== 0) throw new Error(`seedSlotsForSize requires power-of-two, got ${B}`);
  if (B === 2) return [1, 2];
  const prev = seedSlotsForSize(B >> 1);
  const res: number[] = [];
  for (const s of prev) {
    res.push(s);
    res.push(B + 1 - s);
  }
  return res;
}

/**
 * Place seeded teams into bracket slots (standard order, byes to top seeds), then swap
 * lower seeds with their nearest neighbours so no first-round match is a same-pool rematch.
 * Top seeds stay put; a swap is only taken when it fixes the clash without creating a new one.
 * Returns one entry per slot (null = bye).
 */
export function placeSeedsAvoidingPoolRematches<T extends { poolId: string | null }>(seeds: T[], B: number): (T | null)[] {
  const order = seedSlotsForSize(B);
  const N = seeds.length;
  const list = seeds.slice();
  // Slot index of each seed number, and its first-round opponent seed (null for a bye).
  const slotOf = new Map(order.map((seed, i) => [seed, i]));
  const opp = (seed: number): number | null => {
    const o = order[slotOf.get(seed)! ^ 1];
    return o <= N ? o : null;
  };
  const clash = (a: number, b: number | null) =>
    b != null && list[a - 1].poolId != null && list[a - 1].poolId === list[b - 1].poolId;
  // Movable seeds: the lower-seeded side of a real first-round match.
  const movable = Array.from({ length: N }, (_, i) => i + 1).filter((s) => {
    const o = opp(s);
    return o != null && o < s;
  });

  for (let guard = 0; guard < N * N; guard++) {
    const t = movable.find((s) => clash(s, opp(s)));
    if (t == null) break;
    const candidates = movable.filter((u) => u !== t).sort((a, b) => Math.abs(a - t) - Math.abs(b - t) || a - b);
    let fixed = false;
    for (const u of candidates) {
      [list[t - 1], list[u - 1]] = [list[u - 1], list[t - 1]];
      if (!clash(t, opp(t)) && !clash(u, opp(u))) {
        fixed = true;
        break;
      }
      [list[t - 1], list[u - 1]] = [list[u - 1], list[t - 1]];
    }
    if (!fixed) break; // unavoidable (e.g. most teams from one pool); keep record order
  }
  return order.map((seed) => (seed <= N ? list[seed - 1] : null));
}

/** Name of a bracket round given total rounds, e.g. 4 rounds: R1 = "Round of 16", R4 = "Final". */
export function roundName(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - round + 1;
  if (fromEnd === 1) return 'Final';
  if (fromEnd === 2) return 'Semifinals';
  if (fromEnd === 3) return 'Quarterfinals';
  return `Round of ${2 ** fromEnd}`;
}
