/**
 * Tag boundary editing commands (ARCHITECTURE.md §12,
 * "Tag / analytic boundary rules").
 *
 * Five keymap commands that override Backspace, Delete, and Enter
 * inside a `tag` or `analytic`:
 *
 *  1. Backspace at start of tag → permit only if previous paragraph
 *     is blank (whitespace-only); delete the blank. Otherwise prohibit.
 *  2. Delete at end of tag → permit only if next paragraph is also a
 *     tag; merge them. Otherwise prohibit.
 *  3. Enter in middle of tag → split: a new card with the pre-cursor
 *     tag is inserted before; the original card retains the post-
 *     cursor text plus its existing cite/body/undertags.
 *  4. Enter at end of tag → create a new card_body in the current
 *     card and move the cursor into it. (Overrides Word's default
 *     "next paragraph is a Cite.")
 *  5. Enter at start of tag → handled by the same mid-split path; the
 *     pre-cursor content is empty, so the new card has an empty tag
 *     and the cursor stays at the original tag's start.
 *
 * Same rules apply to `analytic` (in `analytic_unit`, or in a card's
 * cite slot — though we only override when the analytic is the root
 * of an analytic_unit).
 *
 * Pocket / Hat / Block use ProseMirror's default behavior — no
 * overrides needed.
 */

