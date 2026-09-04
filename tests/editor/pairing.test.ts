import { describe, it, expect } from 'vitest';
import { SettingsStore } from '../../src/editor/settings.js';
import { resolveStarredTarget } from '../../src/editor/pairing/send-to-starred.js';
import { listRecipientChoices } from '../../src/editor/pairing/send-to-recipient.js';
import {
  filterBlockedItems,
  mergeRecentSenders,
  type InboxItem,
  type RecentSender,
} from '../../src/editor/pairing/inbox-store.js';

// SettingsStore.replaceAll runs everything through sanitize(), so these exercise
// the pairing sanitizers (sanitizePairingPartners/Groups/Starred).
describe('pairing settings sanitize', () => {
  it('dedupes recipients by code and drops fully-empty entries', () => {
    const s = new SettingsStore();
    s.replaceAll({
      pairingPartners: [
        { code: 'cmk1.aaa', name: 'Alice' },
        { code: 'cmk1.aaa', name: 'Alice (dup code)' },
        { code: '', name: '' },
        { code: 'cmk1.bbb', name: 'Bob' },
      ],
    });
    expect(s.get('pairingPartners').map((p) => p.code)).toEqual(['cmk1.aaa', 'cmk1.bbb']);
  });

  it('groups require a label and drop members that are not known recipients', () => {
    const s = new SettingsStore();
    s.replaceAll({
      pairingPartners: [{ code: 'cmk1.aaa', name: 'Alice' }],
      pairingGroups: [
        { id: 'grp-1', label: 'Squad', memberCodes: ['cmk1.aaa', 'cmk1.ghost'] },
        { id: 'grp-2', label: '', memberCodes: ['cmk1.aaa'] },
      ],
    });
    const groups = s.get('pairingGroups');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe('Squad');
    expect(groups[0]?.memberCodes).toEqual(['cmk1.aaa']); // ghost member pruned
  });

  it('keeps a starred recipient/group that exists', () => {
    const s = new SettingsStore();
    s.replaceAll({
      pairingPartners: [{ code: 'cmk1.aaa', name: 'Alice' }],
      pairingGroups: [{ id: 'grp-1', label: 'Squad', memberCodes: ['cmk1.aaa'] }],
      pairingStarred: { kind: 'partner', ref: 'cmk1.aaa' },
    });
    expect(s.get('pairingStarred')).toEqual({ kind: 'partner', ref: 'cmk1.aaa' });

    s.replaceAll({
      pairingPartners: [{ code: 'cmk1.aaa', name: 'Alice' }],
      pairingGroups: [{ id: 'grp-1', label: 'Squad', memberCodes: ['cmk1.aaa'] }],
      pairingStarred: { kind: 'group', ref: 'grp-1' },
    });
    expect(s.get('pairingStarred')).toEqual({ kind: 'group', ref: 'grp-1' });
  });

  it('clears a starred ref whose recipient/group no longer exists', () => {
    const s = new SettingsStore();
    s.replaceAll({
      pairingPartners: [{ code: 'cmk1.aaa', name: 'Alice' }],
      pairingStarred: { kind: 'partner', ref: 'cmk1.gone' },
    });
    expect(s.get('pairingStarred')).toBeNull();

    const s2 = new SettingsStore();
    s2.replaceAll({ pairingStarred: { kind: 'group', ref: 'grp-gone' } });
    expect(s2.get('pairingStarred')).toBeNull();
  });

  it('rejects a malformed starred value', () => {
    const s = new SettingsStore();
    s.replaceAll({ pairingStarred: 'nonsense' });
    expect(s.get('pairingStarred')).toBeNull();
  });
});

describe('blocked-senders sanitize', () => {
  it('trims, strips internal whitespace, dedupes, and drops empties', () => {
    const s = new SettingsStore();
    s.replaceAll({
      pairingBlockedCodes: ['  cmk1.aaa  ', 'cmk1.a aa', 'cmk1.bbb', '', '   ', 'cmk1.bbb'],
    });
    // 'cmk1.aaa' (trimmed) and 'cmk1.a aa' (space stripped) collapse to one;
    // 'cmk1.bbb' dedupes; blank/whitespace-only entries drop.
    expect(s.get('pairingBlockedCodes')).toEqual(['cmk1.aaa', 'cmk1.bbb']);
  });

  it('defaults to an empty list and rejects non-arrays', () => {
    const s = new SettingsStore();
    expect(s.get('pairingBlockedCodes')).toEqual([]);
    s.replaceAll({ pairingBlockedCodes: 'nope' as unknown as string[] });
    expect(s.get('pairingBlockedCodes')).toEqual([]);
  });
});

