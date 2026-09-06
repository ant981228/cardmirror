/**
 * Learn — the local annotation store (per-user; the layer that never enters
 * the document, SPEC-learn-system §3.3). Holds flashcard content + schedule,
 * AI threads, anchors, custom decks, and the doc registry.
 *
 * Identity is split so file-copies share one logical card + one schedule
 * while each file keeps its own grounding:
 *   - per `cardId`:            CardDef (content) + ScheduleEntry (schedule)
 *   - per (`cardId`,`docId`):  CardAnchor (how a card is grounded in a file)
 *   - per (`threadId`,`docId`): AiThread
 *
 * Persistence is injected (`persist`) so the model is host-agnostic and
 * unit-testable; the renderer wires it to a host KV. Review reads entirely
 * from here — no file I/O.
 */

import type { ScheduleEntry, Grade } from './learn-scheduler.js';
import { newSchedule, gradeCard, buildQueue, dueCount } from './learn-scheduler.js';
import type { AnchorDescriptor } from './learn-anchor.js';

export interface CardDef {
  id: string; // cardId — stable, local
  type: 'qa' | 'cloze';
  front: string;
  back: string;
}

export interface CardAnchor {
  cardId: string;
  docId: string;
  anchor: AnchorDescriptor | null; // null ⇒ currently unanchored
}

/** A flashcard in a portable export: content + its review schedule + its
 *  doc groundings. No `cardId` — import always mints a fresh one so it
 *  ADDs (never overwrites). */
export interface ExportedCard {
  type: 'qa' | 'cloze';
  front: string;
  back: string;
  /** Review progress, or null to start fresh on import. */
  schedule: Omit<ScheduleEntry, 'cardId'> | null;
  anchors: { docId: string; anchor: AnchorDescriptor | null }[];
}

export interface LocalComment {
  author: string;
  text: string;
  at: string; // ISO
  /** Distinguishes AI turns from the user's in an AI thread. */
  ai?: boolean;
}

export interface AiThread {
  threadId: string;
  docId: string;
  comments: LocalComment[];
  anchor: AnchorDescriptor | null;
  createdAt: string;
}

/** A private note — a comment thread that lives in the local annotation
 *  layer (never serialized into the doc, hence private), anchored by
 *  descriptor + a green highlight decoration like flashcards / AI
 *  threads. Same shape as an AiThread minus the AI semantics; all turns
 *  are the user's. */
export interface Note {
  noteId: string;
  docId: string;
  comments: LocalComment[];
  anchor: AnchorDescriptor | null;
  createdAt: string;
  /** Cutter-context role, when this note feeds the card cutter:
   *  'cutter-section' = an anchored note designating a stretch of the
   *  file whose text ships as context with every cut in this doc;
   *  'cutter-guidance' = THE one anchorless per-doc note holding
   *  file-wide guidance (root = the user's "how this file works",
   *  replies = the cutter's accumulated card-neutral refinements,
   *  `ai: true` turns). Absent = a plain private note. */
  kind?: 'cutter-section' | 'cutter-guidance';
}

export interface ReviewLogEntry {
  cardId: string;
  at: string; // ISO
  grade: Grade;
  intervalBefore: number;
  intervalAfter: number;
}

export interface CustomDeck {
  deckId: string;
  name: string;
  cardIds: string[];
  createdAt: string;
}

export interface DocRegistryEntry {
  docId: string;
  knownPaths: string[]; // newest first
  lastName: string;
  format: 'cmir' | 'docx' | null;
}

/** Review scope. */
export type Scope = { kind: 'all' } | { kind: 'file'; docId: string } | { kind: 'deck'; deckId: string };

interface Blob {
  version: number;
  cards: CardDef[];
  schedules: ScheduleEntry[];
  anchors: CardAnchor[];
  aiThreads: AiThread[];
  notes: Note[];
  log: ReviewLogEntry[];
  decks: CustomDeck[];
  docs: DocRegistryEntry[];
}

const VERSION = 1;
const EMPTY: Blob = { version: VERSION, cards: [], schedules: [], anchors: [], aiThreads: [], notes: [], log: [], decks: [], docs: [] };

export class LearnStore {
  private cards = new Map<string, CardDef>();
  private schedules = new Map<string, ScheduleEntry>();
  private anchors: CardAnchor[] = [];
  private aiThreads: AiThread[] = [];
  private notes: Note[] = [];
  private log: ReviewLogEntry[] = [];
  private decks: CustomDeck[] = [];
  private docs = new Map<string, DocRegistryEntry>();
  private listeners = new Set<() => void>();

