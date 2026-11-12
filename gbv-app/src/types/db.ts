/**
 * Supabase/PostgreSQL schema types aligned with PRD
 * Tables: tournaments, pools, teams, matches, schedule_templates
 */

export type UUID = string;

export type TournamentStatus =
  | 'draft'
  | 'setup'
  | 'pool_play'
  | 'bracket'
  | 'completed';

export type BracketFormat = 'single_elimination' | 'best_of_3_single_elim';

/**
 * Advancement and game rules are stored as JSONB on tournaments.
 * Define minimal shapes we rely on in the app.
 */
export interface AdvancementRules {
  // Example: [{ fromPoolSize: 4, advanceCount: 2 }]
  pools?: Array<{ fromPoolSize: number; advanceCount: number }>;
  bracketFormat?: BracketFormat;
  tiebreakers?: Array<'head_to_head' | 'set_ratio' | 'point_diff' | 'random'>;
}

export interface GameRules {
  // Example: pool vs bracket caps/targets + win-by-2 and finals third set target
  pool?: {
    setTarget?: number;  // e.g., 21
    cap?: number;        // e.g., 25
    bestOf?: number;     // e.g., 1 = single set
    winBy2?: boolean;    // e.g., true = must win by 2
    // Optional per-pool-size overrides (JSON keys are strings)
    setTargetByPoolSize?: Record<string, number>;
    /** Per-pool-size match format, e.g. { "3": { bestOf: 3, setTargets: [21,21,15] }, "4": { bestOf: 1, setTargets: [28] } } */
    formatBySize?: Record<string, MatchFormat>;
  };
  bracket?: {
    setTarget?: number;
    cap?: number;
    bestOf?: number;       // 1 or 3
    winBy2?: boolean;      // e.g., true = must win by 2
    thirdSetTarget?: number; // e.g., 15 when bestOf = 3
  };
}

/**
 * Format of a single match: how many sets and what each set plays to.
 * setTargets[i] is the target of set i+1 (missing entries reuse the last one).
 */
export interface MatchFormat {
  bestOf: number;          // 1 or 3
  setTargets: number[];    // e.g. [21] or [21, 21, 15]
  cap?: number | null;     // hard cap (null/undefined = no cap)
  winBy2?: boolean;        // default true
}

/** Per-round format inside a bracket, keyed by rounds from the end (1 = final, 2 = semifinal, ...). */
export interface BracketRoundFormat extends MatchFormat {
  fromEnd: number;
}

export interface SetScore {
  t1: number;
  t2: number;
}

/**
 * brackets (Gold / Silver / Bronze ...)
 */
export interface Bracket {
  id: UUID;
  tournament_id: UUID;
  name: string;
  sort_order: number;
  /** Pool finishing places (1-based) that feed this bracket. */
  places: number[];
  round_formats: BracketRoundFormat[];
  generated_at: string | null;
  started: boolean;
  created_at?: string;
}

/**
 * tournaments
 */
export interface Tournament {
  id: UUID;
  name: string;
  date: string; // ISO date (date)
  access_code: string; // unique
  advancement_rules: AdvancementRules | null;
  game_rules: GameRules | null;
  status: TournamentStatus;
  bracket_started: boolean; // schema default false
  bracket_generated_at: string | null; // timestamptz
  created_at: string; // timestamptz
  /** Supabase Auth user id of the admin who created the row (RLS ownership). */
  created_by: UUID | null;
}

/**
 * pools
 */
export interface Pool {
  id: UUID;
  tournament_id: UUID;
  name: string; // e.g., "Pool A"
  court_assignment: string | null;
  target_size: number | null;
}

/**
 * teams
 */
export interface Team {
  id: UUID;
  tournament_id: UUID;
  pool_id: UUID | null; // may be null before pools assigned
  seeded_player_name: string;
  full_team_name: string; // Display name used across UI (imported team name or "Seeded + Second")
  seed_in_pool: number | null; // 1,2,3,... within the pool
  seed_global: number | null;   // tournament-wide seed based on import order
}

/**
 * matches
 */
export type MatchType = 'pool' | 'bracket';

export interface Match {
  id: UUID;
  tournament_id: UUID;
  pool_id: UUID | null; // null for bracket matches
  round_number: number | null; // pool round number or null for bracket
  team1_id: UUID | null;
  team2_id: UUID | null;
  ref_team_id: UUID | null;
  team1_score: number | null;
  team2_score: number | null;
  winner_id: UUID | null;
  match_type: MatchType;
  bracket_round: number | null; // e.g., R1=1, QF=2, SF=3, F=4 depending on size
  bracket_match_index?: number | null;
  bracket_id?: UUID | null;      // which bracket (Gold/Silver/...) a bracket match belongs to
  set_scores?: SetScore[] | null; // per-set scores for match play; team1_score/team2_score then hold sets won
  best_of?: number | null;        // null/1 = single set
  set_targets?: number[] | null;  // e.g. [21,21,15]
  court?: string | null;
  is_live: boolean;
  live_score_team1: number | null;
  live_score_team2: number | null;
  live_owner_id?: UUID | null;
  live_last_active_at?: string | null;
}

/**
 * schedule_templates
 * Example template_data:
 * [
 *   { "round": 1, "play": [[1,2]], "ref": [3], "sit": [4] },
 *   { "round": 2, "play": [[1,3]], "ref": [2], "sit": [4] }
 * ]
 */
export interface ScheduleTemplateRound {
  round: number;
  play: number[][]; // array of [seedA, seedB]
  ref?: number[];   // array of seed refs for courts
  sit?: number[];   // optional: seeds sitting out
}

export interface ScheduleTemplate {
  id: UUID;
  tournament_id: UUID;
  pool_size: number;
  template_data: ScheduleTemplateRound[];
}

/**
 * Convenience union for generic record mapping by table name
 */
export interface DB {
  tournaments: Tournament;
  pools: Pool;
  teams: Team;
  matches: Match;
  brackets: Bracket;
  schedule_templates: ScheduleTemplate;
}
