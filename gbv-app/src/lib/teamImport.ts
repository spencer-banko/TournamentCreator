import { parseCsv, normalizeHeader, normalizeCell } from './csv';

/**
 * Bulk team entry for the Teams admin page.
 *
 * Accepts whatever an organizer is likely to paste:
 *   - one team per line                    "Alice / Bob"
 *   - numbered list                        "1. Alice / Bob"  or  "3) Alice / Bob"
 *   - name + seed (either order)           "Alice / Bob, 1"  or  "1, Alice / Bob"
 *   - tab-separated cells from Sheets      "Alice / Bob\t1"
 *   - a CSV/TSV with a header row          team_name,seed   |   player1,player2,seed
 */

export type ParsedTeamStatus = 'new' | 'duplicate' | 'exists' | 'error';

export type ParsedTeam = {
  /** 1-based line number in the source text (for messages). */
  line: number;
  name: string;
  seed: number | null;
  status: ParsedTeamStatus;
  message?: string;
};

export type ParseResult = {
  rows: ParsedTeam[];
  /** Rows that will actually be inserted. */
  importable: ParsedTeam[];
  /** Blocking problems: nothing should be imported while any exist. */
  errors: string[];
};

const NAME_KEYS = ['team_name', 'full_team_name', 'team', 'name', 'teams'];
const PLAYER1_KEYS = ['player1', 'player_1', 'player_one', 'player_a', 'p1'];
const PLAYER2_KEYS = ['player2', 'player_2', 'player_two', 'player_b', 'p2', 'partner'];
const SEED_KEYS = ['seed', 'seed_global', 'global_seed', 'rank', 'ranking'];

const INT_RE = /^#?\d+$/;
const NUMBERED_RE = /^#?(\d+)\s*[.)\-:]\s+(.+)$/;

