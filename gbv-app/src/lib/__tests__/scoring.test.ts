import { describe, it, expect } from 'vitest';
import { validateSet, matchResult, validateMatch, teamStats, DEFAULT_MATCH_PLAY, recordSet, swapSets } from '../scoring';

describe('validateSet', () => {
  it('accepts normal and extended win-by-2 scores', () => {
    expect(validateSet({ t1: 21, t2: 15 }, 21)).toBeNull();
    expect(validateSet({ t1: 23, t2: 21 }, 21)).toBeNull();
    expect(validateSet({ t1: 13, t2: 15 }, 15)).toBeNull();
    expect(validateSet({ t1: 28, t2: 20 }, 28)).toBeNull();
  });
  it('rejects ties, short games and over-long games', () => {
    expect(validateSet({ t1: 21, t2: 21 }, 21)).toMatch(/tie/);
    expect(validateSet({ t1: 20, t2: 18 }, 21)).toMatch(/reach 21/);
    expect(validateSet({ t1: 21, t2: 20 }, 21)).toMatch(/win by 2/);
    expect(validateSet({ t1: 25, t2: 21 }, 21)).toMatch(/2-point lead/);
  });
  it('allows a cap to end the set by 1', () => {
    expect(validateSet({ t1: 25, t2: 24 }, 21, 25)).toBeNull();
    expect(validateSet({ t1: 26, t2: 24 }, 21, 25)).toMatch(/cap/);
  });
});

describe('matchResult (best of 3)', () => {
  it('ends at 2-0 with no third set', () => {
    const r = matchResult([{ t1: 21, t2: 10 }, { t1: 21, t2: 12 }], 3);
    expect(r).toMatchObject({ setsWon1: 2, setsWon2: 0, winner: 1, complete: true, setsNeeded: 2 });
  });
  it('needs a third set at 1-1', () => {
    const r = matchResult([{ t1: 21, t2: 10 }, { t1: 15, t2: 21 }], 3);
    expect(r).toMatchObject({ complete: false, setsNeeded: 3, winner: null });
    const done = matchResult([{ t1: 21, t2: 10 }, { t1: 15, t2: 21 }, { t1: 13, t2: 15 }], 3);
    expect(done).toMatchObject({ setsWon1: 1, setsWon2: 2, winner: 2, complete: true });
  });
  it('validateMatch flags an extra set after 2-0 and a third set to 15', () => {
    expect(validateMatch([{ t1: 21, t2: 10 }, { t1: 21, t2: 12 }, { t1: 15, t2: 3 }], DEFAULT_MATCH_PLAY)).toContain(
      'The match was already decided; remove the extra set.'
    );
    expect(validateMatch([{ t1: 21, t2: 10 }, { t1: 15, t2: 21 }, { t1: 15, t2: 12 }], DEFAULT_MATCH_PLAY)).toEqual([]);
    expect(validateMatch([{ t1: 21, t2: 10 }, { t1: 15, t2: 21 }, { t1: 21, t2: 12 }], DEFAULT_MATCH_PLAY)[0]).toMatch(/Set 3/);
  });
});

describe('teamStats', () => {
  it('counts games, points (incl. 3rd set) and match wins', () => {
    const s = teamStats([
      {
        team1_id: 'A', team2_id: 'B', team1_score: 2, team2_score: 1, winner_id: 'A', best_of: 3,
        set_scores: [{ t1: 21, t2: 18 }, { t1: 19, t2: 21 }, { t1: 15, t2: 10 }],
      },
      { team1_id: 'A', team2_id: 'C', team1_score: 21, team2_score: 25, winner_id: 'C' },
    ]);
    const a = s.get('A')!;
    expect(a).toMatchObject({ matchWins: 1, matchLosses: 1, gameWins: 2, gameLosses: 2, pointsFor: 76, pointsAgainst: 74, pointDiff: 2 });
    expect(s.get('B')).toMatchObject({ gameWins: 1, gameLosses: 2, matchLosses: 1 });
  });
});

describe('recordSet', () => {
  it('keeps an in-progress match undecided after set 1', () => {
    const r = recordSet([], 1, { t1: 21, t2: 15 }, 3);
    expect(r.set_scores).toEqual([{ t1: 21, t2: 15 }]);
    expect(r.team1_score).toBeNull();
    expect(r.winnerSide).toBeNull();
  });
  it('decides the match 2-0 and announces the winner', () => {
    const r = recordSet([{ t1: 21, t2: 15 }], 2, { t1: 21, t2: 19 }, 3);
    expect(r.result.complete).toBe(true);
    expect([r.team1_score, r.team2_score, r.winnerSide]).toEqual([2, 0, 1]);
  });
  it('needs set 3 at 1-1, then decides', () => {
    const r = recordSet([{ t1: 21, t2: 15 }], 2, { t1: 18, t2: 21 }, 3);
    expect(r.result.complete).toBe(false);
    const r3 = recordSet(r.set_scores, 3, { t1: 13, t2: 15 }, 3);
    expect([r3.team1_score, r3.team2_score, r3.winnerSide]).toEqual([1, 2, 2]);
  });
  it('drops set 3 when a correction makes it 2-0', () => {
    const r = recordSet([{ t1: 21, t2: 15 }, { t1: 18, t2: 21 }, { t1: 15, t2: 10 }], 2, { t1: 21, t2: 18 }, 3);
    expect(r.set_scores).toHaveLength(2);
    expect(r.winnerSide).toBe(1);
  });
});

describe('swapSets', () => {
  it('flips perspective', () => {
    expect(swapSets([{ t1: 21, t2: 15 }])).toEqual([{ t1: 15, t2: 21 }]);
  });
});
