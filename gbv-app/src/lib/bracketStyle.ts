/** Visual identity for named brackets (Gold / Silver / Bronze ...), shared by admin and public pages. */
export type Medal = { key: string; label: string; dot: string; chip: string; ring: string };

const MEDALS: Record<string, Medal> = {
  gold: { key: 'gold', label: 'Gold', dot: '#d4a514', chip: 'rgba(212,165,20,0.16)', ring: 'rgba(212,165,20,0.55)' },
  silver: { key: 'silver', label: 'Silver', dot: '#8e9aa8', chip: 'rgba(142,154,168,0.18)', ring: 'rgba(142,154,168,0.6)' },
  bronze: { key: 'bronze', label: 'Bronze', dot: '#b4683a', chip: 'rgba(180,104,58,0.16)', ring: 'rgba(180,104,58,0.55)' },
};
const FALLBACK: Medal[] = [
  { key: 'c1', label: '', dot: '#3b82f6', chip: 'rgba(59,130,246,0.15)', ring: 'rgba(59,130,246,0.5)' },
  { key: 'c2', label: '', dot: '#10b981', chip: 'rgba(16,185,129,0.15)', ring: 'rgba(16,185,129,0.5)' },
  { key: 'c3', label: '', dot: '#a855f7', chip: 'rgba(168,85,247,0.15)', ring: 'rgba(168,85,247,0.5)' },
];

export function medalFor(name: string, index = 0): Medal {
  const k = name.trim().toLowerCase();
  for (const m of Object.values(MEDALS)) if (k.startsWith(m.key)) return m;
  return FALLBACK[index % FALLBACK.length];
}

/** "Places 1–2" / "Place 3" / "Places 3, 5" */
export function placesLabel(places: number[]): string {
  const p = [...places].sort((a, b) => a - b);
  if (!p.length) return 'No places';
  const contiguous = p.every((v, i) => i === 0 || v === p[i - 1] + 1);
  const ord = (n: number) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
  if (p.length === 1) return `${ord(p[0])} in pool`;
  return contiguous ? `${ord(p[0])}–${ord(p[p.length - 1])} in pool` : `${p.map(ord).join(', ')} in pool`;
}