function parseSeed(raw: string): number | null | 'invalid' {
  const v = normalizeCell(raw).replace(/^#/, '');
  if (!v) return null;
  if (!/^\d+$/.test(v)) return 'invalid';
  const n = Number(v);
  return n >= 1 ? n : 'invalid';
}

function splitRows(text: string): { rows: string[][]; sep: string } {
  const clean = text.replace(/^﻿/, '');
  if (clean.includes('\t')) {
    const rows = clean.split(/\r?\n/).map((l) => l.split('\t'));
    return { rows, sep: ' / ' };
  }
  return { rows: parseCsv(clean), sep: ', ' };
}

function findKey(headers: string[], keys: string[]): number {
  return headers.findIndex((h) => keys.includes(h));
}

export function parseTeamList(text: string, existingNames: string[] = []): ParseResult {
  const errors: string[] = [];
  const raw: Array<{ line: number; name: string; seed: number | null | 'invalid' }> = [];

  const { rows, sep } = splitRows(text || '');
  if (rows.length === 0) return { rows: [], importable: [], errors: [] };

  const headers = (rows[0] ?? []).map(normalizeHeader);
  const nameIdx = findKey(headers, NAME_KEYS);
  const p1Idx = findKey(headers, PLAYER1_KEYS);
  const p2Idx = findKey(headers, PLAYER2_KEYS);
  const seedIdx = findKey(headers, SEED_KEYS);
  const hasHeader = nameIdx >= 0 || (p1Idx >= 0 && p2Idx >= 0);

  if (hasHeader) {
    rows.slice(1).forEach((cells, i) => {
      const cell = (idx: number) => normalizeCell(idx >= 0 ? cells[idx] ?? '' : '');
      let name = cell(nameIdx);
      if (!name && p1Idx >= 0 && p2Idx >= 0) {
        name = [cell(p1Idx), cell(p2Idx)].filter(Boolean).join(' / ');
      }
      const seedRaw = cell(seedIdx);
      if (!name && !seedRaw) return;
      raw.push({ line: i + 2, name, seed: parseSeed(seedRaw) });
    });
  } else {
    rows.forEach((cellsRaw, i) => {
      const cells = cellsRaw.map(normalizeCell);
      const nonEmpty = cells.filter(Boolean);
      if (nonEmpty.length === 0) return;

      let seed: number | null | 'invalid' = null;
      let nameCells = nonEmpty;
      if (nonEmpty.length >= 2) {
        const first = nonEmpty[0]!;
        const last = nonEmpty[nonEmpty.length - 1]!;
        if (INT_RE.test(last) && !INT_RE.test(first)) {
          seed = parseSeed(last);
          nameCells = nonEmpty.slice(0, -1);
        } else if (INT_RE.test(first) && !INT_RE.test(last)) {
          seed = parseSeed(first);
          nameCells = nonEmpty.slice(1);
        }
      }

      let name = nameCells.join(sep);
      if (seed === null) {
        const m = NUMBERED_RE.exec(name);
        if (m) {
          seed = parseSeed(m[1]!);
          name = normalizeCell(m[2]!);
        }
      }
      raw.push({ line: i + 1, name, seed });
    });
  }

  const existing = new Set(existingNames.map((n) => normalizeCell(n).toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  const seedLines = new Map<number, number>();
  const out: ParsedTeam[] = [];

  for (const r of raw) {
    const key = r.name.toLowerCase();
    if (!r.name) {
      const msg = `Line ${r.line}: missing team name`;
      errors.push(msg);
      out.push({ line: r.line, name: '', seed: null, status: 'error', message: 'Missing team name' });
      continue;
    }
    if (r.seed === 'invalid') {
      errors.push(`Line ${r.line}: seed for "${r.name}" must be a whole number of 1 or more`);
      out.push({ line: r.line, name: r.name, seed: null, status: 'error', message: 'Invalid seed' });
      continue;
    }
    if (existing.has(key)) {
      out.push({ line: r.line, name: r.name, seed: r.seed, status: 'exists', message: 'Already in tournament — skipped' });
      continue;
    }
    if (seen.has(key)) {
      out.push({ line: r.line, name: r.name, seed: r.seed, status: 'duplicate', message: 'Listed twice — skipped' });
      continue;
    }
    seen.add(key);
    if (r.seed != null) {
      const prev = seedLines.get(r.seed);
      if (prev != null) {
        errors.push(`Seed ${r.seed} is used on line ${prev} and line ${r.line}`);
        out.push({ line: r.line, name: r.name, seed: r.seed, status: 'error', message: `Seed ${r.seed} used twice` });
        continue;
      }
      seedLines.set(r.seed, r.line);
    }
    out.push({ line: r.line, name: r.name, seed: r.seed, status: 'new' });
  }

  return { rows: out, importable: out.filter((r) => r.status === 'new'), errors };
}

/**
 * Merge incoming teams into an existing seed order (index 0 = seed 1).
 * Incoming teams with an explicit seed take that slot and push later teams down;
 * incoming teams without a seed are appended in the order given.
 */
export function mergeSeeds<E, I extends { seed: number | null }>(
  existing: E[],
  incoming: I[],
): Array<{ kind: 'existing'; item: E } | { kind: 'new'; item: I }> {
  type Entry = { kind: 'existing'; item: E } | { kind: 'new'; item: I };
  const result: Entry[] = existing.map((item) => ({ kind: 'existing' as const, item }));
  for (const item of incoming) if (item.seed == null) result.push({ kind: 'new', item });
  const seeded = incoming.filter((i) => i.seed != null).sort((a, b) => a.seed! - b.seed!);
  for (const item of seeded) {
    const at = Math.min(item.seed! - 1, result.length);
    result.splice(at, 0, { kind: 'new', item });
  }
  return result;
}

/** Return a copy of `arr` with the item at `from` moved to `to` (indices clamped). */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const copy = arr.slice();
  if (from < 0 || from >= copy.length) return copy;
  const target = Math.max(0, Math.min(to, copy.length - 1));
  const [item] = copy.splice(from, 1);
  copy.splice(target, 0, item as T);
  return copy;
}
