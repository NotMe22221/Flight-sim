/**
 * Runway end designators and displaced thresholds, robust to the two runway shapes in the
 * codebase: the navigation database's records (`ident` = low end only, plus `ends[]`) and plain
 * `Runway` objects whose `ident` is "10L/28R".
 */
import type { Runway } from '../core/types';

interface EndLike { ident: string; displacedThresholdM?: number }

/** Reciprocal designator: "10L" → "28R", "1" → "19", "36C" → "18C". */
export function reciprocalIdent(id: string): string {
  const m = /^(\d{1,2})([LRC]?)$/.exec(id.trim().toUpperCase());
  if (!m) return '';
  let n = (Number(m[1]) + 18) % 36;
  if (n === 0) n = 36;
  const side = m[2] === 'L' ? 'R' : m[2] === 'R' ? 'L' : m[2];
  return `${n}${side}`;
}

/** [low end, high end] designators of a runway (A = `threshold`, B = `end`). */
export function runwayEndIdents(rw: Runway): [string, string] {
  const ends = (rw as Runway & { ends?: EndLike[] }).ends;
  if (ends && ends.length === 2 && ends[0]?.ident && ends[1]?.ident) return [ends[0].ident, ends[1].ident];
  if (rw.ident.includes('/')) {
    const [a, b] = rw.ident.split('/');
    return [a ?? '', b ?? reciprocalIdent(a ?? '')];
  }
  return [rw.ident, reciprocalIdent(rw.ident)];
}

/** Displaced threshold of the high (B) end, m. */
export function runwayEndDisplacementB(rw: Runway): number {
  const ends = (rw as Runway & { ends?: EndLike[]; displacedThresholdEndM?: number }).ends;
  if (ends && ends.length === 2) return ends[1]?.displacedThresholdM ?? 0;
  return (rw as Runway & { displacedThresholdEndM?: number }).displacedThresholdEndM ?? 0;
}
