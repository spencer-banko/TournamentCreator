import supabase from './supabase';
import type { AdvancementRules, Tournament, Bracket, BracketRoundFormat, MatchFormat } from '../types/db';
import { rankAllPools, seedForPlaces, bracketSizeFor, seedSlotsForSize, DEFAULT_TIEBREAKERS, type Standing, type Tiebreaker } from './standings';
import { normalizeFormat, DEFAULT_SINGLE_SET, DEFAULT_MATCH_PLAY } from './scoring';

/**
 * Bracket engine — multiple single-elimination brackets per tournament (Gold / Silver / Bronze ...).
 *
 * - Each bracket is fed by pool finishing places (bracket.places, 1-based), e.g. {1,2} = top two of every pool.
 *   A pool that has no team in a place simply contributes nothing (a 3-team pool has no 4th place).
 * - Teams are seeded across pools by game (set) wins, then total point differential (see standings.ts).
 * - Bracket size = next power of two; byes go to the top seeds and are auto-advanced one round.
 * - Each round's match format (single set / best of 3) comes from bracket.round_formats (keyed from the final).
 */

export type { Standing };

const BRACKET_ID_NAMESPACE_UUID = '6b1f1d86-8c38-4d3f-85fb-9f5d4f0c1a9f';

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`Invalid UUID: ${uuid}`);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Deterministic UUID v5 so regenerating a bracket reuses the same match ids. */
async function uuidV5(name: string, namespaceUuid = BRACKET_ID_NAMESPACE_UUID): Promise<string> {
  const ns = uuidToBytes(namespaceUuid);
  const nameBytes = new TextEncoder().encode(name);
  const buf = new Uint8Array(ns.length + nameBytes.length);
  buf.set(ns, 0);
  buf.set(nameBytes, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', buf));
  const bytes = hash.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

// ---------------------------------------------------------------------------
// Loading helpers
// ---------------------------------------------------------------------------

async function loadTournamentRules(tournamentId: string): Promise<AdvancementRules> {
  const { data } = await supabase.from('tournaments').select('id,advancement_rules').eq('id', tournamentId).single();
  return ((data as Tournament | null)?.advancement_rules ?? {}) as AdvancementRules;
}

async function loadTiebreakers(tournamentId: string): Promise<Tiebreaker[]> {
  const rules = await loadTournamentRules(tournamentId);
  return Array.isArray(rules.tiebreakers) && rules.tiebreakers.length ? (rules.tiebreakers as Tiebreaker[]) : DEFAULT_TIEBREAKERS;
}

/** Brackets for a tournament ordered for display. */
export async function loadBrackets(tournamentId: string): Promise<Bracket[]> {
  const { data, error } = await supabase
    .from('brackets')
    .select('*')
    .eq('tournament_id', tournamentId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed to load brackets: ${error.message}`);
  return ((data as Bracket[]) ?? []).map((b) => ({
    ...b,
    places: Array.isArray(b.places) ? b.places : [],
    round_formats: Array.isArray(b.round_formats) ? b.round_formats : [],
  }));
}

/**
 * Legacy tournaments (no rows in `brackets`): create a single "Main" bracket from the old
 * advance-count-by-pool-size rule so they keep working.
 */
export async function ensureBrackets(tournamentId: string): Promise<Bracket[]> {
  const existing = await loadBrackets(tournamentId);
  if (existing.length) return existing;
  const rules = await loadTournamentRules(tournamentId);
  const maxAdvance = Math.max(2, ...((rules.pools ?? []).map((p) => Number(p.advanceCount) || 0)));
  const places = Array.from({ length: maxAdvance }, (_, i) => i + 1);
  const { error } = await supabase.from('brackets').insert({
    tournament_id: tournamentId,
    name: 'Main',
    sort_order: 0,
    places,
    round_formats: [],
  });
  if (error) throw new Error(`Failed to create default bracket: ${error.message}`);
  return loadBrackets(tournamentId);
}

/** Per-pool standings with finishing places (same logic the public pages use). */
export async function computePoolStandings(tournamentId: string): Promise<Map<string, Standing[]>> {
  const [{ data: teams, error: tErr }, { data: matches, error: mErr }, tiebreakers] = await Promise.all([
    supabase.from('teams').select('id,pool_id,full_team_name,seed_in_pool,seed_global').eq('tournament_id', tournamentId),
    supabase
      .from('matches')
      .select('id,pool_id,team1_id,team2_id,team1_score,team2_score,winner_id,set_scores,best_of')
      .eq('tournament_id', tournamentId)
      .eq('match_type', 'pool'),
    loadTiebreakers(tournamentId),
  ]);
  if (tErr) throw new Error(`Failed to load teams: ${tErr.message}`);
  if (mErr) throw new Error(`Failed to load matches: ${mErr.message}`);
  return rankAllPools((teams as any[]) ?? [], (matches as any[]) ?? [], tiebreakers);
}

/** Seeded team ids for one bracket. */
export async function seedBracket(tournamentId: string, bracket: Pick<Bracket, 'places'>): Promise<Standing[]> {
  const standings = await computePoolStandings(tournamentId);
  return seedForPlaces(standings, bracket.places);
}

/** Format for a bracket round (1-based round, totalRounds = log2(size)). */
export function roundFormatFor(bracket: Pick<Bracket, 'round_formats'>, round: number, totalRounds: number): MatchFormat {
  const fromEnd = totalRounds - round + 1;
  const f = (bracket.round_formats ?? []).find((r) => Number(r.fromEnd) === fromEnd);
  if (!f) return DEFAULT_SINGLE_SET;
  return normalizeFormat(f, f.bestOf === 3 ? DEFAULT_MATCH_PLAY : DEFAULT_SINGLE_SET);
}

/** Default round formats for new brackets: semifinal + final best of 3 (21, 21, 15); earlier rounds 1 set to 21. */
export function defaultRoundFormats(): BracketRoundFormat[] {
  return [
    { fromEnd: 1, ...DEFAULT_MATCH_PLAY },
    { fromEnd: 2, ...DEFAULT_MATCH_PLAY },
    { fromEnd: 3, ...DEFAULT_SINGLE_SET },
    { fromEnd: 4, ...DEFAULT_SINGLE_SET },
    { fromEnd: 5, ...DEFAULT_SINGLE_SET },
  ];
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export type GenerateBracketResult = { inserted: number; bracketSize: number; rounds: number; teams: number; errors: string[] };

async function updateTournamentPhase(tournamentId: string) {
  const { data } = await supabase.from('matches').select('id').eq('tournament_id', tournamentId).eq('match_type', 'bracket').limit(1);
  const hasBracket = (data ?? []).length > 0;
  await supabase
    .from('tournaments')
    .update(
      hasBracket
        ? { status: 'bracket', bracket_generated_at: new Date().toISOString() }
        : { status: 'pool_play', bracket_started: false, bracket_generated_at: null }
    )
    .eq('id', tournamentId);
}

/** Generate (or regenerate) one bracket. Existing matches of this bracket are replaced. */
export async function generateBracket(tournamentId: string, bracketId: string): Promise<GenerateBracketResult> {
  const errors: string[] = [];
  const brackets = await loadBrackets(tournamentId);
  const bracket = brackets.find((b) => b.id === bracketId);
  if (!bracket) return { inserted: 0, bracketSize: 0, rounds: 0, teams: 0, errors: ['Bracket not found.'] };

  const seeds = (await seedBracket(tournamentId, bracket)).map((s) => s.teamId);
  const N = seeds.length;
  if (N < 2) {
    return { inserted: 0, bracketSize: 0, rounds: 0, teams: N, errors: [`${bracket.name}: needs at least 2 teams (check which pool places feed it).`] };
  }
  const B = bracketSizeFor(N, 64);
  if (B === -1) return { inserted: 0, bracketSize: 0, rounds: 0, teams: N, errors: [`${bracket.name}: more than 64 teams is not supported.`] };
  const rounds = Math.log2(B);

  // Replace this bracket's matches.
  const { error: delErr } = await supabase.from('matches').delete().eq('tournament_id', tournamentId).eq('bracket_id', bracketId);
  if (delErr) return { inserted: 0, bracketSize: B, rounds, teams: N, errors: [`Failed to clear ${bracket.name}: ${delErr.message}`] };

  const slots = seedSlotsForSize(B).map((seedNum) => (seedNum <= N ? seeds[seedNum - 1] : null));
  const rows: any[] = [];
  const push = async (round: number, index: number, t1: string | null, t2: string | null) => {
    const fmt = roundFormatFor(bracket, round, rounds);
    rows.push({
      id: await uuidV5(`tournament:${tournamentId}:bracket:${bracketId}:${round}:${index}`),
      tournament_id: tournamentId,
      bracket_id: bracketId,
      pool_id: null,
      round_number: round,
      team1_id: t1,
      team2_id: t2,
      ref_team_id: null,
      team1_score: null,
      team2_score: null,
      winner_id: null,
      set_scores: null,
      best_of: fmt.bestOf,
      set_targets: fmt.setTargets,
      match_type: 'bracket',
      bracket_round: round,
      bracket_match_index: index,
      is_live: false,
      live_score_team1: null,
      live_score_team2: null,
    });
  };

  for (let i = 0; i < B / 2; i++) {
    const a = slots[2 * i] ?? null;
    const b = slots[2 * i + 1] ?? null;
    if (a || b) await push(1, i, a, b);
  }
  for (let r = 2; r <= rounds; r++) {
    for (let i = 0; i < B >> r; i++) await push(r, i, null, null);
  }

  // Byes: a round-1 match with one team is won automatically; place the team in round 2.
  const byKey = new Map(rows.map((r) => [`${r.bracket_round}:${r.bracket_match_index}`, r]));
  for (const r of rows) {
    if (r.bracket_round !== 1) continue;
    const only = r.team1_id && !r.team2_id ? r.team1_id : !r.team1_id && r.team2_id ? r.team2_id : null;
    if (!only) continue;
    r.winner_id = only;
    const next = byKey.get(`2:${Math.floor(r.bracket_match_index / 2)}`);
    if (next) {
      if (r.bracket_match_index % 2 === 0) next.team1_id = only;
      else next.team2_id = only;
    }
  }

  const { error: insErr } = await supabase.from('matches').upsert(rows, { onConflict: 'id' });
  if (insErr) errors.push(`Failed to save ${bracket.name}: ${insErr.message}`);

  await supabase.from('brackets').update({ generated_at: new Date().toISOString(), started: false }).eq('id', bracketId);
  await updateTournamentPhase(tournamentId);

  return { inserted: insErr ? 0 : rows.length, bracketSize: B, rounds, teams: N, errors };
}

/** Generate every bracket of a tournament. */
export async function generateAllBrackets(tournamentId: string): Promise<{ results: Array<GenerateBracketResult & { bracketId: string; name: string }>; errors: string[] }> {
  const brackets = await ensureBrackets(tournamentId);
  const results: Array<GenerateBracketResult & { bracketId: string; name: string }> = [];
  const errors: string[] = [];
  for (const b of brackets) {
    const r = await generateBracket(tournamentId, b.id);
    results.push({ ...r, bracketId: b.id, name: b.name });
    errors.push(...r.errors);
  }
  return { results, errors };
}

/** Alias kept for existing callers: regenerate one bracket. */
export async function rebuildBracket(tournamentId: string, bracketId: string): Promise<GenerateBracketResult> {
  return generateBracket(tournamentId, bracketId);
}

/** Delete one bracket's matches (keeps the bracket definition). */
export async function deleteBracketMatches(tournamentId: string, bracketId: string): Promise<{ deleted: number; errors: string[] }> {
  const errors: string[] = [];
  const { data } = await supabase.from('matches').select('id').eq('tournament_id', tournamentId).eq('bracket_id', bracketId);
  const { error } = await supabase.from('matches').delete().eq('tournament_id', tournamentId).eq('bracket_id', bracketId);
  if (error) errors.push(`Failed to delete bracket matches: ${error.message}`);
  await supabase.from('brackets').update({ generated_at: null, started: false }).eq('id', bracketId);
  await updateTournamentPhase(tournamentId);
  return { deleted: (data ?? []).length, errors };
}

/** Delete all bracket matches and revert the tournament to pool play. */
export async function deleteBracketAndRevertToPoolPlay(tournamentId: string): Promise<{ deleted: number; errors: string[] }> {
  const errors: string[] = [];
  const { data } = await supabase.from('matches').select('id').eq('tournament_id', tournamentId).eq('match_type', 'bracket');
  const { error } = await supabase.from('matches').delete().eq('tournament_id', tournamentId).eq('match_type', 'bracket');
  if (error) errors.push(`Failed to delete bracket matches: ${error.message}`);
  await supabase.from('brackets').update({ generated_at: null, started: false }).eq('tournament_id', tournamentId);
  await updateTournamentPhase(tournamentId);
  return { deleted: (data ?? []).length, errors };
}

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

export type BracketPlan = {
  bracketId: string;
  name: string;
  places: number[];
  teamCount: number;
  bracketSize: number;
  rounds: number;
  exists: boolean;
  started: boolean;
};

export type BracketPrereqReport = {
  ok: boolean;
  errors: string[];
  infos: string[];
  stats: {
    poolCount: number;
    teamCount: number;
    unscoredCount: number;
    bracketExists: boolean;
  };
  brackets: BracketPlan[];
  unscored: Array<{ matchId: string; poolId: string | null; poolName: string | null }>;
  teamsWithoutPool: number;
};

/**
 * Readiness report: every pool match scored, pools have >= 2 teams, and each bracket's
 * team count / size. Warns when one pool place feeds two brackets, and lists unplaced places.
 */
export async function checkBracketPrerequisites(tournamentId: string): Promise<BracketPrereqReport> {
  const errors: string[] = [];
  const infos: string[] = [];

  const [poolsRes, teamsRes, matchesRes] = await Promise.all([
    supabase.from('pools').select('id,name').eq('tournament_id', tournamentId),
    supabase.from('teams').select('id,pool_id').eq('tournament_id', tournamentId),
    supabase
      .from('matches')
      .select('id,pool_id,team1_id,team2_id,team1_score,team2_score,match_type,bracket_id,winner_id')
      .eq('tournament_id', tournamentId),
  ]);
  const pools = (poolsRes.data as Array<{ id: string; name: string }>) ?? [];
  const teams = (teamsRes.data as Array<{ id: string; pool_id: string | null }>) ?? [];
  const matches = (matchesRes.data as any[]) ?? [];
  for (const r of [poolsRes, teamsRes, matchesRes]) if (r.error) errors.push(r.error.message);

  const poolName = new Map(pools.map((p) => [p.id, p.name]));
  const sizeByPool = new Map<string, number>();
  let teamsWithoutPool = 0;
  for (const t of teams) {
    if (!t.pool_id) teamsWithoutPool++;
    else sizeByPool.set(t.pool_id, (sizeByPool.get(t.pool_id) ?? 0) + 1);
  }
  for (const p of pools) {
    const sz = sizeByPool.get(p.id) ?? 0;
    if (sz > 0 && sz < 2) errors.push(`Pool '${p.name}' has only ${sz} team. Need at least 2.`);
  }
  if (teamsWithoutPool > 0) infos.push(`${teamsWithoutPool} team(s) are not assigned to any pool.`);

  const unscored = matches
    .filter((m) => m.match_type === 'pool' && m.team1_id && m.team2_id && (m.team1_score == null || m.team2_score == null))
    .map((m) => ({ matchId: m.id, poolId: m.pool_id, poolName: m.pool_id ? poolName.get(m.pool_id) ?? null : null }));
  if (unscored.length) errors.push(`${unscored.length} pool match(es) are missing scores.`);

  let brackets: Bracket[] = [];
  try {
    brackets = await loadBrackets(tournamentId);
  } catch (e: any) {
    errors.push(e?.message ?? String(e));
  }
  if (!brackets.length) {
    infos.push('No brackets are set up yet. Add Gold / Silver / Bronze brackets in Tournament Setup, or a single "Main" bracket (top 2 of each pool) will be created.');
  }

  // Overlap / coverage of pool places
  const maxPool = Math.max(0, ...sizeByPool.values());
  const placeOwners = new Map<number, string[]>();
  for (const b of brackets) for (const p of b.places) placeOwners.set(p, [...(placeOwners.get(p) ?? []), b.name]);
  for (const [place, owners] of placeOwners) {
    if (owners.length > 1) errors.push(`Pool place ${place} feeds more than one bracket (${owners.join(', ')}).`);
  }
  if (brackets.length) {
    const unplaced = Array.from({ length: maxPool }, (_, i) => i + 1).filter((p) => !placeOwners.has(p));
    if (unplaced.length) infos.push(`Pool place(s) ${unplaced.join(', ')} are not in any bracket; those teams finish after pool play.`);
  }

  // Per-bracket size (uses current standings; exact once all pool matches are scored)
  let standings = new Map<string, Standing[]>();
  try {
    standings = await computePoolStandings(tournamentId);
  } catch (e: any) {
    errors.push(e?.message ?? String(e));
  }
  const plans: BracketPlan[] = brackets.map((b) => {
    const n = seedForPlaces(standings, b.places).length;
    const size = n >= 2 ? bracketSizeFor(n, 64) : 0;
    const own = matches.filter((m) => m.bracket_id === b.id);
    return {
      bracketId: b.id,
      name: b.name,
      places: b.places,
      teamCount: n,
      bracketSize: size,
      rounds: size > 0 ? Math.log2(size) : 0,
      exists: own.length > 0,
      started: own.some((m) => m.team1_score != null && m.team2_id != null && m.team1_id != null),
    };
  });
  for (const p of plans) {
    if (p.teamCount === 1) errors.push(`${p.name} would have only 1 team.`);
    if (p.bracketSize === -1) errors.push(`${p.name} has more than 64 teams.`);
  }

  const bracketExists = matches.some((m) => m.match_type === 'bracket');
  return {
    ok: errors.length === 0,
    errors,
    infos,
    stats: { poolCount: pools.length, teamCount: teams.length, unscoredCount: unscored.length, bracketExists },
    brackets: plans,
    unscored,
    teamsWithoutPool,
  };
}

// ---------------------------------------------------------------------------
// Advancing winners / undoing results
// ---------------------------------------------------------------------------

type BracketMatchRow = {
  id: string;
  bracket_id: string | null;
  match_type: string;
  bracket_round: number | null;
  bracket_match_index: number | null;
  winner_id: string | null;
  team1_id: string | null;
  team2_id: string | null;
  team1_score: number | null;
  team2_score: number | null;
};

async function loadNextMatch(tournamentId: string, m: BracketMatchRow) {
  let q = supabase
    .from('matches')
    .select('id,team1_id,team2_id,team1_score,team2_score,winner_id')
    .eq('tournament_id', tournamentId)
    .eq('match_type', 'bracket')
    .eq('bracket_round', (m.bracket_round as number) + 1)
    .eq('bracket_match_index', Math.floor((m.bracket_match_index as number) / 2));
  q = m.bracket_id ? q.eq('bracket_id', m.bracket_id) : q.is('bracket_id', null);
  const { data } = await q.maybeSingle();
  return data as Pick<BracketMatchRow, 'id' | 'team1_id' | 'team2_id' | 'team1_score' | 'team2_score' | 'winner_id'> | null;
}

/** After a bracket match has a winner, place the winner into the next round (never overwrites a different team). */
export async function advanceWinnerToNextById(tournamentId: string, matchId: string): Promise<{ updatedNext: boolean; error?: string }> {
  const { data: m, error } = await supabase
    .from('matches')
    .select('id,bracket_id,match_type,bracket_round,bracket_match_index,winner_id,team1_id,team2_id,team1_score,team2_score')
    .eq('tournament_id', tournamentId)
    .eq('id', matchId)
    .single();
  if (error || !m) return { updatedNext: false, error: error?.message || 'Match not found' };
  const row = m as BracketMatchRow;
  if (row.match_type !== 'bracket' || row.bracket_round == null || row.bracket_match_index == null) {
    return { updatedNext: false, error: 'Not a bracket match' };
  }
  if (!row.winner_id) return { updatedNext: false, error: 'Winner not set' };

  if (row.bracket_id) await supabase.from('brackets').update({ started: true }).eq('id', row.bracket_id);

  const next = await loadNextMatch(tournamentId, row);
  if (!next) return { updatedNext: false }; // final
  const side = row.bracket_match_index % 2 === 0 ? 'team1_id' : 'team2_id';
  const loser = row.winner_id === row.team1_id ? row.team2_id : row.team1_id;
  const cur = next[side];
  if (cur === row.winner_id) return { updatedNext: false };
  // Replace an empty slot, or the previous result's team when a score was corrected (only if the next match is unplayed).
  if (cur && cur !== loser) return { updatedNext: false, error: 'Next slot already filled by a different team; not overwriting' };
  if (cur && next.team1_score != null) return { updatedNext: false, error: 'Next match already has a score; not changing it' };
  const { error: upErr } = await supabase.from('matches').update({ [side]: row.winner_id }).eq('id', next.id);
  if (upErr) return { updatedNext: false, error: upErr.message };
  return { updatedNext: true };
}

/**
 * Clear a bracket match's result and remove its winner from the next round,
 * as long as the next match has not been played yet.
 */
export async function clearBracketResult(tournamentId: string, matchId: string): Promise<{ error?: string }> {
  const { data: m, error } = await supabase
    .from('matches')
    .select('id,bracket_id,match_type,bracket_round,bracket_match_index,winner_id,team1_id,team2_id,team1_score,team2_score')
    .eq('id', matchId)
    .single();
  if (error || !m) return { error: error?.message || 'Match not found' };
  const row = m as BracketMatchRow;
  if (row.match_type === 'bracket' && row.winner_id && row.bracket_round != null) {
    const next = await loadNextMatch(tournamentId, row);
    if (next) {
      if (next.team1_score != null || next.winner_id) {
        return { error: 'The next-round match already has a result. Clear that one first.' };
      }
      const side = (row.bracket_match_index as number) % 2 === 0 ? 'team1_id' : 'team2_id';
      if (next[side] === row.winner_id) await supabase.from('matches').update({ [side]: null }).eq('id', next.id);
    }
  }
  const { error: upErr } = await supabase
    .from('matches')
    .update({ team1_score: null, team2_score: null, set_scores: null, winner_id: null, is_live: false, live_score_team1: null, live_score_team2: null })
    .eq('id', matchId);
  return upErr ? { error: upErr.message } : {};
}
