import { describe, it, expect } from 'vitest';
import { validateSet, matchResult, validateMatch, teamStats, DEFAULT_MATCH_PLAY } from '../scoring';

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
