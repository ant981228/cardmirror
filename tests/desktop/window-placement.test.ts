/**
 * Move / Snap Window geometry and the Win+Arrow-style transition table.
 * Everything that decides WHAT happens is pure and lives here; main.ts
 * only applies the result with Electron.
 */
import { describe, it, expect } from 'vitest';
import {
  PLACEMENTS,
  fallbackRestoreRect,
  isWindowPlaceRequest,
  matchPlacement,
  moveStateFor,
  nextMove,
  placementRect,
  rectVisibleIn,
  type MoveDirection,
  type MoveOutcome,
  type MoveState,
  type Placement,
  type Rect,
} from '../../apps/desktop/src/window-placement';
import {
  WINDOW_PLACE_COMMANDS,
  WINDOW_PLACE_COMMAND_IDS,
} from '../../src/editor/window-placement-commands.js';

// A second-monitor-ish work area: non-zero origin, a width that does not
// divide by 6, a height that does not divide by 2.
const area: Rect = { x: 1920, y: 25, width: 1601, height: 955 };

const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;

describe('placementRect', () => {
  it('halves split the width and run full height', () => {
    const l = placementRect(area, 'left-half');
    const r = placementRect(area, 'right-half');
    expect(l.x).toBe(area.x);
    expect(l.height).toBe(area.height);
    expect(right(l)).toBe(r.x);
    expect(right(r)).toBe(right(area));
    expect(Math.abs(l.width - r.width)).toBeLessThanOrEqual(1);
  });

  it('corners quarter the area and meet at the centre lines', () => {
    const tl = placementRect(area, 'top-left');
    const br = placementRect(area, 'bottom-right');
    expect(tl.x).toBe(area.x);
    expect(tl.y).toBe(area.y);
    expect(right(tl)).toBe(br.x);
    expect(bottom(tl)).toBe(br.y);
    expect(right(br)).toBe(right(area));
    expect(bottom(br)).toBe(bottom(area));
  });

  it('thirds tile the width exactly, two-thirds share the thirds grid lines', () => {
    const [a, b, c] = (['left-third', 'middle-third', 'right-third'] as const).map((p) => placementRect(area, p));
    expect(a!.x).toBe(area.x);
    expect(right(a!)).toBe(b!.x);
    expect(right(b!)).toBe(c!.x);
    expect(right(c!)).toBe(right(area));
    expect(a!.width + b!.width + c!.width).toBe(area.width);
    const lt = placementRect(area, 'left-two-thirds');
    const rt = placementRect(area, 'right-two-thirds');
    expect(right(lt)).toBe(c!.x);
    expect(rt.x).toBe(b!.x);
    expect(lt.width + c!.width).toBe(area.width);
    expect(a!.width + rt.width).toBe(area.width);
  });

  it('sixths tile the area exactly in a 3 × 2 grid', () => {
    const top = (['top-left-sixth', 'top-middle-sixth', 'top-right-sixth'] as const).map((p) => placementRect(area, p));
    const bot = (['bottom-left-sixth', 'bottom-middle-sixth', 'bottom-right-sixth'] as const).map((p) => placementRect(area, p));
    expect(top.reduce((s, r) => s + r.width, 0)).toBe(area.width);
    for (let i = 0; i < 3; i++) {
      expect(top[i]!.x).toBe(bot[i]!.x);
      expect(top[i]!.width).toBe(bot[i]!.width);
      expect(bottom(top[i]!)).toBe(bot[i]!.y);
      expect(top[i]!.height + bot[i]!.height).toBe(area.height);
    }
    expect(top[0]!.x).toBe(placementRect(area, 'left-third').x);
    expect(right(top[2]!)).toBe(right(area));
    expect(bottom(bot[0]!)).toBe(bottom(area));
  });

  it('every placement stays inside the work area and uses its coordinates', () => {
    for (const p of PLACEMENTS) {
      const r = placementRect(area, p);
      expect(r.x).toBeGreaterThanOrEqual(area.x);
      expect(r.y).toBeGreaterThanOrEqual(area.y);
      expect(right(r)).toBeLessThanOrEqual(right(area));
      expect(bottom(r)).toBeLessThanOrEqual(bottom(area));
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
    }
  });
});

describe('matchPlacement', () => {
  it('recognizes every placement from its own rect, and within a few pixels of it', () => {
    for (const p of PLACEMENTS) {
      const r = placementRect(area, p);
      expect(matchPlacement(r, area)).toBe(p);
      expect(matchPlacement({ ...r, x: r.x + 5, width: r.width - 7 }, area)).toBe(p);
    }
  });

  it('returns null for a hand-sized window and for one clearly off a target', () => {
    expect(matchPlacement({ x: area.x + 300, y: area.y + 120, width: 900, height: 700 }, area)).toBeNull();
    const l = placementRect(area, 'left-half');
    expect(matchPlacement({ ...l, width: l.width - 40 }, area)).toBeNull();
  });

  it('is unambiguous: no two placements match the same rect', () => {
    for (const p of PLACEMENTS) {
      const r = placementRect(area, p);
      const hits = PLACEMENTS.filter((q) => matchPlacement(r, area) === q);
      expect(hits).toEqual([p]);
    }
  });
});

