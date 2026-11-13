/**
 * Pure scoring helpers (no Supabase): set validation, match results for single-set and
 * best-of-3 "match play", and per-team aggregate stats used by standings and bracket seeding.
 */
import type { MatchFormat, SetScore } from '../types/db';

export const DEFAULT_SINGLE_SET: MatchFormat = { bestOf: 1, setTargets: [21], cap: null, winBy2: true };
export const DEFAULT_MATCH_PLAY: MatchFormat = { bestOf: 3, setTargets: [21, 21, 15], cap: null, winBy2: true };

/** Normalise a possibly partial format coming from JSON. */
export function normalizeFormat(f: Partial<MatchFormat> | null | undefined, fallback: MatchFormat = DEFAULT_SINGLE_SET): MatchFormat {
  const bestOf = f?.bestOf === 3 ? 3 : f?.bestOf === 1 ? 1 : fallback.bestOf;
  const rawTargets = Array.isArray(f?.setTargets) ? f!.setTargets.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
  const targets = rawTargets.length ? rawTargets : fallback.setTargets;
  const cap = f?.cap == null || !Number.isFinite(Number(f.cap)) || Number(f.cap) <= 0 ? null : Number(f.cap);
  return { bestOf, setTargets: targets.slice(0, bestOf === 3 ? 3 : 1), cap, winBy2: f?.winBy2 !== false };
}

/** Build a format from match columns (best_of / set_targets). */
export function formatFromMatch(m: { best_of?: number | null; set_targets?: number[] | null }, fallbackTarget = 21): MatchFormat {
  const bestOf = m.best_of === 3 ? 3 : 1;
  const targets = Array.isArray(m.set_targets) && m.set_targets.length ? m.set_targets : bestOf === 3 ? [21, 21, 15] : [fallbackTarget];
  return { bestOf, setTargets: targets, cap: null, winBy2: true };
}

/** Target points for a given set (1-based). Missing entries reuse the last configured target. */
export function targetForSet(format: MatchFormat, setNumber: number): number {
  const t = format.setTargets;
  return t[Math.min(setNumber - 1, t.length - 1)] ?? 21;
}

export function setsToWin(bestOf: number): number {
  return Math.floor(bestOf / 2) + 1;
}

/**
 * Validate a single completed set. Returns an error message, or null when the score is legal.
 * Rules: winner reaches the target; with win-by-2 the winner leads by 2 unless the cap was hit;
 * the game ends as soon as it is won (no scores past the necessary point).
 */
export function validateSet(score: SetScore, target: number, cap: number | null = null, winBy2 = true): string | null {
  const a = score.t1;
  const b = score.t2;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return 'Scores must be whole numbers 0 or higher.';
  if (a === b) return 'A set cannot end in a tie.';
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi < target) return `The winning team must reach ${target}.`;
  if (cap != null && hi > cap) return `Scores cannot go past the cap of ${cap}.`;
  if (cap != null && hi === cap) return null; // cap point ends the set regardless of margin
  if (winBy2) {
    if (hi - lo < 2) return 'The winning team must win by 2.';
    if (hi > target && hi - lo !== 2) return `Past ${target}, the set ends at a 2-point lead (e.g. ${lo + 2}-${lo}).`;
  } else if (hi > target) {
    return `The set ends at ${target}.`;
  }
  return null;
}

export type MatchResult = {
  setsWon1: number;
  setsWon2: number;
  winner: 1 | 2 | null;
  complete: boolean;
  /** Number of sets that should be shown for entry (2 when 1-0, 3 only at 1-1). */
  setsNeeded: number;
};

/** Compute a match result from per-set scores. Sets past the deciding one are ignored. */
export function matchResult(sets: SetScore[], bestOf: number): MatchResult {
  const need = setsToWin(bestOf);
  let w1 = 0;
  let w2 = 0;
  for (const s of sets) {
    if (w1 >= need || w2 >= need) break;
    if (s.t1 > s.t2) w1++;
    else if (s.t2 > s.t1) w2++;
  }
  const complete = w1 >= need || w2 >= need;
  const winner = complete ? (w1 > w2 ? 1 : 2) : null;
  const setsNeeded = complete ? w1 + w2 : Math.min(bestOf, w1 + w2 + 1);
  return { setsWon1: w1, setsWon2: w2, winner, complete, setsNeeded: Math.max(1, setsNeeded) };
}

/** Validate a whole match. Returns a list of error messages (empty = OK). */
export function validateMatch(sets: SetScore[], format: MatchFormat): string[] {
  const errors: string[] = [];
  const res = matchResult(sets, format.bestOf);
  const used = sets.slice(0, res.complete ? res.setsWon1 + res.setsWon2 : sets.length);
  used.forEach((s, i) => {
    const err = validateSet(s, targetForSet(format, i + 1), format.cap ?? null, format.winBy2 !== false);
    if (err) errors.push(format.bestOf > 1 ? `Set ${i + 1}: ${err}` : err);
  });
  if (!res.complete && errors.length === 0) {
    errors.push(format.bestOf > 1 ? `A team must win ${setsToWin(format.bestOf)} sets.` : 'Enter a final score.');
  }
  if (sets.length > used.length) {
    errors.push('The match was already decided; remove the extra set.');
  }
  return errors;
}