describe('filterBlockedItems', () => {
  const item = (id: string, senderCode: string, type = 'card'): InboxItem => ({
    id,
    label: id,
    type,
    sliceJson: {},
    senderName: '',
    senderCode,
    receivedAt: Number(id),
    read: false,
  });

  it('drops cards and room invites from blocked senders', () => {
    const items = [
      item('1', 'cmk1.aaa'),
      item('2', 'cmk1.bbb'),
      item('3', 'cmk1.bbb', 'room-invite'),
      item('4', 'cmk1.ccc'),
    ];
    const out = filterBlockedItems(items, ['cmk1.bbb']);
    expect(out.map((i) => i.id)).toEqual(['1', '4']); // both bbb items (card + invite) gone
  });

  it('matches regardless of stray whitespace on either side', () => {
    const items = [item('1', '  cmk1.aaa '), item('2', 'cmk1.bbb')];
    expect(filterBlockedItems(items, ['cmk1.a aa']).map((i) => i.id)).toEqual(['2']);
  });

  it('returns the same array reference when nothing is blocked', () => {
    const items = [item('1', 'cmk1.aaa')];
    expect(filterBlockedItems(items, [])).toBe(items);
  });

  it('never blocks empty sender codes just because a blank slipped through', () => {
    const items = [item('1', ''), item('2', 'cmk1.aaa')];
    // A stray '' in the block list must not vacuum up unsigned items.
    expect(filterBlockedItems(items, ['', 'cmk1.aaa']).map((i) => i.id)).toEqual(['1']);
  });
});

describe('mergeRecentSenders (block-a-recent-sender ledger)', () => {
  const item = (
    senderCode: string,
    receivedAt: number,
    senderName = '',
    type = 'card',
  ): InboxItem => ({
    id: `id-${receivedAt}`,
    label: 'x',
    type,
    sliceJson: {},
    senderName,
    senderCode,
    receivedAt,
    read: false,
  });

  it('records card AND collaboration-invite senders alike', () => {
    const out = mergeRecentSenders(
      [],
      [item('cmk1.aaa', 1, 'Alice'), item('cmk1.bbb', 2, 'Bob', 'room-invite')],
    );
    // Both surface as blockable recent senders; invite is not special-cased.
    expect(out.map((r) => r.code).sort()).toEqual(['cmk1.aaa', 'cmk1.bbb']);
    expect(out.find((r) => r.code === 'cmk1.bbb')?.name).toBe('Bob');
  });

  it('dedupes by code, newest-first, keeping the newest name', () => {
    const out = mergeRecentSenders(
      [],
      [item('cmk1.aaa', 1, 'Old'), item('cmk1.aaa', 5, 'New'), item('cmk1.ccc', 3)],
    );
    expect(out.map((r) => r.code)).toEqual(['cmk1.aaa', 'cmk1.ccc']); // 5 > 3
    expect(out[0]!.name).toBe('New');
  });

  it('persists a prior sender even when this batch no longer has them', () => {
    // The invite arrived earlier (in `existing`); a later batch that doesn't
    // include it (it was consumed on Join) must NOT drop the sender.
    const existing: RecentSender[] = [{ code: 'cmk1.invite', name: 'Carol', at: 10 }];
    const out = mergeRecentSenders(existing, [item('cmk1.aaa', 20)]);
    expect(out.map((r) => r.code)).toContain('cmk1.invite');
  });

  it('ignores empty sender codes and caps the list', () => {
    expect(mergeRecentSenders([], [item('', 1), item('   ', 2)])).toEqual([]);
    const many = Array.from({ length: 50 }, (_, i) => item(`cmk1.c${i}`, i));
    expect(mergeRecentSenders([], many)).toHaveLength(10); // default cap
    // Keeps the 10 newest (highest receivedAt).
    expect(mergeRecentSenders([], many)[0]!.code).toBe('cmk1.c49');
  });
});

describe('resolveStarredTarget', () => {
  const partners = [
    { code: 'cmk1.aaa', name: 'Alice' },
    { code: 'cmk1.bbb', name: 'Bob' },
  ];
  const groups = [{ id: 'grp-1', label: 'Squad', memberCodes: ['cmk1.aaa', 'cmk1.bbb'] }];

  it('returns null when nothing is starred', () => {
    expect(resolveStarredTarget(null, partners, groups)).toBeNull();
  });

  it('resolves a starred recipient to its code + name label', () => {
    expect(resolveStarredTarget({ kind: 'partner', ref: 'cmk1.aaa' }, partners, groups)).toEqual({
      codes: ['cmk1.aaa'],
      label: 'Alice',
    });
  });

  it('falls back to the code as the label when the recipient has no name', () => {
    expect(resolveStarredTarget({ kind: 'partner', ref: 'cmk1.aaa' }, [{ code: 'cmk1.aaa', name: '' }], [])).toEqual({
      codes: ['cmk1.aaa'],
      label: 'cmk1.aaa',
    });
  });

  it('returns null for a starred recipient that is gone', () => {
    expect(resolveStarredTarget({ kind: 'partner', ref: 'cmk1.gone' }, partners, groups)).toBeNull();
  });

  it('resolves a starred group to its member codes + a via label', () => {
    expect(resolveStarredTarget({ kind: 'group', ref: 'grp-1' }, partners, groups)).toEqual({
      codes: ['cmk1.aaa', 'cmk1.bbb'],
      label: 'Squad',
      via: 'Squad',
    });
  });

  it('drops group members that are not current recipients', () => {
    const r = resolveStarredTarget(
      { kind: 'group', ref: 'grp-1' },
      partners,
      [{ id: 'grp-1', label: 'Squad', memberCodes: ['cmk1.aaa', 'cmk1.ghost'] }],
    );
    expect(r?.codes).toEqual(['cmk1.aaa']);
  });

  it('returns null for a starred group that is gone', () => {
    expect(resolveStarredTarget({ kind: 'group', ref: 'grp-gone' }, partners, groups)).toBeNull();
  });
});

