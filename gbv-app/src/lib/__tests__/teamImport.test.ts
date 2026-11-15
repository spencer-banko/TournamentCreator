import { describe, it, expect } from 'vitest';
import { parseTeamList, mergeSeeds, moveItem } from '../teamImport';

const names = (r: ReturnType<typeof parseTeamList>) => r.importable.map((t) => [t.name, t.seed]);

describe('parseTeamList', () => {
  it('splits a typed ", seed" line mixed into a spreadsheet paste', () => {
    const r = parseTeamList('Team Name\tSeed\nBravo / Brown\t2\nDelta / Diaz, 4\nalpha / anders, 6\nSmith, J / Lima', ['Alpha / Anders']);
    expect(r.rows.map((x) => [x.name, x.seed, x.status])).toEqual([
      ['Bravo / Brown', 2, 'new'],
      ['Delta / Diaz', 4, 'new'],
      ['alpha / anders', 6, 'exists'],
      ['Smith, J / Lima', null, 'new'],
    ]);
  });

  it('parses one team per line', () => {
    const r = parseTeamList('Alice / Bob\nCara / Dee\n\n  Eve / Fay  \n');
    expect(names(r)).toEqual([
      ['Alice / Bob', null],
      ['Cara / Dee', null],
      ['Eve / Fay', null],
    ]);
    expect(r.errors).toEqual([]);
  });

  it('reads seeds from either side and from numbered lists', () => {
    const r = parseTeamList('Alice / Bob, 2\n1, Cara / Dee\n3. Eve / Fay\n#4) Gus / Hal');
    expect(names(r)).toEqual([
      ['Alice / Bob', 2],
      ['Cara / Dee', 1],
      ['Eve / Fay', 3],
      ['Gus / Hal', 4],
    ]);
  });

  it('keeps comma-separated partner names together when there is no seed', () => {
    const r = parseTeamList('Alice, Bob');
    expect(names(r)).toEqual([['Alice, Bob', null]]);
  });

  it('handles tab-separated paste from Sheets', () => {
    const r = parseTeamList('Alice\tBob\t1\nCara\tDee\t2');
    expect(names(r)).toEqual([
      ['Alice / Bob', 1],
      ['Cara / Dee', 2],
    ]);
  });

  it('handles header rows, including player1/player2 columns', () => {
    expect(names(parseTeamList('Team Name,Seed\nAlice / Bob,2\nCara / Dee,'))).toEqual([
      ['Alice / Bob', 2],
      ['Cara / Dee', null],
    ]);
    expect(names(parseTeamList('seed,player1,player2\n1,Alice,Bob\n2,Cara,Dee'))).toEqual([
      ['Alice / Bob', 1],
      ['Cara / Dee', 2],
    ]);
  });

  it('skips duplicates and teams already in the tournament', () => {
    const r = parseTeamList('Alice / Bob\nalice / bob\nCara / Dee', ['CARA / DEE']);
    expect(names(r)).toEqual([['Alice / Bob', null]]);
    expect(r.rows.map((x) => x.status)).toEqual(['new', 'duplicate', 'exists']);
    expect(r.errors).toEqual([]);
  });

  it('reports invalid and repeated seeds as errors', () => {
    expect(parseTeamList('team,seed\nAlice,0').errors[0]).toMatch(/whole number/);
    expect(parseTeamList('Alice, 1\nCara, 1').errors[0]).toMatch(/Seed 1 is used on line 1 and line 2/);
  });
});

describe('mergeSeeds', () => {
  it('appends unseeded teams and inserts seeded ones at their slot', () => {
    const merged = mergeSeeds(['A', 'B', 'C'], [
      { name: 'X', seed: null },
      { name: 'Y', seed: 1 },
      { name: 'Z', seed: 3 },
    ]);
    expect(merged.map((m) => (m.kind === 'existing' ? m.item : m.item.name))).toEqual(['Y', 'A', 'Z', 'B', 'C', 'X']);
  });

  it('clamps seeds beyond the end', () => {
    const merged = mergeSeeds(['A'], [{ name: 'X', seed: 99 }]);
    expect(merged.map((m) => (m.kind === 'existing' ? m.item : m.item.name))).toEqual(['A', 'X']);
  });
});

describe('moveItem', () => {
  it('moves and clamps', () => {
    expect(moveItem([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3]);
    expect(moveItem([1, 2, 3, 4], 0, 10)).toEqual([2, 3, 4, 1]);
  });
});