/** Minimal match shape for aggregate stats. */
export type ScoredMatch = {
  team1_id: string | null;
  team2_id: string | null;
  team1_score: number | null;
  team2_score: number | null;
  winner_id: string | null;
  set_scores?: SetScore[] | null;
  best_of?: number | null;
};

/** Sets of a completed match as point pairs; single-set matches use team1_score/team2_score. */
export function setsOf(m: ScoredMatch): SetScore[] {
  if (Array.isArray(m.set_scores) && m.set_scores.length > 0 && (m.best_of ?? 1) > 1) return m.set_scores;
  if (m.team1_score == null || m.team2_score == null) return [];
  return [{ t1: m.team1_score, t2: m.team2_score }];
}

export function isCompleted(m: ScoredMatch): boolean {
  return !!m.team1_id && !!m.team2_id && m.team1_score != null && m.team2_score != null;
}

export type TeamStats = {
  matchWins: number;
  matchLosses: number;
  gameWins: number;   // sets won
  gameLosses: number; // sets lost
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
  played: number;
};

export function emptyStats(): TeamStats {
  return { matchWins: 0, matchLosses: 0, gameWins: 0, gameLosses: 0, pointsFor: 0, pointsAgainst: 0, pointDiff: 0, played: 0 };
}

/** Aggregate per-team stats over completed matches. */
export function teamStats(matches: ScoredMatch[]): Map<string, TeamStats> {
  const out = new Map<string, TeamStats>();
  const get = (id: string) => {
    let s = out.get(id);
    if (!s) {
      s = emptyStats();
      out.set(id, s);
    }
    return s;
  };
  for (const m of matches) {
    if (!isCompleted(m)) continue;
    const a = get(m.team1_id!);
    const b = get(m.team2_id!);
    a.played++;
    b.played++;
    for (const s of setsOf(m)) {
      a.pointsFor += s.t1;
      a.pointsAgainst += s.t2;
      b.pointsFor += s.t2;
      b.pointsAgainst += s.t1;
      if (s.t1 > s.t2) {
        a.gameWins++;
        b.gameLosses++;
      } else if (s.t2 > s.t1) {
        b.gameWins++;
        a.gameLosses++;
      }
    }
    const winner = m.winner_id ?? (m.team1_score! > m.team2_score! ? m.team1_id : m.team2_score! > m.team1_score! ? m.team2_id : null);
    if (winner === m.team1_id) {
      a.matchWins++;
      b.matchLosses++;
    } else if (winner === m.team2_id) {
      b.matchWins++;
      a.matchLosses++;
    }
  }
  for (const s of out.values()) s.pointDiff = s.pointsFor - s.pointsAgainst;
  return out;
}

/** Human-readable score, e.g. "21-18" or "2-1 (21-18, 19-21, 15-12)". Perspective of team1. */
export function formatScore(m: ScoredMatch): string {
  if (m.team1_score == null || m.team2_score == null) return '';
  const sets = setsOf(m);
  if ((m.best_of ?? 1) > 1 && sets.length) {
    return `${m.team1_score}-${m.team2_score} (${sets.map((s) => `${s.t1}-${s.t2}`).join(', ')})`;
  }
  return `${m.team1_score}-${m.team2_score}`;
}

/** Short label for a format, e.g. "1 set to 28" or "Best of 3 (21, 21, 15)". */
export function formatLabel(f: MatchFormat): string {
  if (f.bestOf > 1) return `Best of ${f.bestOf} (${f.setTargets.join(', ')})`;
  return `1 set to ${f.setTargets[0] ?? 21}${f.cap ? `, cap ${f.cap}` : ''}`;
}

/**
 * Record (or correct) one set of a match-play match and work out what the match row should hold.
 * `setNumber` is 1-based and may replace an existing set or append the next one. Sets after a
 * decided result are dropped (e.g. correcting Set 2 so a team wins 2–0 removes Set 3).
 * While the match is undecided, team scores and winner stay null so it isn't treated as complete.
 */
export function recordSet(
  existing: SetScore[] | null | undefined,
  setNumber: number,
  score: SetScore,
  bestOf: number,
): { set_scores: SetScore[]; result: MatchResult; team1_score: number | null; team2_score: number | null; winnerSide: 1 | 2 | null } {
  const sets = [...(existing ?? [])].slice(0, Math.max(0, setNumber - 1));
  sets[setNumber - 1] = { t1: score.t1, t2: score.t2 };
  // Keep later sets only when correcting an earlier set and they are still needed.
  for (const later of (existing ?? []).slice(setNumber)) sets.push(later);
  const result = matchResult(sets, bestOf);
  const kept = result.complete ? sets.slice(0, result.setsWon1 + result.setsWon2) : sets.slice(0, Math.min(sets.length, bestOf));
  return {
    set_scores: kept,
    result,
    team1_score: result.complete ? result.setsWon1 : null,
    team2_score: result.complete ? result.setsWon2 : null,
    winnerSide: result.winner,
  };
}

/** Swap the perspective of recorded sets (used when the two teams flip sides/slots). */
export function swapSets(sets: SetScore[] | null | undefined): SetScore[] {
  return (sets ?? []).map((s) => ({ t1: s.t2, t2: s.t1 }));
}
