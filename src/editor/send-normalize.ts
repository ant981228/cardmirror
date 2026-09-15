/**
 * Normalize a selection before it's sent (to the dropzone, a starred recipient,
 * or the speech doc) so the sent content is always a clean run of WHOLE
 * top-level nodes that STARTS with a structural unit — never a partial card and
 * never a leading loose paragraph. That guarantees the receiving side can place
 * it by outline level (see `insert-position.ts`) without splitting a card.
 *
 * All rules read the RAW selection (rounding one endpoint must not erase the
 * information the other rule needs):
 *
 *   - **End** → round to the nearest top-level boundary, except inside a
 *     heading: any of its text selected includes it (a caret parked at its very
 *     start — a shift-down onto the next line — does not).
 *   - **Start**, by what the raw `from` sits in:
 *       - card / analytic_unit → round to nearest (include if the caret is past
 *         less than half of it, else exclude — the next node after a card is
 *         always structural, so this never strands a loose paragraph);
 *       - heading → include it (its intro rides along) if the caret is in its
 *         first half, else skip the heading AND its intro to the first
 *         structural unit;
 *       - leading loose paragraph → trim forward to the first structural unit,
 *         UNLESS the selection covers > 75% of that section's intro text, in
 *         which case grab the heading + the whole intro (so the intro can travel
 *         under a structural lead).
 *   - A heading that ENDS the range carries its whole section (to the next
 *     equal-or-shallower heading) — as a bare cursor on it would — so the last
 *     of several selected headings never arrives empty or goes missing.
 *   - If the endpoints collapse, fall back to the most-overlapped structural
 *     unit (a heading again with its section). If the result holds no
 *     structural unit, return `null` (nothing to send — e.g. only loose
 *     paragraphs were selected).
 *
 * Loose paragraphs only ever sit at doc-top or right after a heading (the absorb
 * plugin folds any post-card paragraph into the card), so the only problematic
 * position is a LEADING loose paragraph; any loose paragraph after the first
 * structural node is post-heading and travels fine.
 */

import { type Node as PMNode } from 'prosemirror-model';
import { sectionEndFromHeading, TYPE_TO_LEVEL } from './headings.js';

const STRUCTURAL = new Set(['card', 'analytic_unit', 'pocket', 'hat', 'block']);
const HEADING = new Set(['pocket', 'hat', 'block']);
const INTRO_COVERAGE_TO_GRAB_HEADING = 0.75;

export interface SendRange {
  from: number;
  to: number;
}

interface TopChild {
  node: PMNode;
  start: number;
  end: number;
  index: number;
}

function topChildren(doc: PMNode): TopChild[] {
  const out: TopChild[] = [];
  doc.forEach((node, offset, index) => {
    out.push({ node, start: offset, end: offset + node.nodeSize, index });
  });
  return out;
}

function childContaining(children: TopChild[], p: number): TopChild | null {
  for (const c of children) if (p >= c.start && p < c.end) return c;
  return null; // at doc end / a gap
}

const isStructural = (c: TopChild): boolean => STRUCTURAL.has(c.node.type.name);

function roundToNearest(c: TopChild, p: number): number {
  return p <= (c.start + c.end) / 2 ? c.start : c.end;
}

/** Start of the first structural child at or after `index`; doc end if none. */
function firstStructuralStartAtOrAfter(
  children: TopChild[],
  index: number,
  docEnd: number,
): number {
  for (let i = index; i < children.length; i++) {
    if (isStructural(children[i]!)) return children[i]!.start;
  }
  return docEnd;
}

/** Start boundary when the raw caret sits in a leading loose (non-structural)
 *  node: grab the section heading + its whole intro if > 75% of that intro's
 *  text is selected, otherwise trim forward to the first structural unit. */
