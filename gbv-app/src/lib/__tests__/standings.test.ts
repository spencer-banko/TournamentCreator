import { describe, it, expect } from 'vitest';
import { rankAllPools, seedForPlaces, bracketSizeFor, seedSlotsForSize, placeSeedsAvoidingPoolRematches, roundName, type StandingTeam, type StandingMatch } from '../standings';

/** Build a pool of n teams named <prefix>1..n where a lower number always wins 21-(10+gap). */
function pool(prefix: string, n: number): { teams: StandingTeam[]; matches: StandingMatch[] } {
  const teams: StandingTeam[] = Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`, full_team_name: `${prefix}${i + 1}`, pool_id: prefix, seed_in_pool: i + 1,
  }));
  const matches: StandingMatch[] = [];
  for (let a = 1; a <= n; a++) {
    for (let b = a + 1; b <= n; b++) {
      matches.push({ pool_id: prefix, team1_id: `${prefix}${a}`, team2_id: `${prefix}${b}`, team1_score: 21, team2_score: 10 + (b - a), winner_id: `${prefix}${a}` });
    }
  }
  return { teams, matches };
}

describe('rankPool / rankAllPools', () => {
  it('ranks by wins and assigns places', () => {
    const p = pool('A', 4);
    const r = rankAllPools(p.teams, p.matches).get('A')!;
    expect(r.map((x) => x.teamId)).toEqual(['A1', 'A2', 'A3', 'A4']);
    expect(r.map((x) => x.place)).toEqual([1, 2, 3, 4]);
  });
  it('breaks equal records by point differential first', () => {
    const teams: StandingTeam[] = ['X', 'Y', 'Z'].map((id, i) => ({ id, full_team_name: id, pool_id: 'P', seed_in_pool: i + 1 }));
    // circular: X>Y, Y>Z, Z>X — all 1-1; Z has the best point diff
    const matches: StandingMatch[] = [
      { pool_id: 'P', team1_id: 'X', team2_id: 'Y', team1_score: 21, team2_score: 19, winner_id: 'X' },
      { pool_id: 'P', team1_id: 'Y', team2_id: 'Z', team1_score: 21, team2_score: 19, winner_id: 'Y' },
      { pool_id: 'P', team1_id: 'Z', team2_id: 'X', team1_score: 21, team2_score: 5, winner_id: 'Z' },
    ];
    expect(rankAllPools(teams, matches).get('P')!.map((x) => x.teamId)).toEqual(['Z', 'Y', 'X']);
  });
});

describe('seedForPlaces', () => {
  it('seeds by wins, then point differential (+22 above -5)', () => {
    const teams: StandingTeam[] = [
      { id: 'A', full_team_name: 'A', pool_id: 'P1', seed_in_pool: 1 },
      { id: 'B', full_team_name: 'B', pool_id: 'P2', seed_in_pool: 1 },
    ];
    const standings = new Map([
      ['P1', [{ teamId: 'A', name: 'A', place: 2, gameWins: 3, pointDiff: -5 } as any]],
      ['P2', [{ teamId: 'B', name: 'B', place: 2, gameWins: 3, pointDiff: 22 } as any]],
    ]);
    expect(seedForPlaces(standings, [2]).map((s) => s.teamId)).toEqual(['B', 'A']);
    void teams;
  });

  it('36 teams in 6 pools of 6 split 12/12/12 into gold/silver/bronze', () => {
    const all = ['A', 'B', 'C', 'D', 'E', 'F'].map((p) => pool(p, 6));
    const ranked = rankAllPools(all.flatMap((p) => p.teams), all.flatMap((p) => p.matches));
    expect(seedForPlaces(ranked, [1, 2])).toHaveLength(12);
    expect(seedForPlaces(ranked, [3, 4])).toHaveLength(12);
    expect(seedForPlaces(ranked, [5, 6])).toHaveLength(12);
    expect(seedForPlaces(ranked, [1, 2]).every((s) => s.place <= 2)).toBe(true);
  });

  it('35 teams (8x4 + 1x3) give gold 18 and silver 17', () => {
    const all = [...['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((p) => pool(p, 4)), pool('I', 3)];
    const ranked = rankAllPools(all.flatMap((p) => p.teams), all.flatMap((p) => p.matches));
    expect(seedForPlaces(ranked, [1, 2])).toHaveLength(18);
    expect(seedForPlaces(ranked, [3, 4])).toHaveLength(17);
  });
});

describe('bracket shape', () => {
  it('sizes and slots', () => {
    expect(bracketSizeFor(12)).toBe(16);
    expect(bracketSizeFor(17)).toBe(32);
    expect(bracketSizeFor(18)).toBe(32);
    expect(bracketSizeFor(2)).toBe(2);
    expect(seedSlotsForSize(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });
  it('round names', () => {
    expect(roundName(4, 4)).toBe('Final');
    expect(roundName(3, 4)).toBe('Semifinals');
    expect(roundName(2, 4)).toBe('Quarterfinals');
    expect(roundName(1, 4)).toBe('Round of 16');
  });
});

describe('placeSeedsAvoidingPoolRematches', () => {
  const t = (id: string, poolId: string) => ({ id, poolId });
  const pairs = (slots: Array<{ id: string; poolId: string } | null>) =>
    Array.from({ length: slots.length / 2 }, (_, i) => [slots[2 * i]?.id ?? null, slots[2 * i + 1]?.id ?? null]);

  it('swaps lower seeds so first-round opponents come from different pools', () => {
    // 6 teams, 8 slots: seeds 1-2 get byes; by record 3 v 6 would both be pool B.
    const seeds = [t('D', 'A'), t('Br', 'B'), t('E', 'B'), t('C', 'C'), t('H', 'C'), t('G', 'B')];
    const slots = placeSeedsAvoidingPoolRematches(seeds, 8);
    for (const [a, b] of pairs(slots)) {
      if (!a || !b) continue;
      const pa = seeds.find((s) => s.id === a)!.poolId;
      const pb = seeds.find((s) => s.id === b)!.poolId;
      expect(pa).not.toBe(pb);
    }
    // Byes still go to the top two seeds.
    expect(pairs(slots).filter(([, b]) => b === null).map(([a]) => a).sort()).toEqual(['Br', 'D']);
  });

  it('leaves the bracket unchanged when there is no clash', () => {
    const seeds = [t('1', 'A'), t('2', 'B'), t('3', 'A'), t('4', 'B')];
    expect(placeSeedsAvoidingPoolRematches(seeds, 4).map((s) => s?.id)).toEqual(['1', '4', '2', '3']);
  });

  it('keeps record order when a clash is unavoidable', () => {
    const seeds = [t('1', 'A'), t('2', 'A')];
    expect(placeSeedsAvoidingPoolRematches(seeds, 2).map((s) => s?.id)).toEqual(['1', '2']);
  });
});
