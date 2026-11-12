import supabase from './supabase';
import { roundName } from './standings';
import { formatFromMatch, formatLabel } from './scoring';

type Ctx = {
  match_type: 'pool' | 'bracket';
  pool_id: string | null;
  round_number: number | null;
  bracket_id?: string | null;
  bracket_round?: number | null;
  best_of?: number | null;
  set_targets?: number[] | null;
};

/** Where a match sits, e.g. "Gold · Semifinals" or "Pool 2 · Round 3", plus its format label. */
export async function matchContext(m: Ctx): Promise<{ where: string; format: string }> {
  const format = formatLabel(formatFromMatch(m));
  if (m.match_type === 'bracket') {
    let name = 'Bracket';
    let total = m.bracket_round ?? 1;
    if (m.bracket_id) {
      const [b, r] = await Promise.all([
        supabase.from('brackets').select('name').eq('id', m.bracket_id).maybeSingle(),
        supabase.from('matches').select('bracket_round').eq('bracket_id', m.bracket_id).order('bracket_round', { ascending: false }).limit(1),
      ]);
      name = (b.data as { name: string } | null)?.name ?? name;
      total = (r.data as Array<{ bracket_round: number }> | null)?.[0]?.bracket_round ?? total;
    }
    return { where: `${name} · ${roundName(m.bracket_round ?? 1, total)}`, format };
  }
  let pool = 'Pool';
  if (m.pool_id) {
    const { data } = await supabase.from('pools').select('name').eq('id', m.pool_id).maybeSingle();
    pool = (data as { name: string } | null)?.name ?? pool;
  }
  return { where: `${pool} · Round ${m.round_number ?? '—'}`, format };
}
