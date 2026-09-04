/** Destructively reduce cards to the text shown by default read mode. */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import { isReadModeKeptText } from './read-mode-plugin.js';

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
  const sourceTag = card.firstChild!;
  const tagContent: PMNode[] = [];
  sourceTag.forEach((child) => {
    if (child.type.name !== 'image') tagContent.push(child);
  });
  const tag = sourceTag.type.create(sourceTag.attrs, tagContent, sourceTag.marks);
  const children: PMNode[] = [tag];
  let body = new AudibleInlineBuilder();

  card.forEach((child, _offset, index) => {
    if (index === 0) return;
    if (child.type.name === 'cite_paragraph') {
      const kept = new AudibleInlineBuilder();
      kept.addTextblock(child);
      if (kept.nodes.length > 0) {
        if (body.nodes.length > 0) {
          children.push(card.type.schema.nodes['card_body']!.create(null, body.nodes));
          body = new AudibleInlineBuilder();
        }
        children.push(child.type.create(child.attrs, kept.nodes));
      }
    } else if (child.type.name === 'card_body') {
      body.addTextblock(child);
    } else if (child.type.name === 'table') {
      child.descendants((descendant) => {
        if (descendant.type.name !== 'paragraph') return true;
        body.addTextblock(descendant);
        return false;
      });
    }
  });

  if (body.nodes.length > 0) {
    children.push(card.type.schema.nodes['card_body']!.create(null, body.nodes));
  }
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
