/**
 * Window placement geometry for the per-window Move / Snap commands.
 * Pure — main.ts applies the rectangles with Electron, tests check the
 * arithmetic. Three pieces:
 *
 *  - `placementRect`: every snap target (halves, corners, thirds,
 *    two-thirds, sixths) read off one 6-column × 2-row grid over the
 *    work area, with rounded boundaries so neighbouring placements tile
 *    the area exactly. Coordinates are the work area's own, so the rects
 *    are usable as-is by `setBounds` (second monitors, docks).
 *  - `matchPlacement` / `moveStateFor`: which placement a window's
 *    bounds already sit in (within a few pixels), and the coarser state
 *    the Move commands reason about. Inferred from geometry rather than
 *    remembered, so a window the user dragged by hand is classified the
 *    same as one a command put there, and nothing goes stale.
 *  - `nextMove`: the Win+Arrow-style transition table. Switching sides
 *    passes through the restored middle state (left half + Right →
 *    restore → Right → right half); pressing further into the edge you
 *    are already on does nothing; Up from a half goes to the top corner
 *    on that side, Down to the bottom one; Up from a top corner
 *    maximizes, Down from a bottom corner minimizes. Thirds and sixths
 *    count as "free" here — they are reachable only by the Snap set.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every fixed snap target. Halves and corners double as Move states. */
export type Placement =
  | 'left-half'
  | 'right-half'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'left-third'
  | 'middle-third'
  | 'right-third'
  | 'left-two-thirds'
  | 'right-two-thirds'
  | 'top-left-sixth'
  | 'top-middle-sixth'
  | 'top-right-sixth'
  | 'bottom-left-sixth'
  | 'bottom-middle-sixth'
  | 'bottom-right-sixth';

/** Grid cells in sixths of the width (c0..c1 of 6) and halves of the
 *  height (r0..r1 of 2). */
const CELLS: Record<Placement, { c0: number; c1: number; r0: number; r1: number }> = {
  'left-half': { c0: 0, c1: 3, r0: 0, r1: 2 },
  'right-half': { c0: 3, c1: 6, r0: 0, r1: 2 },
  'top-left': { c0: 0, c1: 3, r0: 0, r1: 1 },
  'top-right': { c0: 3, c1: 6, r0: 0, r1: 1 },
  'bottom-left': { c0: 0, c1: 3, r0: 1, r1: 2 },
  'bottom-right': { c0: 3, c1: 6, r0: 1, r1: 2 },
  'left-third': { c0: 0, c1: 2, r0: 0, r1: 2 },
  'middle-third': { c0: 2, c1: 4, r0: 0, r1: 2 },
  'right-third': { c0: 4, c1: 6, r0: 0, r1: 2 },
  'left-two-thirds': { c0: 0, c1: 4, r0: 0, r1: 2 },
  'right-two-thirds': { c0: 2, c1: 6, r0: 0, r1: 2 },
  'top-left-sixth': { c0: 0, c1: 2, r0: 0, r1: 1 },
  'top-middle-sixth': { c0: 2, c1: 4, r0: 0, r1: 1 },
  'top-right-sixth': { c0: 4, c1: 6, r0: 0, r1: 1 },
  'bottom-left-sixth': { c0: 0, c1: 2, r0: 1, r1: 2 },
  'bottom-middle-sixth': { c0: 2, c1: 4, r0: 1, r1: 2 },
  'bottom-right-sixth': { c0: 4, c1: 6, r0: 1, r1: 2 },
};

export const PLACEMENTS = Object.keys(CELLS) as Placement[];

/** The rectangle `placement` names inside `workArea`. Grid lines are
 *  rounded once each, so adjacent placements share an edge exactly and
 *  a row of thirds (or sixths) sums to the full width. */
export function placementRect(workArea: Rect, placement: Placement): Rect {
  const { c0, c1, r0, r1 } = CELLS[placement];
  const col = (i: number) => workArea.x + Math.round((workArea.width * i) / 6);
  const row = (j: number) => workArea.y + Math.round((workArea.height * j) / 2);
  return { x: col(c0), y: row(r0), width: col(c1) - col(c0), height: row(r1) - row(r0) };
}

/** Bounds match a rect when every edge is within `tolerance` px — enough
 *  for window-manager frame fudge, tight enough that a window a quarter
 *  inch off a half is still "free". */
export const MATCH_TOLERANCE_PX = 8;

