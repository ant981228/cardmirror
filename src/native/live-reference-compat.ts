/**
 * Save-time backward compatibility for Create Live Reference.
 *
 * Builds before live references don't know the `live_reference_source` mark:
 * `Mark.fromJSON` throws on an unknown mark type, so a `.cmir` carrying one
 * can't be opened there at all. The mark is added to the source text the moment
 * a live reference is created, and it outlives the reference — the copy may
 * never be pasted, or the pasted view may be deleted later. The live-reference
 * attrs on `self_ref` are likewise serialized (at their defaults) on every
 * ordinary heading-based window.
 *
 * So the file only carries live-reference data while a live `self_ref` in the
 * doc actually links to it: anchor ids with no live view are pruned (the mark is
 * dropped once none remain), and heading-based windows keep only their original
 * attrs. The live editor doc is untouched — this rewrites only the JSON a save
 * writes. Works on the JSON tree (not a rebuilt PM doc) because PM always fills
 * attr defaults back in on `create`.
 */

const LIVE_SOURCE_MARK = 'live_reference_source';
const SELF_REF_NODE = 'self_ref';

/** `self_ref` attrs that predate live references. Every other attr on the node
 *  is live-reference metadata, written only for a live view. */
const LEGACY_SELF_REF_ATTRS: Record<string, true> = { source_heading_id: true, source_label: true };

interface JsonMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  marks?: JsonMark[];
  text?: string;
}

function liveAnchorId(node: JsonNode): string {
  if (node.type !== SELF_REF_NODE) return '';
  const id = node.attrs?.['source_anchor_id'];
  return typeof id === 'string' ? id : '';
}

function collectLinkedAnchorIds(node: JsonNode, out: Set<string>): void {
  const id = liveAnchorId(node);
  if (id) out.add(id);
  if (node.content) for (const child of node.content) collectLinkedAnchorIds(child, out);
}

/** The anchor mark restricted to linked ids, or null when none are linked. */
function pruneAnchorMark(mark: JsonMark, linked: ReadonlySet<string>): JsonMark | null {
  const ids = String(mark.attrs?.['ids'] ?? '').split(' ').filter(Boolean);
  const kept = ids.filter((id) => linked.has(id));
  if (kept.length === 0) return null;
  if (kept.length === ids.length) return mark;
  let sizes: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(mark.attrs?.['sizes'] ?? '{}')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      sizes = parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed sizes: keep none; resolution falls back to Normal size */
  }
  const keptSizes: Record<string, unknown> = {};
  for (const id of kept) if (id in sizes) keptSizes[id] = sizes[id];
  return { ...mark, attrs: { ...mark.attrs, ids: kept.join(' '), sizes: JSON.stringify(keptSizes) } };
}

function stripNode(node: JsonNode, linked: ReadonlySet<string>): JsonNode {
  let out = node;
  if (node.type === SELF_REF_NODE && !liveAnchorId(node) && node.attrs) {
    const attrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.attrs)) {
      if (LEGACY_SELF_REF_ATTRS[key]) attrs[key] = value;
    }
    out = { ...out, attrs };
  }
  if (node.marks?.some((mark) => mark.type === LIVE_SOURCE_MARK)) {
    const marks: JsonMark[] = [];
    for (const mark of node.marks) {
      const kept = mark.type === LIVE_SOURCE_MARK ? pruneAnchorMark(mark, linked) : mark;
      if (kept) marks.push(kept);
    }
    out = { ...out };
    if (marks.length) out.marks = marks;
    else delete out.marks;
  }
  if (node.content) {
    let changed = false;
    const content = node.content.map((child) => {
      const next = stripNode(child, linked);
      if (next !== child) changed = true;
      return next;
    });
    if (changed) out = { ...out, content };
  }
  return out;
}

/** Drop live-reference data no live reference links to from a doc's JSON. */
export function stripUnlinkedLiveReferenceData(docJson: unknown): unknown {
  const root = docJson as JsonNode;
  const linked = new Set<string>();
  collectLinkedAnchorIds(root, linked);
  return stripNode(root, linked);
}
