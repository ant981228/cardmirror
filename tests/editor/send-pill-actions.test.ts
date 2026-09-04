// @vitest-environment jsdom
/**
 * Send pill: the bottom actions row (add contact / start session ↔ the
 * drag zones), hidden-recipient filtering, and the recent-senders drag list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const promptForText = vi.fn(async (_opts?: unknown) => null as string | null);
vi.mock('../../src/editor/text-prompt.js', () => ({
  promptForText: (o: unknown) => promptForText(o as never),
}));
const recentSendersMock = vi.fn((): { code: string; name: string; at: number }[] => []);
vi.mock('../../src/editor/pairing/inbox-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recentSenders: () => recentSendersMock(),
}));
vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));

import { SendPillController, bundleSendItems, edgeAutoscrollStep } from '../../src/editor/pairing/send-pill-ui.js';
import { dragController } from '../../src/editor/drag-controller.js';
import { Slice, Fragment } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { settings } from '../../src/editor/settings.js';
import {
  setCollabSessionStarter,
  setCollabShareCodeGetter,
} from '../../src/editor/collab/collab-hooks.js';
import { showToast } from '../../src/editor/toast.js';
import * as collabGate from '../../src/editor/collab/collab-gate.js';

function mountPill(): { pill: SendPillController; root: HTMLElement } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const pill = new SendPillController();
  pill.mount({ parent });
  return { pill, root: parent };
}

beforeEach(() => {
  settings.set('pairingEnabled', true);
  settings.set('pairingPartners', []);
  settings.set('pairingGroups', []);
  settings.set('pairingBlockedCodes', []);
  recentSendersMock.mockReturnValue([]);
  promptForText.mockReset();
  vi.mocked(showToast).mockClear();
});

afterEach(() => {
  document.body.innerHTML = '';
  settings.set('pairingPartners', []);
  settings.set('pairingEnabled', false);
  setCollabSessionStarter(null);
  setCollabShareCodeGetter(null);
  vi.restoreAllMocks();
});

describe('send pill actions row + hidden recipients', () => {
  it('hidden recipients vanish from the pill rows; groups still fan out to them', () => {
    settings.set('pairingPartners', [
      { code: 'cmk1.aaa', name: 'Awake' },
      { code: 'cmk1.bbb', name: 'Sleepy', hidden: true },
    ]);
    settings.set('pairingGroups', [
      { id: 'g1', label: 'Team', memberCodes: ['cmk1.aaa', 'cmk1.bbb'] },
    ]);
    const { root } = mountPill();
    const rowNames = [...root.querySelectorAll('.pmd-send-target-name')].map(
      (el) => el.textContent,
    );
    expect(rowNames).toContain('Awake');
    expect(rowNames).toContain('Team');
    expect(rowNames).not.toContain('Sleepy'); // hidden → no pill row
    // …but the group target still reaches the hidden member.
    const pillAny = document.querySelector('.pmd-send-pill');
    expect(pillAny).toBeTruthy();
    const groupCount = root.querySelector('.pmd-send-target-count');
    expect(groupCount?.textContent).toBe('2'); // both members, hidden included
  });

  it('the actions row renders; Start session hides while the collab gate is closed', () => {
    const { root } = mountPill();
    const actions = root.querySelectorAll('.pmd-send-action');
    expect(actions.length).toBe(2);
    expect(actions[0]!.textContent).toContain('Add contact');
    // No collab starter registered (gate closed) → hidden by class.
    expect(actions[1]!.classList.contains('pmd-send-action-collab-hidden')).toBe(true);
  });

  it('session action toggles: Copy code with a live session, Start session without', () => {
    vi.spyOn(collabGate, 'collabEnabled').mockReturnValue(true);
    const starter = vi.fn();
    setCollabSessionStarter(starter);
    const CODE = `cmshare2.${'a'.repeat(32)}.key456.1.0.0`;
    setCollabShareCodeGetter(() => CODE);
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const { root } = mountPill();
    (root.querySelector('.pmd-send-bar') as HTMLElement).click();
    const btn = root.querySelectorAll('.pmd-send-action')[1] as HTMLElement;
    expect(btn.classList.contains('pmd-send-action-collab-hidden')).toBe(false);
    expect(btn.textContent).toContain('Copy code');
    btn.click();
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(starter).not.toHaveBeenCalled();

    // Session gone (ended, or focus moved to a session-less doc): the
    // next open shows Start session again and the click starts one.
    setCollabShareCodeGetter(() => null);
    (root.querySelector('.pmd-send-bar') as HTMLElement).click();
    expect(btn.textContent).toContain('Start session');
    btn.click();
    expect(starter).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledTimes(1); // no second copy
  });

  it('hidden flag survives the settings sanitize round-trip', () => {
    settings.set('pairingPartners', [
      { code: 'cmk1.aaa', name: 'Keep', hidden: true },
      { code: 'cmk1.bbb', name: 'Plain' },
    ]);
    const back = settings.get('pairingPartners');
    expect(back[0]!.hidden).toBe(true);
    expect(back[1]!.hidden).toBeUndefined();
  });

  it('Add contact: code prompt, then a name prompt pre-filled from recent senders', async () => {
    settings.set('pairingPartners', [{ code: 'cmk1.first', name: 'First' }]);
    recentSendersMock.mockReturnValue([{ code: 'cmk1.newperson', name: 'Priya', at: 1 }]);
    promptForText.mockResolvedValueOnce('cmk1.newperson'); // code
    promptForText.mockResolvedValueOnce('Priya K'); // name (user edited)
    const { root } = mountPill();
    // Open click mode and press the button.
    (root.querySelector('.pmd-send-bar') as HTMLElement).click();
    (root.querySelector('.pmd-send-action') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));

    const partners = settings.get('pairingPartners');
    expect(partners.map((p) => p.code)).toEqual(['cmk1.first', 'cmk1.newperson']);
    expect(partners[1]!.name).toBe('Priya K');
    // The name prompt was pre-filled with the ledger's name.
    const nameCall = promptForText.mock.calls[1]![0] as { initial?: string };
    expect(nameCall.initial).toBe('Priya');
  });

  it('Add contact: cancelling the name prompt aborts the whole add', async () => {
    const { root } = mountPill();
    (root.querySelector('.pmd-send-bar') as HTMLElement).click();
    promptForText.mockResolvedValueOnce('cmk1.someone'); // code accepted
    promptForText.mockResolvedValueOnce(null); // name cancelled
    (root.querySelector('.pmd-send-action') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(settings.get('pairingPartners')).toHaveLength(0);
  });

  it('Add contact refuses duplicates and junk codes', async () => {
    settings.set('pairingPartners', [{ code: 'cmk1.first', name: 'First' }]);
    const { root } = mountPill();
    (root.querySelector('.pmd-send-bar') as HTMLElement).click();

    promptForText.mockResolvedValueOnce('cmk1.first');
    (root.querySelector('.pmd-send-action') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(settings.get('pairingPartners')).toHaveLength(1);

    (root.querySelector('.pmd-send-bar') as HTMLElement).click();
    promptForText.mockResolvedValueOnce('not a code');
    (root.querySelector('.pmd-send-action') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(settings.get('pairingPartners')).toHaveLength(1);
    expect(vi.mocked(showToast).mock.calls.flat().join(' ')).toContain('pairing code');
  });

  it('the drag recent-senders list excludes blocked codes and labels known partners', () => {
    settings.set('pairingPartners', [{ code: 'cmk1.known', name: 'Ana' }]);
    settings.set('pairingBlockedCodes', ['cmk1.badguy']);
    recentSendersMock.mockReturnValue([
      { code: 'cmk1.known', name: 'self-declared', at: 3 },
      { code: 'cmk1.badguy', name: 'Bad', at: 2 },
      { code: 'cmk1.stranger', name: 'Sam', at: 1 },
    ]);
    const { root } = mountPill();
    const section = root.querySelector('.pmd-send-recent-flyout')!;
    expect(section).toBeTruthy();
    expect((section as HTMLElement).hidden).toBe(true); // drag-only reveal
    const labels = [...section.querySelectorAll('.pmd-send-target-name')].map(
      (el) => el.textContent,
    );
    expect(labels).toContain('Ana'); // your nickname wins over self-declared
    expect(labels).toContain('Sam');
    expect(labels.join(' ')).not.toContain('Bad');
  });
});

describe('multi-selection bundling', () => {
  const cardNode = (tag: string, body: string) =>
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
      schema.nodes['card_body']!.create(null, schema.text(body)),
    ]);
  const closed = (n: ReturnType<typeof cardNode>) => new Slice(Fragment.from(n), 0, 0);

  it('several closed card slices ship as ONE atomic item', () => {
    const out = bundleSendItems([
      { slice: closed(cardNode('Alpha', 'a body')), type: 'card', label: 'Alpha' },
      { slice: closed(cardNode('Beta', 'b body')), type: 'card', label: 'Beta' },
      { slice: closed(cardNode('Gamma', 'c body')), type: 'card', label: 'Gamma' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe('Alpha + 2 more');
    expect(out[0]!.type).toBe('card');
    const json = out[0]!.sliceJson as { content: unknown[] };
    expect(json.content).toHaveLength(3); // all three cards, in order
  });

  it('an open text fragment falls back to per-item sends', () => {
    const open = new Slice(Fragment.from(schema.text('loose text')), 1, 1);
    const out = bundleSendItems([
      { slice: closed(cardNode('Alpha', 'a')), type: 'card', label: 'Alpha' },
      { slice: open, type: 'text', label: 'loose' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('the ×N badge counts the HIGHEST outline level, not top-level nodes', async () => {
    const { inboxItemCardCount } = await import('../../src/editor/pairing/inbox-store.js');
    const block = (label: string) =>
      schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(label));
    const sliceOf = (...nodes: ReturnType<typeof cardNode>[]) =>
      new Slice(Fragment.from(nodes), 0, 0);

    // One dragged block = [block, card, card] → ×1, not ×3.
    const oneBlock = sliceOf(block('B1'), cardNode('A', 'x'), cardNode('B', 'y'));
    expect(inboxItemCardCount({ sliceJson: oneBlock.toJSON() })).toBe(1);

    // Two blocks (each with cards) → ×2: the blocks count, their cards don't.
    const twoBlocks = sliceOf(
      block('B1'),
      cardNode('A', 'x'),
      block('B2'),
      cardNode('B', 'y'),
      cardNode('C', 'z'),
    );
    expect(inboxItemCardCount({ sliceJson: twoBlocks.toJSON() })).toBe(2);

    // Three bare cards → ×3.
    const bundled = bundleSendItems([
      { slice: closed(cardNode('A', 'x')), type: 'card', label: 'A' },
      { slice: closed(cardNode('B', 'y')), type: 'card', label: 'B' },
      { slice: closed(cardNode('C', 'z')), type: 'card', label: 'C' },
    ])[0]!;
    expect(inboxItemCardCount({ sliceJson: bundled.sliceJson })).toBe(3);

    const single = bundleSendItems([
      { slice: closed(cardNode('A', 'x')), type: 'card', label: 'A' },
    ])[0]!;
    expect(inboxItemCardCount({ sliceJson: single.sliceJson })).toBe(1);
    expect(inboxItemCardCount({ sliceJson: null })).toBe(1); // malformed → plain
  });
});

describe('drag autoscroll over the send pill (field report 2026-09-04)', () => {
  it('edgeAutoscrollStep: zero mid-list, grows toward the edges, negative at the top', () => {
    const rect = { top: 100, bottom: 400 };
    expect(edgeAutoscrollStep(250, rect)).toBe(0);
    expect(edgeAutoscrollStep(50, rect)).toBe(0); // outside
    expect(edgeAutoscrollStep(399, rect)).toBeGreaterThan(edgeAutoscrollStep(380, rect));
    expect(edgeAutoscrollStep(380, rect)).toBeGreaterThan(0);
    expect(edgeAutoscrollStep(101, rect)).toBeLessThan(0);
    expect(edgeAutoscrollStep(150, { top: 100, bottom: 140 })).toBe(0); // too short for bands
  });

  it('a pointer resting in the bottom band scrolls the expanded list frame after frame and re-hit-tests', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    try {
      settings.set(
        'pairingPartners',
        Array.from({ length: 30 }, (_, i) => ({ code: `cmk1.p${i}`, name: `Partner ${i}` })),
      );
      const { pill, root } = mountPill();
      const panel = root.querySelector('.pmd-send-panel') as HTMLElement;
      const bar = root.querySelector('.pmd-send-bar') as HTMLElement;
      // jsdom has no layout: give the panel a box, a scroll range, and a live scrollTop.
      panel.getBoundingClientRect = () => ({ top: 100, bottom: 400, left: 0, right: 300, width: 300, height: 300, x: 0, y: 100, toJSON: () => ({}) });
      bar.getBoundingClientRect = () => ({ top: 406, bottom: 430, left: 0, right: 120, width: 120, height: 24, x: 0, y: 406, toJSON: () => ({}) });
      Object.defineProperty(panel, 'scrollHeight', { value: 1200, configurable: true });
      Object.defineProperty(panel, 'clientHeight', { value: 300, configurable: true });
      let top = 0;
      Object.defineProperty(panel, 'scrollTop', { get: () => top, set: (v: number) => { top = v; }, configurable: true });
      const surface = (pill as unknown as { surface: { hitTest: (x: number, y: number) => unknown; highlight: (el: HTMLElement | null) => void } }).surface;
      const rehits = vi.spyOn(dragController, 'dispatchHit').mockImplementation(() => {});
      // Expand (the controller does this via highlight) and rest the pointer in the bottom band.
      surface.highlight(bar);
      expect(surface.hitTest(150, 395)).not.toBeNull();
      vi.advanceTimersByTime(16 * 5);
      expect(top).toBeGreaterThan(0);
      expect(rehits).toHaveBeenCalled();
      const afterFive = top;
      vi.advanceTimersByTime(16 * 5);
      expect(top).toBeGreaterThan(afterFive);
      // Moving to the middle of the list stops it.
      surface.hitTest(150, 250);
      const settled = top;
      vi.advanceTimersByTime(16 * 5);
      expect(top).toBe(settled);
      // Collapse (drag end) stops it too.
      surface.hitTest(150, 395);
      surface.highlight(null);
      const collapsedAt = top;
      vi.advanceTimersByTime(16 * 5);
      expect(top).toBe(collapsedAt);
    } finally {
      vi.useRealTimers();
    }
  });
});