export function rectsMatch(a: Rect, b: Rect, tolerance = MATCH_TOLERANCE_PX): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

/** The placement `bounds` currently occupy, or null when they sit in
 *  none of them (a hand-sized window, or one the user dragged). Checked
 *  in the order of PLACEMENTS; the targets never overlap within the
 *  tolerance so the first hit is the only hit. */
export function matchPlacement(bounds: Rect, workArea: Rect, tolerance = MATCH_TOLERANCE_PX): Placement | null {
  for (const p of PLACEMENTS) {
    if (rectsMatch(bounds, placementRect(workArea, p), tolerance)) return p;
  }
  return null;
}

export type MoveDirection = 'left' | 'right' | 'up' | 'down';

/** The states the Move table distinguishes. Thirds, two-thirds and
 *  sixths are "free" to it. */
export type MoveState =
  | 'free'
  | 'maximized'
  | 'left-half'
  | 'right-half'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

const MOVE_PLACEMENTS: ReadonlySet<Placement> = new Set<Placement>([
  'left-half',
  'right-half',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
]);

export function moveStateFor(placement: Placement | null, maximized: boolean): MoveState {
  if (maximized) return 'maximized';
  if (placement && MOVE_PLACEMENTS.has(placement)) return placement as MoveState;
  return 'free';
}

/** What a Move command does from a state: snap to a placement, or one of
 *  the three window-state verbs, or nothing (null). */
export type MoveOutcome = Placement | 'maximize' | 'restore' | 'minimize' | null;

const MOVE_TABLE: Record<MoveState, Record<MoveDirection, MoveOutcome>> = {
  free: { left: 'left-half', right: 'right-half', up: 'maximize', down: 'minimize' },
  maximized: { left: 'left-half', right: 'right-half', up: null, down: 'restore' },
  'left-half': { left: null, right: 'restore', up: 'top-left', down: 'bottom-left' },
  'right-half': { left: 'restore', right: null, up: 'top-right', down: 'bottom-right' },
  'top-left': { left: null, right: 'top-right', up: 'maximize', down: 'left-half' },
  'bottom-left': { left: null, right: 'bottom-right', up: 'left-half', down: 'minimize' },
  'top-right': { left: 'top-left', right: null, up: 'maximize', down: 'right-half' },
  'bottom-right': { left: 'bottom-left', right: null, up: 'right-half', down: 'minimize' },
};

export function nextMove(state: MoveState, direction: MoveDirection): MoveOutcome {
  return MOVE_TABLE[state][direction];
}

/** What the renderer asks main for. `place` is the Snap set (a fixed
 *  target, or maximize / restore); `move` is the stateful set. */
export type WindowPlaceRequest =
  | { kind: 'place'; action: Placement | 'maximize' | 'restore' }
  | { kind: 'move'; direction: MoveDirection };

const MOVE_DIRECTIONS: ReadonlySet<string> = new Set(['left', 'right', 'up', 'down']);

/** Validate an IPC payload (anything can come over the wire). */
export function isWindowPlaceRequest(v: unknown): v is WindowPlaceRequest {
  if (!v || typeof v !== 'object') return false;
  const r = v as { kind?: unknown; action?: unknown; direction?: unknown };
  if (r.kind === 'move') return typeof r.direction === 'string' && MOVE_DIRECTIONS.has(r.direction);
  if (r.kind === 'place') {
    return r.action === 'maximize' || r.action === 'restore' || (typeof r.action === 'string' && r.action in CELLS);
  }
  return false;
}

/** Where Restore puts a window whose saved free bounds are unusable (no
 *  saved bounds yet, or they lie on a display that is gone): centred,
 *  60% × 80% of the work area. */
export function fallbackRestoreRect(workArea: Rect): Rect {
  const width = Math.round(workArea.width * 0.6);
  const height = Math.round(workArea.height * 0.8);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

/** True when at least a usable corner of `rect` lies inside `area` — the
 *  test Restore applies to saved bounds against every current display. */
export function rectVisibleIn(rect: Rect, area: Rect, minPx = 100): boolean {
  const left = Math.max(rect.x, area.x);
  const top = Math.max(rect.y, area.y);
  const right = Math.min(rect.x + rect.width, area.x + area.width);
  const bottom = Math.min(rect.y + rect.height, area.y + area.height);
  return right - left >= minPx && bottom - top >= minPx;
}