import { Selection, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import { newHeadingId } from '../schema/ids.js';
import { enclosingZoneDepth } from './transclusion.js';

const HEAD_NODE_TYPES = new Set(['tag', 'analytic']);
const CARD_NODE_TYPES = new Set(['card', 'analytic_unit']);

/**
 * Resolved-position context for a cursor inside a tag/analytic that
 * is the head of a card/analytic_unit.
 */
interface TagContext {
  /** The tag or analytic node. */
  head: PMNode;
  /** The card or analytic_unit node. */
  container: PMNode;
  /** Depth of the head node in the doc. */
  headDepth: number;
  /** Cursor offset inside the head. */
  cursorOffset: number;
  /** Document position right before the head. */
  headFrom: number;
  /** Document position right after the head. */
  headTo: number;
  /** Document position right before the container. */
  containerFrom: number;
  /** Document position right after the container. */
  containerTo: number;
}

function getTagContext(state: import('prosemirror-state').EditorState): TagContext | null {
  if (!state.selection.empty) return null;
  const $from = state.selection.$from;
  const head = $from.parent;
  if (!HEAD_NODE_TYPES.has(head.type.name)) return null;
  const headDepth = $from.depth;
  if (headDepth < 1) return null;
  const container = $from.node(headDepth - 1);
  if (!CARD_NODE_TYPES.has(container.type.name)) return null;
  // The head must be the FIRST child of the container (its required
  // anchor). An analytic in a card's cite slot doesn't qualify.
  if (container.firstChild !== head) return null;
  return {
    head,
    container,
    headDepth,
    cursorOffset: $from.parentOffset,
    headFrom: $from.before(headDepth),
    headTo: $from.after(headDepth),
    containerFrom: $from.before(headDepth - 1),
    containerTo: $from.after(headDepth - 1),
  };
}

function isBlank(node: PMNode): boolean {
  return node.textContent.replace(/\s+/g, '') === '';
}

/**
 * Identify the "previous paragraph in document order" relative to the
 * card/analytic_unit at containerFrom. Walks back across container
 * boundaries: if the previous doc-level sibling is itself a card or
 * analytic_unit, returns that container's last child.
 */
interface PrevParagraph {
  node: PMNode;
  from: number;
  to: number;
  /** True if removing this paragraph would orphan its container's
   *  required anchor (it's the only tag/analytic in a card-like
   *  parent). Caller may want to delete the parent instead. */
  isContainerHead: boolean;
}

function findPrevParagraph(
  doc: PMNode,
  containerFrom: number,
): PrevParagraph | null {
  if (containerFrom <= 0) return null;
  const $beforeContainer = doc.resolve(containerFrom);
  const prev = $beforeContainer.nodeBefore;
  if (!prev) return null;

  if (CARD_NODE_TYPES.has(prev.type.name)) {
    const lastChild = prev.lastChild;
    if (!lastChild) return null;
    const containerOfLastChildFrom = containerFrom - prev.nodeSize;
    let offset = 1; // skip the container's open token
    for (let i = 0; i < prev.childCount - 1; i++) {
      offset += prev.child(i).nodeSize;
    }
    const lastChildFrom = containerOfLastChildFrom + offset;
    return {
      node: lastChild,
      from: lastChildFrom,
      to: lastChildFrom + lastChild.nodeSize,
      isContainerHead: HEAD_NODE_TYPES.has(lastChild.type.name) && prev.childCount === 1,
    };
  }

  // Plain doc-level sibling (paragraph, heading, etc.).
  return {
    node: prev,
    from: containerFrom - prev.nodeSize,
    to: containerFrom,
    isContainerHead: false,
  };
}

/**
 * Identify the "next paragraph in document order" after the
 * container at containerTo. Same boundary-crossing logic as
 * findPrevParagraph but in the forward direction.
 */
interface NextParagraph {
  node: PMNode;
  from: number;
  to: number;
  /** True when the next paragraph is itself the head of the
   *  *following* container (i.e., a tag/analytic that anchors the
   *  next card-like structure). */
  isContainerHead: boolean;
}

function findNextParagraph(
  doc: PMNode,
  containerTo: number,
): NextParagraph | null {
  if (containerTo >= doc.content.size) return null;
  const $afterContainer = doc.resolve(containerTo);
  const next = $afterContainer.nodeAfter;
  if (!next) return null;

  if (CARD_NODE_TYPES.has(next.type.name)) {
    const firstChild = next.firstChild;
    if (!firstChild) return null;
    const firstChildFrom = containerTo + 1; // past the container's open token
    return {
      node: firstChild,
      from: firstChildFrom,
      to: firstChildFrom + firstChild.nodeSize,
      isContainerHead: HEAD_NODE_TYPES.has(firstChild.type.name),
    };
  }

  return {
    node: next,
    from: containerTo,
    to: containerTo + next.nodeSize,
    isContainerHead: false,
  };
}

/**
 * Merge two adjacent tag/analytic-headed containers. The first
 * (`prev`) survives; the second (`next`) dissolves. The merged head
 * receives the concatenated content of both heads; the prev container
 * also absorbs any non-head children of next (cite, body, undertags).
 * Cursor lands at the merge point — the boundary between the two
 * heads' content within the merged head.
 *
 * Caller responsibilities:
 *   - prev container's head is the only child (childCount === 1).
 *   - prev and next containers are the same type (both `card` or
 *     both `analytic_unit`); enforced via cheap type-name compare.
 *   - prev/next are immediately adjacent in the doc.
 */
function mergeAdjacentTagContainers(
  state: EditorState,
  prevContainerFrom: number,
  nextContainerFrom: number,
): Transaction | null {
  const $prev = state.doc.resolve(prevContainerFrom);
  const prevContainer = $prev.nodeAfter;
  const $next = state.doc.resolve(nextContainerFrom);
  const nextContainer = $next.nodeAfter;
  if (!prevContainer || !nextContainer) return null;
  if (prevContainer.type.name !== nextContainer.type.name) return null;
  if (!CARD_NODE_TYPES.has(prevContainer.type.name)) return null;

  const prevHead = prevContainer.firstChild;
  const nextHead = nextContainer.firstChild;
  if (!prevHead || !nextHead) return null;
  if (!HEAD_NODE_TYPES.has(prevHead.type.name)) return null;
  if (!HEAD_NODE_TYPES.has(nextHead.type.name)) return null;
  if (prevHead.type.name !== nextHead.type.name) return null;
  if (prevContainer.childCount !== 1) return null;

  // Children of `next` to migrate into `prev` (everything except next's head).
  const survivors: PMNode[] = [];
  for (let i = 1; i < nextContainer.childCount; i++) {
    survivors.push(nextContainer.child(i));
  }

  const prevHeadContentEnd = prevContainerFrom + 1 + 1 + prevHead.content.size; // inside head, end of content
  const nextContainerTo = nextContainerFrom + nextContainer.nodeSize;
  const prevContainerContentEnd = prevContainerFrom + prevContainer.nodeSize - 1; // inside prev, before close

  let tr = state.tr;
  // 1. Append next head's inline content to prev head's content.
  tr = tr.replaceWith(prevHeadContentEnd, prevHeadContentEnd, nextHead.content);
  // The merge point is here, before the mapping shifts.
  const mergePoint = prevHeadContentEnd;

  // 2. Append next's other children (body, cite, undertags) to prev container.
  if (survivors.length > 0) {
    const insertPos = tr.mapping.map(prevContainerContentEnd);
    tr = tr.replaceWith(insertPos, insertPos, Fragment.fromArray(survivors));
  }

  // 3. Delete the (now duplicated) next container.
  const mappedNextFrom = tr.mapping.map(nextContainerFrom);
  const mappedNextTo = tr.mapping.map(nextContainerTo);
  tr = tr.delete(mappedNextFrom, mappedNextTo);

  // 4. Cursor at merge point (mapped through all the changes). assoc=-1
  // pins the cursor to the BEFORE side of step 1's insertion — i.e.,
  // exactly between the prev head's original content and the appended
  // next head content. Default assoc=1 would land us at the end of
  // the merged text, which isn't where the user came from in either
  // direction.
  const mappedMergePoint = tr.mapping.map(mergePoint, -1);
  tr = tr.setSelection(TextSelection.create(tr.doc, mappedMergePoint));

  return tr;
}

/**
 * Shared shortcut for both Backspace and Delete: if the head is empty
 * AND it's the only child of its card/analytic_unit (no body, no cite,
 * no undertag — nothing else to preserve), delete the whole container.
 * Returns true if the command was handled (or would be, when dispatch
 * is null), false otherwise. Caller is expected to fall through to its
 * own logic when this returns false.
 *
 * If deleting would leave the doc with no children at all, replace the
 * container with an empty paragraph instead so the editor always has a
 * valid cursor target.
 */
function tryDeleteEmptyHeadContainer(
  state: EditorState,
  ctx: TagContext,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  // Treat whitespace-only heads the same as truly empty ones.
  if (!isBlank(ctx.head)) return false;
  if (ctx.container.childCount !== 1) return false;

  if (!dispatch) return true;

  const onlyChildOfDoc = state.doc.childCount === 1;
  let tr = state.tr;
  if (onlyChildOfDoc) {
    // Replace with an empty paragraph so we always have a textblock
    // for the cursor to land in.
    const para = schema.nodes['paragraph']!.createAndFill();
    if (!para) return false;
    tr = tr.replaceWith(ctx.containerFrom, ctx.containerTo, para);
    tr = tr.setSelection(TextSelection.create(tr.doc, ctx.containerFrom + 1));
  } else {
    tr = tr.delete(ctx.containerFrom, ctx.containerTo);
    // Land cursor at the position the container used to occupy; PM's
    // Selection.near picks the nearest valid text position (start of
    // next sibling, end of prev sibling, etc.).
    const pos = Math.min(ctx.containerFrom, tr.doc.content.size);
    tr = tr.setSelection(Selection.near(tr.doc.resolve(pos)));
  }
  dispatch(tr.scrollIntoView());
  return true;
}

/**
 * Empty head + surviving body content: delete the head and merge the
 * container's other children into whatever doc-level node sits before
 * it.
 *
 *   - Previous is a card / analytic_unit → append the survivors into
 *     it. analytic in a card's cite-slot folds to card_body when
 *     merging into an analytic_unit (cite-slot isn't a thing there).
 *   - Previous is anything else (paragraph, heading, …) or there is
 *     no previous node → lift the survivors to doc level. The empty-
 *     headed container is dropped.
 *
 * Cursor lands at the merge boundary:
 *   - Backspace: end of the preceding content (assoc -1).
 *   - Delete: start of the merged survivors (assoc +1).
 */
function tryMergeEmptyHeadIntoPrev(
  state: EditorState,
  ctx: TagContext,
  dispatch: ((tr: Transaction) => void) | undefined,
  bias: 1 | -1,
): boolean {
  return performEmptyHeadMerge(
    state, dispatch, ctx.container, ctx.containerFrom, ctx.containerTo, bias,
  );
}

/**
 * The actual merge: drop the (blank) head, migrate the container's
 * surviving children either into the previous doc-level card /
 * analytic_unit (appended) or to doc level (lifted). Returns true on
 * success / dry-run, false if there's nothing to merge.
 *
 * Callers ensure the head is blank and there's at least one
 * surviving child before invoking — those preconditions guard the
 * rule, not the mechanic.
 */
function performEmptyHeadMerge(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  container: PMNode,
  containerFrom: number,
  containerTo: number,
  bias: 1 | -1,
): boolean {
  const head = container.firstChild;
  if (!head || !isBlank(head)) return false;
  if (container.childCount <= 1) return false;

  if (!dispatch) return true;

  const survivors: PMNode[] = [];
  container.forEach((child, _o, idx) => {
    if (idx > 0) survivors.push(child);
  });

  const $beforeContainer = state.doc.resolve(containerFrom);
  const prev = $beforeContainer.nodeBefore;

  let tr = state.tr;
  let mergePoint: number;

  if (prev && CARD_NODE_TYPES.has(prev.type.name)) {
    const prevContainerFrom = containerFrom - prev.nodeSize;
    const adjusted = prev.type.name === 'analytic_unit'
      ? survivors.map(toAnalyticUnitChild)
      : survivors;
    const newPrev = prev.copy(prev.content.append(Fragment.fromArray(adjusted)));
    tr = tr.replaceWith(prevContainerFrom, containerTo, newPrev);
    mergePoint = prevContainerFrom + 1 + prev.content.size;
  } else {
    const lifted = survivors.map(liftSurvivorToDocLevel);
    tr = tr.replaceWith(containerFrom, containerTo, Fragment.fromArray(lifted));
    mergePoint = containerFrom;
  }

  tr = tr.setSelection(Selection.near(tr.doc.resolve(mergePoint), bias));
  dispatch(tr.scrollIntoView());
  return true;
}

/** Coerce a card child to a node valid as an analytic_unit child. */
function toAnalyticUnitChild(child: PMNode): PMNode {
  const t = child.type.name;
  if (t === 'card_body' || t === 'undertag' || t === 'cite_paragraph') return child;
  // analytic in a card's cite-slot → card_body (preserves text only).
  return schema.nodes['card_body']!.create(null, child.content);
}

/** Coerce a card child to a node valid at doc level. A `card_body` downcasts to
 *  a plain `paragraph` — left as-is it would render with card-body styling but
 *  belong to no card. `cite_paragraph` / `undertag` are meaningful, valid
 *  doc-level nodes and pass through unchanged; an `analytic` must be wrapped in
 *  an `analytic_unit`. */
function liftSurvivorToDocLevel(child: PMNode): PMNode {
  const t = child.type.name;
  if (t === 'card_body') {
    return schema.nodes['paragraph']!.create(null, child.content);
  }
  if (t === 'analytic') {
    return schema.nodes['analytic_unit']!.create(null, [child]);
  }
  return child;
}

/**
 * Backspace at the start of a tag/analytic. Cases:
 *   - Empty head in a head-only container — delete the whole container.
 *   - Empty head with surviving siblings — delete the head and merge
 *     the rest into whatever doc-level node sits before it.
 *   - Previous paragraph is blank (whitespace-only) — delete it.
 *     If it's the lone head of a previous container, drop the whole
 *     container so we don't leave an orphan.
 *   - Previous paragraph is also a tag/analytic (head of a head-only
 *     previous container) — merge the two containers via
 *     `mergeAdjacentTagContainers`. Card body of the next container
 *     is preserved on the surviving (prev) container.
 *   - Anything else — prohibit (swallow the event).
 */
export const backspaceAtTagStart: Command = (state, dispatch) => {
  const ctx = getTagContext(state);
  if (!ctx) return false;
  if (ctx.cursorOffset !== 0) return false;

  if (tryDeleteEmptyHeadContainer(state, ctx, dispatch)) return true;
  if (tryMergeEmptyHeadIntoPrev(state, ctx, dispatch, -1)) return true;

  const prev = findPrevParagraph(state.doc, ctx.containerFrom);
  if (!prev) return false; // no previous paragraph — let default handle (no-op typically)

  // Priority: BLANK wins. Backspace at start of tag deletes the
  // immediately-preceding paragraph if it's blank, regardless of
  // node type. Even if that preceding paragraph happens to be a tag
  // of an only-tag-card, the user's expectation is "remove the
  // whitespace ahead of me" rather than "merge two tags." Tag-into-
  // tag merge applies only when the preceding tag has actual content.
  if (isBlank(prev.node)) {
    if (!dispatch) return true;
    let tr = state.tr;
    if (prev.isContainerHead) {
      // The blank paragraph is the only tag of a preceding card —
      // delete the whole card so we don't leave an orphan head.
      const $beforeContainer = state.doc.resolve(ctx.containerFrom);
      const prevContainer = $beforeContainer.nodeBefore!;
      const prevContainerFrom = ctx.containerFrom - prevContainer.nodeSize;
      tr = tr.delete(prevContainerFrom, ctx.containerFrom);
    } else {
      tr = tr.delete(prev.from, prev.to);
    }
    dispatch(tr.scrollIntoView());
    return true;
  }

  // Non-blank previous paragraph that's a tag/analytic head of an
  // only-head preceding card → merge the two tags.
  if (prev.isContainerHead && HEAD_NODE_TYPES.has(prev.node.type.name)) {
    if (!dispatch) return true;
    const $beforeContainer = state.doc.resolve(ctx.containerFrom);
    const prevContainer = $beforeContainer.nodeBefore!;
    const prevContainerFrom = ctx.containerFrom - prevContainer.nodeSize;
    const tr = mergeAdjacentTagContainers(state, prevContainerFrom, ctx.containerFrom);
    if (!tr) return true; // merge precondition failed — prohibit
    dispatch(tr.scrollIntoView());
    return true;
  }

  // Anything else (non-blank cite/body/heading) → prohibit.
  return true;
};

/**
 * Forward Delete at the end of a tag/analytic. Cases:
 *   - Empty head in a head-only container — delete the whole container.
 *   - Next paragraph is also a tag/analytic — merge the two heads and
 *     migrate the next container's body/cite/undertags into the
 *     surviving container.
 *   - Anything else — prohibit (swallow the event).
 */
export const deleteAtTagEnd: Command = (state, dispatch) => {
  const ctx = getTagContext(state);
  if (!ctx) return false;
  if (ctx.cursorOffset !== ctx.head.content.size) return false;

  if (tryDeleteEmptyHeadContainer(state, ctx, dispatch)) return true;
  if (tryMergeEmptyHeadIntoPrev(state, ctx, dispatch, 1)) return true;

  // The head must be the LAST child of its container; if there's a
  // sibling after it (undertag / cite / body), forward-delete would
  // pull that sibling in — which is never another tag — so prohibit.
  if (ctx.container.lastChild !== ctx.head) {
    return true;
  }

  const next = findNextParagraph(state.doc, ctx.containerTo);
  if (!next) return false;

  // Permit only when next paragraph is a tag/analytic. Otherwise
  // prohibit (swallow event).
  if (!next.isContainerHead) {
    return true;
  }

  if (!dispatch) return true;

  const tr = mergeAdjacentTagContainers(state, ctx.containerFrom, ctx.containerTo);
  if (!tr) return true;
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Backspace at the start of the FIRST body slot of a card or
 * analytic_unit (the body whose previous sibling is the container's
 * anchor — typically a `cite_paragraph` right after the tag, but the
 * rule applies to any body type there).
 *
 * Word's default `joinBackward` would merge the body's inline
 * content into the tag — silently mixing cite-styled text or body
 * text into the heading. We refuse that:
 *
 *   - If the head is blank (whitespace-only): drop the head and
 *     merge the container's surviving children into the previous
 *     doc-level entity. Mirror of the empty-tag merge initiated
 *     from the body side. Same cross-type folding (analytic in a
 *     card's cite-slot → card_body when merging into an
 *     analytic_unit).
 *   - If the head is non-empty and the body is EMPTY: the user is just
 *     removing a blank line below the tag — there's nothing to collide,
 *     so delete the empty paragraph and put the cursor at the end of the
 *     tag.
 *   - If the head is non-empty and the body has content: no-op, swallow
 *     the event (don't merge body text into the heading).
 *
 * Bodies that aren't the first (cursor at start of body2 in
 * `[tag, body1, body2]`) fall through — default `joinBackward`
 * correctly joins them with their previous sibling in the same
 * container.
 */
export const backspaceAtFirstBodyStart: Command = (state, dispatch) => {
  if (!state.selection.empty) return false;
  const $from = state.selection.$from;
  if ($from.parentOffset !== 0) return false;

  let containerDepth = -1;
  for (let d = $from.depth; d >= 0; d--) {
    if (CARD_NODE_TYPES.has($from.node(d).type.name)) {
      containerDepth = d;
      break;
    }
  }
  if (containerDepth < 0) return false;
  const childDepth = containerDepth + 1;
  if ($from.depth < childDepth) return false;

  const container = $from.node(containerDepth);
  const cursorChild = $from.node(childDepth);
  // Anchor handler covers cursor-in-head; bail.
  if (HEAD_NODE_TYPES.has(cursorChild.type.name)) return false;
  // Only the first body slot — i.e., previous sibling is the anchor.
  let cursorIdx = -1;
  container.forEach((c, _o, i) => {
    if (cursorIdx === -1 && c === cursorChild) cursorIdx = i;
  });
  if (cursorIdx !== 1) return false;

  const containerFrom = $from.before(containerDepth);
  const containerTo = $from.after(containerDepth);

  if (performEmptyHeadMerge(state, dispatch, container, containerFrom, containerTo, -1)) {
    return true;
  }
  // Empty body right below the head: there's no content to collide into
  // the tag, so the user is just trying to delete the blank line. Remove
  // the empty paragraph and drop the cursor at the end of the head. (The
  // collision rule below only makes sense when the body has content.)
  if (cursorChild.content.size === 0) {
    if (!dispatch) return true;
    const bodyFrom = $from.before(childDepth);
    let tr = state.tr.delete(bodyFrom, bodyFrom + cursorChild.nodeSize);
    // `bodyFrom - 1` is the last position inside the head (just before
    // its close token) — i.e., the end of the tag's content.
    tr = tr.setSelection(TextSelection.create(tr.doc, bodyFrom - 1));
    dispatch(tr.scrollIntoView());
    return true;
  }
  // Non-empty head, non-empty body — refuse default joinBackward.
  return true;
};

/**
 * Forward Delete at the end of the LAST child of a card or
 * analytic_unit (when that last child is a body slot — card_body /
 * undertag / cite_paragraph / in-card analytic, anything but the
 * container's anchor).
 *
 * Word's default behavior would pull the next paragraph into the
 * current body as plain text — destructive on a tag/analytic boundary.
 * We refuse that:
 *
 *   - If the next doc-level sibling is a card or analytic_unit whose
 *     head is blank (whitespace-only), absorb that container's
 *     surviving children into the current container. The blank head
 *     is meaningless and the user wants it gone; the bodies flow
 *     naturally into our container.
 *   - In every other case (next is a non-empty card/analytic_unit,
 *     a heading, a paragraph, end-of-doc), no-op and swallow the
 *     event so the destructive default doesn't fire.
 *
 * Cursor stays where it was — at the end of the original body — which
 * after the merge is the new boundary between the original last body
 * and the absorbed survivors.
 */
export const deleteAtContainerEnd: Command = (state, dispatch) => {
  if (!state.selection.empty) return false;
  const $from = state.selection.$from;

  // Find the cursor's enclosing card / analytic_unit and the body slot
  // the cursor sits in.
  let containerDepth = -1;
  for (let d = $from.depth; d >= 0; d--) {
    if (CARD_NODE_TYPES.has($from.node(d).type.name)) {
      containerDepth = d;
      break;
    }
  }
  if (containerDepth < 0) return false;
  const childDepth = containerDepth + 1;
  if ($from.depth < childDepth) return false;

  const container = $from.node(containerDepth);
  const cursorChild = $from.node(childDepth);
  // Anchor slot is handled by deleteAtTagEnd; bail.
  if (HEAD_NODE_TYPES.has(cursorChild.type.name)) return false;
  // Must be the last child AND the cursor must be at the very end of
  // its content for the rule to apply.
  if (container.lastChild !== cursorChild) return false;
  if ($from.parentOffset !== cursorChild.content.size) return false;

  const containerFrom = $from.before(containerDepth);
  const containerTo = $from.after(containerDepth);
  const $afterContainer = state.doc.resolve(containerTo);
  const next = $afterContainer.nodeAfter;

  if (!next) return false; // end of doc — let default handle (no-op).

  // Only cards / analytic_units with a blank head trigger the absorb.
  if (!CARD_NODE_TYPES.has(next.type.name)) {
    // Anything else: prohibit destructive merge.
    return true;
  }
  const nextHead = next.firstChild;
  if (!nextHead || !HEAD_NODE_TYPES.has(nextHead.type.name) || !isBlank(nextHead)) {
    return true;
  }

  if (!dispatch) return true;

  const survivors: PMNode[] = [];
  next.forEach((child, _o, idx) => {
    if (idx > 0) survivors.push(child);
  });
  const adjusted = container.type.name === 'analytic_unit' && next.type.name === 'card'
    ? survivors.map(toAnalyticUnitChild)
    : survivors;

  const mergedContainer = container.copy(
    container.content.append(Fragment.fromArray(adjusted)),
  );

  const nextTo = containerTo + next.nodeSize;
  let tr = state.tr.replaceWith(containerFrom, nextTo, mergedContainer);
  // The cursor's pre-merge position is at the end of the original
  // last body — positions before the merge point are unchanged, so
  // $from.pos still resolves to the same spot.
  tr = tr.setSelection(Selection.near(tr.doc.resolve($from.pos), -1));
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Enter inside a tag/analytic when the cursor is NOT at the end.
 * Splits: a new card with the pre-cursor head content is inserted
 * before the current card; the current head keeps the post-cursor
 * content; existing cite/body/undertags stay with the (post-cursor)
 * current card. The cursor remains at the original head's start
 * (which is now the post-cursor continuation).
 */
export const enterMidTag: Command = (state, dispatch) => {
  const ctx = getTagContext(state);
  if (!ctx) return false;
  if (ctx.cursorOffset === ctx.head.content.size) return false; // end-of-tag handled separately

  if (!dispatch) return true;

  const headType = ctx.head.type;
  const containerType = ctx.container.type;

  const preContent = ctx.head.content.cut(0, ctx.cursorOffset);
  const postContent = ctx.head.content.cut(ctx.cursorOffset);

  // New card: container with just a head holding pre-cursor content
  // and a fresh heading id. It takes the ORIGINAL container's attrs
  // (numbering role/restart, indent…): the pre-cursor half is the card
  // the author was numbering, and the post-cursor half is the new one —
  // built with defaults, the number followed the second card instead
  // (field report 2026-09-02).
  const newHead = headType.createChecked(
    { id: newHeadingId() },
    preContent,
  );
  const newContainer = containerType.createChecked({ ...ctx.container.attrs }, [newHead]);

  let tr = state.tr;
  // Replace original head's inline content with post-cursor content.
  tr = tr.replaceWith(
    ctx.headFrom + 1, // start of original head content
    ctx.headTo - 1,   // end of original head content
    postContent,
  );
  // The original container becomes the second, NEW card: numbering
  // resets to the defaults (unnumbered, flow-through).
  if ('numRole' in ctx.container.attrs) {
    tr = tr.setNodeMarkup(ctx.containerFrom, undefined, {
      ...ctx.container.attrs,
      numRole: 'none',
      numRestart: false,
    });
  }
  // Insert the new container before the current container (positions
  // remain stable because the replaceWith above didn't grow the doc
  // before containerFrom).
  const insertPos = tr.mapping.map(ctx.containerFrom);
  tr = tr.insert(insertPos, newContainer);
  // Cursor: start of the (post-cursor) original head, which has now
  // shifted forward by the new container's size.
  const newHeadStart = tr.mapping.map(ctx.headFrom + 1);
  tr = tr.setSelection(TextSelection.create(tr.doc, newHeadStart));
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Enter at the end of a tag/analytic. Creates a new card_body
 * directly under the head — above any existing cite, undertag, or
 * card body — and moves the cursor into it: the new paragraph lands
 * right below the tag (§12 boundary rule). The card / analytic_unit
 * content schemas permit a body in this position.
 */
export const enterAtTagEnd: Command = (state, dispatch) => {
  const ctx = getTagContext(state);
  if (!ctx) return false;
  if (ctx.cursorOffset !== ctx.head.content.size) return false;

  if (!dispatch) return true;

  const cardBodyType = schema.nodes['card_body']!;
  const empty = cardBodyType.createAndFill();
  if (!empty) return false;

  // Insert right after the head (which is the first child of the
  // container) — i.e., at the position immediately after the head's
  // close token.
  const insertPos = ctx.containerFrom + 1 + ctx.head.nodeSize;

  let tr = state.tr;
  tr = tr.insert(insertPos, empty);
  // Cursor: inside the new card_body (one step past its open).
  const newBodyStart = insertPos + 1;
  tr = tr.setSelection(TextSelection.create(tr.doc, newBodyStart));
  dispatch(tr.scrollIntoView());
  return true;
};

const HEADING_TYPES = new Set(['pocket', 'hat', 'block']);

/**
 * Enter inside a Pocket / Hat / Block. Two cases:
 *   - At end of heading: insert a Normal paragraph immediately after,
 *     cursor moves into it. (Default ProseMirror would create a Pocket
 *     because Pocket is the first textblock in the doc's content
 *     alternation.)
 *   - Anywhere else (start or middle): split — the pre-cursor content
 *     becomes a new heading of the same type inserted before, the
 *     post-cursor content remains in the original heading. Cursor
 *     stays at the start of the post-cursor side.
 *
 * The same-type-split rule means a Hat splits into two Hats, a Block
 * into two Blocks, a Pocket into two Pockets — never the wrong type.
 */
export const enterInHeading: Command = (state, dispatch) => {
  if (!state.selection.empty) return false;
  const { $from } = state.selection;
  if (!HEADING_TYPES.has($from.parent.type.name)) return false;

  const heading = $from.parent;
  const cursorOffset = $from.parentOffset;
  const headingDepth = $from.depth;

  if (cursorOffset === heading.content.size) {
    if (!dispatch) return true;
    const para = schema.nodes['paragraph']!.createAndFill();
    if (!para) return false;
    const insertPos = $from.after(headingDepth);
    let tr = state.tr.insert(insertPos, para);
    tr = tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
    dispatch(tr.scrollIntoView());
    return true;
  }

  // At start or middle: split into two same-type headings.
  if (!dispatch) return true;
  const preContent = heading.content.cut(0, cursorOffset);
  const postContent = heading.content.cut(cursorOffset);
  // The pre-cursor half inherits the original's attrs (a block's
  // numRestart, indent…) under a fresh id; the post-cursor half is the
  // new heading and takes the type defaults — same rule as enterMidTag.
  const newHeading = heading.type.createChecked(
    { ...heading.attrs, id: newHeadingId() },
    preContent,
  );

  let tr = state.tr;
  // 1. Replace original heading's content with post-cursor.
  tr = tr.replaceWith($from.start(headingDepth), $from.end(headingDepth), postContent);
  if ('numRestart' in heading.attrs) {
    const resetAttrs = { ...heading.attrs, numRestart: heading.type.spec.attrs?.['numRestart']?.default };
    tr = tr.setNodeMarkup($from.before(headingDepth), undefined, resetAttrs);
  }
  // 2. Insert new heading before the original.
  const insertPos = tr.mapping.map($from.before(headingDepth));
  tr = tr.insert(insertPos, newHeading);
  // 3. Cursor at start of the (post-cursor) original heading content.
  //    assoc=-1 keeps the position at the boundary rather than past
  //    the inserted new heading.
  const cursorPos = tr.mapping.map($from.start(headingDepth), -1);
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos));
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Enter at the very START of a live zone's first header → a same-kind empty
 * header appears ABOVE the zone, OUTSIDE it. Mirrors "Enter at the start of a
 * card's tag makes a new card above, outside the card" (your "space before")
 * for the whole zone. Runs BEFORE enterMidTag / enterInHeading, which would
 * otherwise place the new header INSIDE the zone; a header in the zone's
 * INTERIOR falls through to them (stays in), so only the top edge escapes.
 */
export const enterAtZoneStart: Command = (state, dispatch) => {
  if (!state.selection.empty) return false;
  const $from = state.selection.$from;
  if ($from.parentOffset !== 0) return false; // must be at the very start
  const base = enclosingZoneDepth($from);
  if (base === 0) return false; // not in a zone
  if ($from.index(base) !== 0) return false; // not the zone's FIRST child block

  const parent = $from.parent;
  const zonePos = $from.before(base); // just before the transclusion_ref

  // Standalone heading (pocket / hat / block) that is the zone's first child.
  if ($from.depth === base + 1 && HEADING_TYPES.has(parent.type.name)) {
    if (!dispatch) return true;
    const newHeading = parent.type.createChecked({ id: newHeadingId() }, Fragment.empty);
    dispatch(state.tr.insert(zonePos, newHeading).scrollIntoView());
    return true;
  }

  // Card tag / analytic anchor whose container is the zone's first child.
  if ($from.depth === base + 2 && HEAD_NODE_TYPES.has(parent.type.name)) {
    const container = $from.node(base + 1);
    if (!CARD_NODE_TYPES.has(container.type.name)) return false;
    if (container.firstChild !== parent) return false; // head isn't the anchor
    if (!dispatch) return true;
    const newHead = parent.type.createChecked({ id: newHeadingId() }, Fragment.empty);
    const newContainer = container.type.createChecked(null, [newHead]);
    dispatch(state.tr.insert(zonePos, newContainer).scrollIntoView());
    return true;
  }

  return false;
};
