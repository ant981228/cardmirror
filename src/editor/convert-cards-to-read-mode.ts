/**
 * Destructively reduce cards to the text read mode shows.
 *
 * Every rule here is read mode's own: which text is audible comes from
 * the read-mode plugin (`isReadModeKeptText` — highlights, cites, the
 * reading-marker color, whatever the settings say), and the paragraph
 * shape follows the "Read mode: preserve paragraph integrity" setting —
 * off, a card's body paragraphs flow together into one; on, each source
 * paragraph with audible text keeps its own line and empty ones collapse.
 * Undertags and cites keep their own node with only their audible text,
 * as read mode displays them.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import { isReadModeKeptText } from './read-mode-plugin.js';
import { settings } from './settings.js';

interface CardAt {
  node: PMNode;
  pos: number;
}

class AudibleInlineBuilder {
  readonly nodes: PMNode[] = [];
  private pendingSpaceMarks: readonly Mark[] | null = null;

  addTextblock(node: PMNode): void {
    node.forEach((child) => {
      if (!child.isText || !child.text) return;
      if (!isReadModeKeptText(child, node.type.name)) {
        this.breakRun();
        return;
      }
      for (const token of child.text.match(/\s+|\S+/gu) ?? []) {
        if (/^\s+$/u.test(token)) {
          if (this.nodes.length > 0) this.pendingSpaceMarks = child.marks;
          continue;
        }
        this.flushSpace(child.type.schema);
        this.nodes.push(child.type.schema.text(token, child.marks));
      }
    });
    this.breakRun();
  }

  private breakRun(): void {
    if (this.nodes.length > 0) this.pendingSpaceMarks = [];
  }

  private flushSpace(schema: PMNode['type']['schema']): void {
    if (this.nodes.length > 0 && this.pendingSpaceMarks !== null) {
      this.nodes.push(schema.text(' ', this.pendingSpaceMarks));
    }
    this.pendingSpaceMarks = null;
  }
}

function selectedCards(state: EditorState): CardAt[] {
  if (!state.selection.empty) {
    const cards: CardAt[] = [];
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
      if (node.type.name === 'analytic_unit') return false;
      if (node.type.name !== 'card') return true;
      cards.push({ node, pos });
      return false;
    });
    return cards;
  }

  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'card') return [{ node, pos: $from.before(depth) }];
  }
  return [];
}

function convertCard(card: PMNode): PMNode {
  const schema = card.type.schema;
  const separateParagraphs = settings.get('readModeParagraphIntegrity');
  const sourceTag = card.firstChild!;
  const tagContent: PMNode[] = [];
  sourceTag.forEach((child) => {
    if (child.type.name !== 'image') tagContent.push(child);
  });
  const tag = sourceTag.type.create(sourceTag.attrs, tagContent, sourceTag.marks);
  const children: PMNode[] = [tag];
  let body = new AudibleInlineBuilder();
  const flushBody = (): void => {
    if (body.nodes.length > 0) children.push(schema.nodes['card_body']!.create(null, body.nodes));
    body = new AudibleInlineBuilder();
  };
  // A body-like source paragraph: joined into the running body (read
  // mode's default flow), or — with paragraph integrity on — its own
  // paragraph when it has audible text, nothing at all when it has none.
  const addBodyParagraph = (node: PMNode): void => {
    if (!separateParagraphs) {
      body.addTextblock(node);
      return;
    }
    const one = new AudibleInlineBuilder();
    one.addTextblock(node);
    if (one.nodes.length === 0) return;
    flushBody();
    children.push(schema.nodes['card_body']!.create(null, one.nodes));
  };

  card.forEach((child, _offset, index) => {
    if (index === 0) return;
    if (child.type.name === 'cite_paragraph' || child.type.name === 'undertag') {
      // Their own node, audible text only — read mode shows an undertag's
      // highlighted words just as it shows a cite's.
      const kept = new AudibleInlineBuilder();
      kept.addTextblock(child);
      if (kept.nodes.length > 0) {
        flushBody();
        children.push(child.type.create(child.attrs, kept.nodes));
      }
    } else if (child.type.name === 'card_body') {
      addBodyParagraph(child);
    } else if (child.type.name === 'table') {
      child.descendants((descendant) => {
        if (descendant.type.name !== 'paragraph') return true;
        addBodyParagraph(descendant);
        return false;
      });
    }
  });

  flushBody();
  return card.type.createChecked(card.attrs, children, card.marks);
}

export const convertCardsToReadMode: Command = (state, dispatch) => {
  const replacements = selectedCards(state)
    .map((target) => ({ ...target, converted: convertCard(target.node) }))
    .filter((target) => !target.converted.eq(target.node));
  if (replacements.length === 0) return false;
  if (dispatch) {
    const tr = state.tr;
    for (let index = replacements.length - 1; index >= 0; index--) {
      const target = replacements[index]!;
      tr.replaceWith(target.pos, target.pos + target.node.nodeSize, target.converted);
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};