function resolveLooseStart(
  doc: PMNode,
  children: TopChild[],
  looseIndex: number,
  from: number,
  to: number,
  docEnd: number,
): number {
  // The maximal run of consecutive non-structural nodes around the caret.
  let runStart = looseIndex;
  let runEnd = looseIndex;
  while (runStart - 1 >= 0 && !isStructural(children[runStart - 1]!)) runStart--;
  while (runEnd + 1 < children.length && !isStructural(children[runEnd + 1]!)) runEnd++;

  const beforeIdx = runStart - 1;
  if (beforeIdx >= 0 && HEADING.has(children[beforeIdx]!.node.type.name)) {
    const runFrom = children[runStart]!.start;
    const runTo = children[runEnd]!.end;
    const total = doc.textBetween(runFrom, runTo, '\n').length;
    const a = Math.max(from, runFrom);
    const b = Math.min(to, runTo);
    const selected = b > a ? doc.textBetween(a, b, '\n').length : 0;
    if (total > 0 && selected / total > INTRO_COVERAGE_TO_GRAB_HEADING) {
      return children[beforeIdx]!.start; // grab heading + whole intro
    }
  }
  return firstStructuralStartAtOrAfter(children, runEnd + 1, docEnd);
}

/** End of `c`'s range: a heading runs to the end of its section, anything
 *  else to its own end. */
function unitEnd(doc: PMNode, c: TopChild): number {
  const level = TYPE_TO_LEVEL[c.node.type.name];
  if (!HEADING.has(c.node.type.name) || level === undefined) return c.end;
  return sectionEndFromHeading(doc, c.index, c.end, level);
}

function mostOverlappedStructural(
  children: TopChild[],
  from: number,
  to: number,
): TopChild | null {
  let best: TopChild | null = null;
  let bestLen = 0;
  for (const c of children) {
    if (!isStructural(c)) continue;
    const len = Math.min(to, c.end) - Math.max(from, c.start);
    if (len > bestLen) {
      bestLen = len;
      best = c;
    }
  }
  return best;
}

export function normalizeSelectionForSend(
  doc: PMNode,
  from: number,
  to: number,
): SendRange | null {
  const children = topChildren(doc);
  if (children.length === 0) return null;
  const docEnd = doc.content.size;

  // End: round to the nearest top-level boundary (trailing loose paragraphs are
  // post-heading and travel fine, so no carve-out is needed here). A heading is
  // included once any of its text is selected — `to` past its opening position.
  const toChild = childContaining(children, to);
  let toPrime = !toChild
    ? docEnd
    : HEADING.has(toChild.node.type.name)
      ? to > toChild.start + 1
        ? toChild.end
        : toChild.start
      : roundToNearest(toChild, to);

  // Start: branch on what the raw `from` sits in.
  let fromPrime: number;
  const fromChild = childContaining(children, from);
  if (!fromChild) {
    fromPrime = docEnd;
  } else if (HEADING.has(fromChild.node.type.name)) {
    fromPrime =
      from <= (fromChild.start + fromChild.end) / 2
        ? fromChild.start // include heading; its intro rides along
        : firstStructuralStartAtOrAfter(children, fromChild.index + 1, docEnd);
  } else if (isStructural(fromChild)) {
    fromPrime = roundToNearest(fromChild, from); // card / analytic_unit
  } else {
    fromPrime = resolveLooseStart(doc, children, fromChild.index, from, to, docEnd);
  }

  // Collapsed → the most-overlapped structural unit (or nothing to send).
  if (fromPrime >= toPrime) {
    const best = mostOverlappedStructural(children, from, to);
    return best ? { from: best.start, to: unitEnd(doc, best) } : null;
  }

  // A heading ending the range would otherwise arrive bare, its cards left
  // behind: carry its whole section, as the bare-cursor send does.
  const last = children.find((c) => c.end === toPrime);
  if (last && last.start >= fromPrime) toPrime = unitEnd(doc, last);

  // The range must hold a whole structural unit, else there's nothing to send.
  const hasStructural = children.some(
    (c) => c.start >= fromPrime && c.end <= toPrime && isStructural(c),
  );
  return hasStructural ? { from: fromPrime, to: toPrime } : null;
}
