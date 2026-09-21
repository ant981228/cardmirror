import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import { highlightRgbFor } from './color-palette.js';
import type { CreateReferenceHighlightMode } from './settings.js';

export const REFERENCE_SHADING_HEX = 'C0C0C0';

export interface ReferenceBodyStyle {
  shrink: boolean;
  shrinkPt: number;
  highlightMode: CreateReferenceHighlightMode;
  useGray50: boolean;
}

/** Apply Create Reference's body styling to one current source text run. */
export function styleReferenceText(
  child: PMNode,
  effectivePt: number,
  opts: ReferenceBodyStyle,
): PMNode {
  if (!child.isText) return child;
  const fontSizeType = schema.marks['font_size']!;
  const fontColorType = schema.marks['font_color']!;
  const highlightType = schema.marks['highlight']!;
  const shadingType = schema.marks['shading']!;
  const stripHighlight = opts.highlightMode !== 'keep';
  let marks: readonly import('prosemirror-model').Mark[] = child.marks.filter(
    (mark) =>
      (!opts.shrink || mark.type !== fontSizeType) &&
      mark.type !== fontColorType &&
      (!stripHighlight || mark.type !== highlightType),
  );
  const highlight = child.marks.find((mark) => mark.type === highlightType);
  if (highlight && (opts.highlightMode === 'shading' || opts.highlightMode === 'convert')) {
    const color =
      opts.highlightMode === 'shading'
        ? REFERENCE_SHADING_HEX
        : highlightRgbFor(String(highlight.attrs['color'] ?? 'yellow')) ?? 'FFFF00';
    marks = shadingType.create({ color }).addToSet(marks);
  }
  if (opts.shrink) {
    const explicit = child.marks.find((mark) => mark.type === fontSizeType);
    const currentPt = explicit
      ? Number(explicit.attrs['halfPoints'] ?? 22) / 2
      : effectivePt;
    marks = fontSizeType
      .create({ halfPoints: Math.round(Math.max(1, currentPt - opts.shrinkPt) * 2) })
      .addToSet(marks);
  }
  return child.mark(
    fontColorType.create({ color: opts.useGray50 ? '808080' : '000000' }).addToSet(marks),
  );
}