describe('room-invite items', async () => {
  const { buildRoomInviteItem, parseRoomInvite, ROOM_INVITE_ITEM_TYPE, ROOM_INVITE_MIN_VERSION } =
    await import('../../src/editor/pairing/room-invite.js');

  it('round-trips through the inbox item shape', () => {
    const item = buildRoomInviteItem({
      shareCode: 'cmshare1.abc123.key456',
      title: 'Aff Updates',
    });
    expect(item.type).toBe(ROOM_INVITE_ITEM_TYPE);
    expect(item.label).toBe('Aff Updates');
    // exactly what the main process copies into the inbox verbatim
    const parsed = parseRoomInvite({ type: item.type, sliceJson: item.sliceJson });
    expect(parsed).toEqual({ shareCode: 'cmshare1.abc123.key456', title: 'Aff Updates' });
  });

  it('untitled docs get a generic label and empty title', () => {
    const item = buildRoomInviteItem({ shareCode: 'cmshare1.a.b', title: '' });
    expect(item.label).toBe('Collaboration session');
    expect(parseRoomInvite({ type: item.type, sliceJson: item.sliceJson })?.title).toBe('');
  });

  it('classifies v2 (versioned-room) codes as invites too', () => {
    // A v1-only check here demoted every movable-room invite to a
    // generic "Item" row with no Join button (live find, 2026-08-14).
    const item = buildRoomInviteItem({
      shareCode: `cmshare2.${'a'.repeat(32)}.key456.1.0.0`,
      title: 'Aff Updates',
    });
    const parsed = parseRoomInvite({ type: item.type, sliceJson: item.sliceJson });
    expect(parsed?.shareCode).toBe(`cmshare2.${'a'.repeat(32)}.key456.1.0.0`);
  });

  it('rejects non-invite and malformed items', () => {
    expect(parseRoomInvite({ type: 'card', sliceJson: { shareCode: 'cmshare1.a.b' } })).toBeNull();
    expect(parseRoomInvite({ type: ROOM_INVITE_ITEM_TYPE, sliceJson: null })).toBeNull();
    expect(parseRoomInvite({ type: ROOM_INVITE_ITEM_TYPE, sliceJson: {} })).toBeNull();
    // share codes from a different scheme are not joinable — reject early
    expect(
      parseRoomInvite({ type: ROOM_INVITE_ITEM_TYPE, sliceJson: { shareCode: 'cmk1.pubkey' } }),
    ).toBeNull();
  });

  it('declares a real version floor (old clients must drop invites)', () => {
    expect(ROOM_INVITE_MIN_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('listRecipientChoices (Send to Recipient picker rows)', () => {
  it('visible contacts first, then groups, then hidden contacts; code-less contacts skipped', () => {
    const partners = [
      { code: 'cmk1.aaa', name: 'Alice' },
      { code: 'cmk1.bbb', name: 'Bob', hidden: true },
      { code: '', name: 'Nobody' },
      { code: 'cmk1.ccc', name: '' },
    ];
    const groups = [{ id: 'grp-1', label: 'Squad', memberCodes: ['cmk1.aaa', 'cmk1.bbb', 'cmk1.gone'] }];
    const rows = listRecipientChoices(partners, groups);
    expect(rows.map((r) => `${r.kind}:${r.label}`)).toEqual([
      'partner:Alice',
      'partner:cmk1.ccc',
      'group:Squad',
      'partner:Bob',
    ]);
    expect(rows.find((r) => r.label === 'Bob')?.hidden).toBe(true);
    expect(rows.find((r) => r.label === 'Squad')?.sub).toBe('Group · 2 recipients');
  });

  it('a picked row resolves through the same target resolver as Send to Starred', () => {
    const partners = [{ code: 'cmk1.aaa', name: 'Alice', hidden: true }];
    const row = listRecipientChoices(partners, [])[0]!;
    expect(resolveStarredTarget({ kind: row.kind, ref: row.ref }, partners, [])).toEqual({
      codes: ['cmk1.aaa'],
      label: 'Alice',
    });
  });
});