describe('moveStateFor', () => {
  it('maximized wins over any geometry', () => {
    expect(moveStateFor('left-half', true)).toBe('maximized');
    expect(moveStateFor(null, true)).toBe('maximized');
  });
  it('halves and corners are their own states; thirds, two-thirds and sixths are free', () => {
    for (const p of ['left-half', 'right-half', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      expect(moveStateFor(p, false)).toBe(p);
    }
    for (const p of PLACEMENTS.filter((q) => /third|sixth/.test(q))) {
      expect(moveStateFor(p, false)).toBe('free');
    }
    expect(moveStateFor(null, false)).toBe('free');
  });
});

describe('nextMove (the Win+Arrow-style table)', () => {
  const table: Record<MoveState, Record<MoveDirection, MoveOutcome>> = {
    free: { left: 'left-half', right: 'right-half', up: 'maximize', down: 'minimize' },
    maximized: { left: 'left-half', right: 'right-half', up: null, down: 'restore' },
    'left-half': { left: null, right: 'restore', up: 'top-left', down: 'bottom-left' },
    'right-half': { left: 'restore', right: null, up: 'top-right', down: 'bottom-right' },
    'top-left': { left: null, right: 'top-right', up: 'maximize', down: 'left-half' },
    'bottom-left': { left: null, right: 'bottom-right', up: 'left-half', down: 'minimize' },
    'top-right': { left: 'top-left', right: null, up: 'maximize', down: 'right-half' },
    'bottom-right': { left: 'bottom-left', right: null, up: 'right-half', down: 'minimize' },
  };

  it('matches the agreed table cell for cell', () => {
    for (const state of Object.keys(table) as MoveState[]) {
      for (const dir of ['left', 'right', 'up', 'down'] as const) {
        expect(nextMove(state, dir), `${state} + ${dir}`).toBe(table[state][dir]);
      }
    }
  });

  it('pressing further into the edge you are on does nothing', () => {
    expect(nextMove('left-half', 'left')).toBeNull();
    expect(nextMove('right-half', 'right')).toBeNull();
    expect(nextMove('top-left', 'left')).toBeNull();
    expect(nextMove('bottom-right', 'right')).toBeNull();
    expect(nextMove('maximized', 'up')).toBeNull();
  });

  it('switching sides from a half goes through restore, so it takes two taps', () => {
    const first = nextMove('left-half', 'right');
    expect(first).toBe('restore');
    expect(nextMove('free', 'right')).toBe('right-half');
  });

  it('corners cross directly', () => {
    expect(nextMove('top-left', 'right')).toBe('top-right');
    expect(nextMove('bottom-right', 'left')).toBe('bottom-left');
  });

  it('never yields a third or a sixth — those are Snap-only', () => {
    for (const state of Object.keys(table) as MoveState[]) {
      for (const dir of ['left', 'right', 'up', 'down'] as const) {
        const out = nextMove(state, dir);
        if (out) expect(out).not.toMatch(/third|sixth/);
      }
    }
  });
});

describe('restore helpers', () => {
  it('fallbackRestoreRect centres a 60% × 80% window in the work area', () => {
    const r = fallbackRestoreRect(area);
    expect(r.width).toBe(Math.round(area.width * 0.6));
    expect(r.height).toBe(Math.round(area.height * 0.8));
    expect(Math.abs(r.x - area.x - (right(area) - right(r)))).toBeLessThanOrEqual(1);
    expect(Math.abs(r.y - area.y - (bottom(area) - bottom(r)))).toBeLessThanOrEqual(1);
  });

  it('rectVisibleIn needs a usable overlap, not a sliver', () => {
    const saved: Rect = { x: area.x + 100, y: area.y + 100, width: 800, height: 600 };
    expect(rectVisibleIn(saved, area)).toBe(true);
    expect(rectVisibleIn({ ...saved, x: right(area) - 20 }, area)).toBe(false);
    expect(rectVisibleIn({ ...saved, x: area.x - 5000 }, area)).toBe(false);
  });
});

describe('isWindowPlaceRequest (IPC payload guard)', () => {
  it('accepts every request the renderer command table sends', () => {
    for (const id of WINDOW_PLACE_COMMAND_IDS) {
      expect(isWindowPlaceRequest(WINDOW_PLACE_COMMANDS[id].request), id).toBe(true);
    }
  });
  it('rejects junk', () => {
    expect(isWindowPlaceRequest(null)).toBe(false);
    expect(isWindowPlaceRequest('left-half')).toBe(false);
    expect(isWindowPlaceRequest({ kind: 'place', action: 'diagonal' })).toBe(false);
    expect(isWindowPlaceRequest({ kind: 'move', direction: 'sideways' })).toBe(false);
    expect(isWindowPlaceRequest({ kind: 'teleport' })).toBe(false);
  });
});

describe('renderer command table ↔ desktop placements', () => {
  it('every desktop placement has exactly one Snap command, and vice versa', () => {
    const fromCommands = WINDOW_PLACE_COMMAND_IDS.map((id) => WINDOW_PLACE_COMMANDS[id].request)
      .filter((r): r is { kind: 'place'; action: Placement } => r.kind === 'place' && r.action !== 'maximize' && r.action !== 'restore')
      .map((r) => r.action)
      .sort();
    expect(fromCommands).toEqual([...PLACEMENTS].sort());
  });
  it('has one Move command per direction plus maximize and restore', () => {
    const reqs = WINDOW_PLACE_COMMAND_IDS.map((id) => WINDOW_PLACE_COMMANDS[id].request);
    const dirs = reqs.filter((r) => r.kind === 'move').map((r) => (r as { direction: string }).direction).sort();
    expect(dirs).toEqual(['down', 'left', 'right', 'up']);
    const verbs = reqs.filter((r) => r.kind === 'place' && (r.action === 'maximize' || r.action === 'restore'));
    expect(verbs).toHaveLength(2);
    expect(WINDOW_PLACE_COMMAND_IDS).toHaveLength(PLACEMENTS.length + 4 + 2);
  });
});