  /** `persist` is called (debounced by the caller) with the serialized blob. */
  constructor(private persist: (json: string) => void = () => {}) {}

  // ── (de)serialization ─────────────────────────────────────────────
  loadJson(json: string | null): void {
    let b: Partial<Blob> = {};
    if (json) {
      try {
        b = JSON.parse(json);
      } catch {
        b = {};
      }
    }
    this.cards = new Map((b.cards ?? []).map((c) => [c.id, c]));
    this.schedules = new Map((b.schedules ?? []).map((s) => [s.cardId, s]));
    this.anchors = b.anchors ?? [];
    this.aiThreads = b.aiThreads ?? [];
    this.notes = b.notes ?? [];
    this.log = b.log ?? [];
    this.decks = b.decks ?? [];
    this.docs = new Map((b.docs ?? []).map((d) => [d.docId, d]));
    // Notify (but don't persist) so subscribers mounted before the
    // async boot load — e.g. the Home screen's Learn section — refresh.
    this.notify();
  }

  toJson(): string {
    const b: Blob = {
      version: VERSION,
      cards: [...this.cards.values()],
      schedules: [...this.schedules.values()],
      anchors: this.anchors,
      aiThreads: this.aiThreads,
      notes: this.notes,
      log: this.log,
      decks: this.decks,
      docs: [...this.docs.values()],
    };
    return JSON.stringify(b);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private changed(): void {
    this.persist(this.toJson());
    this.notify();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── reads ─────────────────────────────────────────────────────────
  getCard(cardId: string): CardDef | undefined {
    return this.cards.get(cardId);
  }
  getSchedule(cardId: string): ScheduleEntry | undefined {
    return this.schedules.get(cardId);
  }
  listDecks(): CustomDeck[] {
    return [...this.decks];
  }
  listDocs(): DocRegistryEntry[] {
    return [...this.docs.values()];
  }
  /** Every card (content only) — for the manage GUI. */
  listCards(): CardDef[] {
    return [...this.cards.values()];
  }
  /** Every card↔file grounding — for the manage GUI's by-file grouping. */
  listAnchors(): CardAnchor[] {
    return [...this.anchors];
  }

  /** Portable snapshot of every card: content + schedule + anchors. */
  exportCards(): ExportedCard[] {
    const byCard = new Map<string, { docId: string; anchor: AnchorDescriptor | null }[]>();
    for (const a of this.anchors) {
      const list = byCard.get(a.cardId) ?? [];
      list.push({ docId: a.docId, anchor: a.anchor });
      byCard.set(a.cardId, list);
    }
    return [...this.cards.values()].map((c) => {
      const s = this.schedules.get(c.id);
      return {
        type: c.type,
        front: c.front,
        back: c.back,
        schedule: s
          ? {
              state: s.state,
              dueOn: s.dueOn,
              intervalDays: s.intervalDays,
              reps: s.reps,
              lapses: s.lapses,
              lastReviewed: s.lastReviewed,
            }
          : null,
        anchors: byCard.get(c.id) ?? [],
      };
    });
  }
  /** Anchors (card↔file grounding) for a doc. */
  anchorsForDoc(docId: string): CardAnchor[] {
    return this.anchors.filter((a) => a.docId === docId);
  }
  aiThreadsForDoc(docId: string): AiThread[] {
    return this.aiThreads.filter((t) => t.docId === docId);
  }
  notesForDoc(docId: string): Note[] {
    return this.notes.filter((n) => n.docId === docId);
  }
  /** Anchored cutter-context notes for a doc (designated sections). */
  cutterSectionNotes(docId: string): Note[] {
    return this.notes.filter((n) => n.docId === docId && n.kind === 'cutter-section');
  }
  /** The doc's single anchorless file-guidance note, if created. */
  cutterGuidanceNote(docId: string): Note | undefined {
    return this.notes.find((n) => n.docId === docId && n.kind === 'cutter-guidance');
  }

  /** The cardIds belonging to a scope. */
  private cardIdsForScope(scope: Scope): Set<string> {
    if (scope.kind === 'all') return new Set(this.cards.keys());
    if (scope.kind === 'file') return new Set(this.anchorsForDoc(scope.docId).map((a) => a.cardId));
    const deck = this.decks.find((d) => d.deckId === scope.deckId);
    return new Set(deck?.cardIds ?? []);
  }

  private schedulesForScope(scope: Scope): ScheduleEntry[] {
    const ids = this.cardIdsForScope(scope);
    return [...this.schedules.values()].filter((s) => ids.has(s.cardId));
  }

  /** Distinct cards due in a scope (home-screen badges). */
  dueCount(scope: Scope, today: string): number {
    return dueCount(this.schedulesForScope(scope), today);
  }

  totalCount(scope: Scope): number {
    return this.cardIdsForScope(scope).size;
  }

  /** Ordered review queue of cardIds for a scope (deduped by card). */
  queue(scope: Scope, today: string): string[] {
    return buildQueue(this.schedulesForScope(scope), today).map((s) => s.cardId);
  }

  // ── mutations ─────────────────────────────────────────────────────
  /** Create or replace a card's content; ensure a schedule exists. */
  upsertCard(card: CardDef, today: string): void {
    this.cards.set(card.id, card);
    if (!this.schedules.has(card.id)) this.schedules.set(card.id, newSchedule(card.id, today));
    this.changed();
  }

  /** ADD imported cards — each gets a FRESH cardId so importing never
   *  overwrites an existing card (re-importing the same file duplicates,
   *  by design). Carries each card's schedule (or a fresh one) + anchors.
   *  Returns how many were added. */
  importCards(entries: ExportedCard[], today: string): number {
    let added = 0;
    for (const e of entries) {
      const id = crypto.randomUUID();
      this.cards.set(id, { id, type: e.type, front: e.front, back: e.back });
      this.schedules.set(id, e.schedule ? { ...e.schedule, cardId: id } : newSchedule(id, today));
      for (const a of e.anchors) this.anchors.push({ cardId: id, docId: a.docId, anchor: a.anchor });
      added += 1;
    }
    if (added > 0) this.changed();
    return added;
  }

  /** Set/replace a card's grounding in a file (one per cardId × docId). */
  setAnchor(cardId: string, docId: string, anchor: AnchorDescriptor | null): void {
    const existing = this.anchors.find((a) => a.cardId === cardId && a.docId === docId);
    if (existing) existing.anchor = anchor;
    else this.anchors.push({ cardId, docId, anchor });
    this.changed();
  }

  getAiThread(threadId: string): AiThread | undefined {
    return this.aiThreads.find((t) => t.threadId === threadId);
  }

  addAiThread(thread: AiThread): void {
    this.aiThreads.push(thread);
    this.changed();
  }

  /** Append a turn (user question or AI reply) to an AI thread. */
  appendAiComment(threadId: string, comment: LocalComment): void {
    const t = this.aiThreads.find((x) => x.threadId === threadId);
    if (t) {
      t.comments.push(comment);
      this.changed();
    }
  }

  /** AI thread anchor update (or null to unanchor). */
  setAiThreadAnchor(threadId: string, anchor: AnchorDescriptor | null): void {
    const t = this.aiThreads.find((x) => x.threadId === threadId);
    if (t) {
      t.anchor = anchor;
      this.changed();
    }
  }

  removeAiThread(threadId: string): void {
    this.aiThreads = this.aiThreads.filter((t) => t.threadId !== threadId);
    this.changed();
  }

  // ── notes (private comment threads in the annotation layer) ────────
  getNote(noteId: string): Note | undefined {
    return this.notes.find((n) => n.noteId === noteId);
  }

  addNote(note: Note): void {
    this.notes.push(note);
    this.changed();
  }

  /** Append a turn (root message or reply) to a note. */
  appendNoteComment(noteId: string, comment: LocalComment): void {
    const n = this.notes.find((x) => x.noteId === noteId);
    if (n) {
      n.comments.push(comment);
      this.changed();
    }
  }

  /** Edit the text of a note's turn by index. No-op on a bad index. */
  editNoteComment(noteId: string, index: number, text: string): void {
    const n = this.notes.find((x) => x.noteId === noteId);
    const c = n?.comments[index];
    if (c) {
      c.text = text;
      this.changed();
    }
  }

  /** Delete a single turn of a note by index (the guidance note's
   *  cutter refinements are individually deletable). No-op on a bad
   *  index. */
  removeNoteComment(noteId: string, index: number): void {
    const n = this.notes.find((x) => x.noteId === noteId);
    if (n && index >= 0 && index < n.comments.length) {
      n.comments.splice(index, 1);
      this.changed();
    }
  }

  /** Note anchor update (or null to unanchor). */
  setNoteAnchor(noteId: string, anchor: AnchorDescriptor | null): void {
    const n = this.notes.find((x) => x.noteId === noteId);
    if (n) {
      n.anchor = anchor;
      this.changed();
    }
  }

  removeNote(noteId: string): void {
    this.notes = this.notes.filter((n) => n.noteId !== noteId);
    this.changed();
  }

  /** Apply a grade to a card: update schedule + append to the log. Returns
   *  whether to retry the card within the session. */
  grade(cardId: string, g: Grade, today: string, now: string): boolean {
    const cur = this.schedules.get(cardId);
    if (!cur) return false;
    const { entry, retryInSession } = gradeCard(cur, g, today, now);
    this.schedules.set(cardId, entry);
    this.log.push({ cardId, at: now, grade: g, intervalBefore: cur.intervalDays, intervalAfter: entry.intervalDays });
    this.changed();
    return retryInSession;
  }

  suspend(cardId: string): void {
    const s = this.schedules.get(cardId);
    if (s) {
      this.schedules.set(cardId, { ...s, state: 'suspended' });
      this.changed();
    }
  }

  /** Suspend or resume a single card (manage GUI). Resume restores it to
   *  'review' if it has reps, else 'new' — keeping its due date so a
   *  previously-due card stays due. */
  setSuspended(cardId: string, suspended: boolean): void {
    const s = this.schedules.get(cardId);
    if (!s) return;
    if (suspended) {
      if (s.state === 'suspended') return;
      this.schedules.set(cardId, { ...s, state: 'suspended' });
    } else {
      if (s.state !== 'suspended') return;
      this.schedules.set(cardId, { ...s, state: s.reps > 0 ? 'review' : 'new' });
    }
    this.changed();
  }

  /** Permanently delete a card: content, schedule, every file anchor,
   *  deck membership, and review log (manage GUI). */
  deleteCard(cardId: string): void {
    this.cards.delete(cardId);
    this.schedules.delete(cardId);
    this.anchors = this.anchors.filter((a) => a.cardId !== cardId);
    for (const d of this.decks) d.cardIds = d.cardIds.filter((c) => c !== cardId);
    this.log = this.log.filter((l) => l.cardId !== cardId);
    this.changed();
  }

  /** Archive (suspend) or delete all of a file's cards/threads — culls stale
   *  copies (§3.3, §10). Delete drops the file's anchors + AI threads and
   *  prunes any card with no anchor left in any file. */
  forgetDoc(docId: string, mode: 'archive' | 'delete'): void {
    const docCardIds = new Set(this.anchorsForDoc(docId).map((a) => a.cardId));
    if (mode === 'archive') {
      for (const id of docCardIds) {
        const s = this.schedules.get(id);
        if (s) this.schedules.set(id, { ...s, state: 'suspended' });
      }
      this.changed();
      return;
    }
    // delete
    this.anchors = this.anchors.filter((a) => a.docId !== docId);
    this.aiThreads = this.aiThreads.filter((t) => t.docId !== docId);
    this.notes = this.notes.filter((n) => n.docId !== docId);
    const stillAnchored = new Set(this.anchors.map((a) => a.cardId));
    for (const id of docCardIds) {
      if (!stillAnchored.has(id)) {
        this.cards.delete(id);
        this.schedules.delete(id);
        for (const d of this.decks) d.cardIds = d.cardIds.filter((c) => c !== id);
      }
    }
    this.changed();
  }

  // decks
  createDeck(name: string, deckId: string, now: string): void {
    this.decks.push({ deckId, name, cardIds: [], createdAt: now });
    this.changed();
  }
  renameDeck(deckId: string, name: string): void {
    const d = this.decks.find((x) => x.deckId === deckId);
    if (d) {
      d.name = name;
      this.changed();
    }
  }
  deleteDeck(deckId: string): void {
    this.decks = this.decks.filter((d) => d.deckId !== deckId);
    this.changed();
  }
  setDeckMembership(deckId: string, cardId: string, member: boolean): void {
    const d = this.decks.find((x) => x.deckId === deckId);
    if (!d) return;
    const has = d.cardIds.includes(cardId);
    if (member && !has) d.cardIds.push(cardId);
    else if (!member && has) d.cardIds = d.cardIds.filter((c) => c !== cardId);
    this.changed();
  }

  // doc registry
  registerDoc(entry: { docId: string; path?: string | null; name: string; format: 'cmir' | 'docx' | null }): void {
    const cur = this.docs.get(entry.docId) ?? { docId: entry.docId, knownPaths: [], lastName: entry.name, format: entry.format };
    cur.lastName = entry.name;
    cur.format = entry.format;
    if (entry.path) cur.knownPaths = [entry.path, ...cur.knownPaths.filter((p) => p !== entry.path)].slice(0, 8);
    this.docs.set(entry.docId, cur);
    this.changed();
  }

  /** Copy a doc's grounding to another docId (Save As fork): the new file
   *  gets its own CardAnchors (same cardId — content + schedule stay
   *  shared) and AiThreads (fresh threadIds). The source is untouched. */
  copyDocAnnotations(fromId: string, toId: string): void {
    if (fromId === toId) return;
    let changed = false;
    for (const a of this.anchorsForDoc(fromId)) {
      this.anchors.push({ cardId: a.cardId, docId: toId, anchor: a.anchor });
      changed = true;
    }
    for (const t of this.aiThreadsForDoc(fromId)) {
      this.aiThreads.push({
        ...t,
        threadId: crypto.randomUUID(),
        docId: toId,
        comments: t.comments.map((c) => ({ ...c })),
      });
      changed = true;
    }
    for (const n of this.notesForDoc(fromId)) {
      this.notes.push({
        ...n,
        noteId: crypto.randomUUID(),
        docId: toId,
        comments: n.comments.map((c) => ({ ...c })),
      });
      changed = true;
    }
    if (changed) this.changed();
  }

  /** Reassign annotations from a temporary session id to the real docId
   *  (first save of a previously-unsaved doc). */
  rekeyDoc(fromId: string, toId: string): void {
    for (const a of this.anchors) if (a.docId === fromId) a.docId = toId;
    for (const t of this.aiThreads) if (t.docId === fromId) t.docId = toId;
    for (const n of this.notes) if (n.docId === fromId) n.docId = toId;
    const reg = this.docs.get(fromId);
    if (reg) {
      this.docs.delete(fromId);
      this.docs.set(toId, { ...reg, docId: toId });
    }
    this.changed();
  }
}

// ── Operations ─────────────────────────────────────────────────────
/** The store's mutating methods, by name. A window never persists the
 *  store itself: it applies a mutation to its own copy (so reads stay
 *  synchronous) and sends the same call, as a `LearnOp`, to the single
 *  OWNER of the canonical copy — the desktop main process, or the
 *  browser tab holding the Web Lock — which applies it there, writes
 *  the file, and hands every window the result. Whole-blob writes from
 *  each window were last-writer-wins: a window that had loaded before
 *  another created cards overwrote them the next time it so much as
 *  registered an opened file (field report 2026-09-05). Guarded by a
 *  test that every method calling `changed()` is listed here. */
export const LEARN_MUTATIONS = [
  'upsertCard',
  'importCards',
  'setAnchor',
  'addAiThread',
  'appendAiComment',
  'setAiThreadAnchor',
  'removeAiThread',
  'addNote',
  'appendNoteComment',
  'editNoteComment',
  'removeNoteComment',
  'setNoteAnchor',
  'removeNote',
  'grade',
  'suspend',
  'setSuspended',
  'deleteCard',
  'forgetDoc',
  'createDeck',
  'renameDeck',
  'deleteDeck',
  'setDeckMembership',
  'registerDoc',
  'copyDocAnnotations',
  'rekeyDoc',
] as const;
export type LearnMutation = (typeof LEARN_MUTATIONS)[number];

/** One mutation call, serialized: method name + its arguments (all plain
 *  data — ids, ISO strings, anchor descriptors, card/note records). */
export type LearnOp = { [M in LearnMutation]: { m: M; a: Parameters<LearnStore[M]> } }[LearnMutation];

const LEARN_MUTATION_SET: ReadonlySet<string> = new Set(LEARN_MUTATIONS);

/** Shape check for an operation that crossed a process boundary. */
export function isLearnOp(x: unknown): x is LearnOp {
  if (!x || typeof x !== 'object') return false;
  const o = x as { m?: unknown; a?: unknown };
  return typeof o.m === 'string' && LEARN_MUTATION_SET.has(o.m) && Array.isArray(o.a);
}

/** Apply `op` to `store` — the same call a window made on its own copy. */
export function applyLearnOp(store: LearnStore, op: LearnOp): unknown {
  return (store[op.m] as (...args: unknown[]) => unknown).apply(store, op.a);
}
