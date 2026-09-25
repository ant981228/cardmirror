/**
 * The blank document New creates — exactly one empty paragraph, shared
 * by single-pane and the three-pane shell so the two modes cannot
 * drift. Pocket seeding is a speech-doc-only, setting-gated affordance
 * (`makeSpeechBlankDoc` behind "Seed new speech docs with a Pocket
 * heading"); a plain New must not grow headings — the pane chip / window
 * title already carry the doc's name, and the speech path's pocket-OFF
 * cursor math assumes position 1 is inside the only paragraph.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';
import { undoDepth } from 'prosemirror-history';
import { schema } from '../schema/index.js';

export function makeBlankDoc(): PMNode {
  return schema.nodes['doc']!.createChecked(null, [
    schema.nodes['paragraph']!.create(),
  ]);
}

/** True when `state` is still exactly what New made: one empty
 *  paragraph AND nothing in the undo history. The history check is what
 *  keeps "typed something, then deleted it" from counting as untouched —
 *  the doc looks blank, but the user has worked in it. Used by the
 *  three-pane shell to let an opened file take an Untitled doc's place. */
export function isUntouchedBlank(state: EditorState): boolean {
  const doc = state.doc;
  if (doc.childCount !== 1) return false;
  const only = doc.firstChild!;
  if (only.type !== schema.nodes['paragraph'] || only.content.size !== 0) return false;
  return undoDepth(state) === 0;
}
