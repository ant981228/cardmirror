/**
 * NodeView for a `self_ref` — the intra-document live view.
 *
 * The view now holds its mirrored section as REAL, read-only child content (kept
 * in sync by the content plugin), so this NodeView is thin: it exposes a
 * `contentDOM` for ProseMirror to render the children into, plus the rail + glyph
 * menu (Go to source / Re-pick / Unlink / Delete) and a "source not found" note.
 * Because the children are real editor content, native selection flows through
 * the view like any other content — no projection rendering, no shadow DOM.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { icon, type IconName } from './icons.js';
import { resolveSelfRefProjection } from './self-transclusion.js';
import {
  jumpToSelfRefSource,
  openRepickSelfRef,
  unlinkSelfRef,
  deleteSelfRef,
} from './self-transclusion-commands.js';

class SelfRefView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly glyphBtn: HTMLButtonElement;
  private readonly note: HTMLElement;
  private readonly referenceHeading: HTMLElement;
  private node: PMNode;
  private readonly view: EditorView;
  private readonly getPos: () => number | undefined;
  private menuEl: HTMLElement | null = null;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement('div');
    this.dom.className = 'pmd-self-ref';
    this.dom.classList.toggle('pmd-live-reference', !!node.attrs['source_anchor_id']);
    this.dom.classList.toggle('pmd-live-reference-gray', node.attrs['reference_gray'] === true);

    this.glyphBtn = document.createElement('button');
    this.glyphBtn.type = 'button';
    this.glyphBtn.className = 'pmd-transclusion-glyph-btn pmd-self-ref-glyph';
    this.glyphBtn.setAttribute('contenteditable', 'false');
    this.glyphBtn.title = 'Live view — a read-only window onto another section of this document';
    this.glyphBtn.setAttribute('aria-label', 'Live view actions');
    this.glyphBtn.appendChild(icon('link'));
    this.glyphBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    this.glyphBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleMenu();
    });

    // ProseMirror renders the (read-only) mirrored children here.
    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'pmd-self-ref-body';

    this.referenceHeading = document.createElement('div');
    this.referenceHeading.className = 'pmd-live-reference-heading';
    this.referenceHeading.setAttribute('contenteditable', 'false');
    this.referenceHeading.textContent = String(node.attrs['reference_heading'] ?? '');
    this.refreshReferenceHeadingStyle();
    this.referenceHeading.hidden = !this.referenceHeading.textContent;

    // "Source not found" note (chrome — shown only when the source is missing).
    this.note = document.createElement('div');
    this.note.className = 'pmd-self-ref-note';
    this.note.setAttribute('contenteditable', 'false');
    this.note.textContent = 'Source section not found in this document.';

    this.dom.appendChild(this.glyphBtn);
    this.dom.appendChild(this.referenceHeading);
    this.dom.appendChild(this.contentDOM);
    this.dom.appendChild(this.note);
    this.refreshNote();
  }

  private headingId(): string {
    return String(this.node.attrs['source_heading_id'] ?? '');
  }

  /** Show the note + missing/cycle styling only when the source is absent. The
   *  children themselves are maintained by the content plugin. */
  private refreshNote(): void {
    let missing = false;
    let cycle = false;
    try {
      const p = resolveSelfRefProjection(this.view.state.doc, this.node);
      missing = p.missing;
      cycle = p.cycle;
    } catch {
      /* doc mid-update — leave as-is */
    }
    this.dom.classList.toggle('pmd-self-ref-missing', missing);
    this.dom.classList.toggle('pmd-self-ref-cycle', cycle);
    this.note.style.display = missing ? '' : 'none';
  }

  private sectionLabel(): string {
    return String(this.node.attrs['source_label'] ?? '').replace(/^↳\s*/, '') || 'Section';
  }

  private refreshReferenceHeadingStyle(): void {
    this.referenceHeading.classList.toggle('pmd-live-reference-heading-bold', this.node.attrs['reference_heading_bold'] === true);
    this.referenceHeading.classList.toggle('pmd-live-reference-heading-italic', this.node.attrs['reference_heading_italic'] === true);
    this.referenceHeading.classList.toggle('pmd-live-reference-heading-emphasized', this.node.attrs['reference_heading_emphasized'] === true);
    this.referenceHeading.classList.toggle('pmd-live-reference-heading-underlined', this.node.attrs['reference_heading_underlined'] === true);
  }

  private toggleMenu(): void {
    if (this.menuEl) {
      this.closeMenu();
      return;
    }
    const menu = document.createElement('div');
    menu.className = 'pmd-transclusion-menu';
    menu.setAttribute('contenteditable', 'false');

    const info = document.createElement('div');
    info.className = 'pmd-transclusion-menu-info';
    const fileRow = document.createElement('div');
    fileRow.className = 'pmd-transclusion-menu-file';
    fileRow.appendChild(icon('link'));
    const fileText = document.createElement('span');
    fileText.textContent = 'This document';
    fileRow.appendChild(fileText);
    info.appendChild(fileRow);
    const secRow = document.createElement('div');
    secRow.className = 'pmd-transclusion-menu-section';
    secRow.textContent = this.sectionLabel();
    info.appendChild(secRow);
    const meta = document.createElement('div');
    meta.className = 'pmd-transclusion-menu-meta';
    const status = document.createElement('span');
    status.textContent = 'Live view of this document';
    meta.appendChild(status);
    info.appendChild(meta);
    menu.appendChild(info);

    const sep = document.createElement('div');
    sep.className = 'pmd-transclusion-menu-sep';
    menu.appendChild(sep);

    menu.appendChild(
      this.menuItem('bookmark', 'Go to source', () => {
        this.closeMenu();
        jumpToSelfRefSource(
          this.view,
          this.headingId(),
          String(this.node.attrs['source_anchor_id'] ?? ''),
        );
      }),
    );
    if (!this.node.attrs['source_anchor_id']) {
      menu.appendChild(
        this.menuItem('search', 'Re-pick source…', () => {
          this.closeMenu();
          const pos = this.getPos();
          if (pos != null) openRepickSelfRef(this.view, pos);
        }),
      );
    }
    menu.appendChild(
      this.menuItem('edit', 'Unlink (keep a copy)', () => {
        this.closeMenu();
        const pos = this.getPos();
        if (pos != null) unlinkSelfRef(this.view, pos);
      }),
    );
    menu.appendChild(
      this.menuItem('trash', 'Delete', () => {
        this.closeMenu();
        const pos = this.getPos();
        if (pos != null) deleteSelfRef(this.view, pos);
      }),
    );

    this.dom.appendChild(menu);
    this.menuEl = menu;
    this.dom.classList.add('pmd-transclusion-menu-open');
    setTimeout(() => {
      document.addEventListener('mousedown', this.onOutsidePointer, true);
      document.addEventListener('keydown', this.onMenuKey, true);
    }, 0);
  }

  private onOutsidePointer = (e: Event): void => {
    if (this.menuEl && !this.menuEl.contains(e.target as Node) && e.target !== this.glyphBtn) {
      this.closeMenu();
    }
  };
  private onMenuKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closeMenu();
    }
  };
  private closeMenu(): void {
    if (!this.menuEl) return;
    this.menuEl.remove();
    this.menuEl = null;
    this.dom.classList.remove('pmd-transclusion-menu-open');
    document.removeEventListener('mousedown', this.onOutsidePointer, true);
    document.removeEventListener('keydown', this.onMenuKey, true);
  }

  private menuItem(iconName: IconName, label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-transclusion-menu-item';
    btn.appendChild(icon(iconName));
    const span = document.createElement('span');
    span.textContent = label;
    btn.appendChild(span);
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.dom.classList.toggle('pmd-live-reference', !!node.attrs['source_anchor_id']);
    this.dom.classList.toggle('pmd-live-reference-gray', node.attrs['reference_gray'] === true);
    this.referenceHeading.textContent = String(node.attrs['reference_heading'] ?? '');
    this.refreshReferenceHeadingStyle();
    this.referenceHeading.hidden = !this.referenceHeading.textContent;
    // PM updates the children in `contentDOM` itself; we only refresh the chrome.
    this.refreshNote();
    return true;
  }

  /** Ignore mutations to the chrome (glyph, menu, note); let PM manage
   *  `contentDOM`. CRUCIALLY, never ignore a SELECTION mutation — that's how PM
   *  reads a native drag/shift-click that crosses the view; ignoring it (because
   *  the endpoint sits at/outside the boundary) is what made a manual selection
   *  stop at the view's edge. */
  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    if (m.type === 'selection') return false;
    return !this.contentDOM.contains((m as MutationRecord).target);
  }

  /** Keep glyph/menu clicks away from PM; everything on the content falls through
   *  so selection/caret behave like normal read-only content. */
  stopEvent(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t?.closest?.('.pmd-self-ref-glyph, .pmd-transclusion-menu');
  }

  destroy(): void {
    this.closeMenu();
  }
}

export const selfRefNodeViews = {
  self_ref: (node: PMNode, view: EditorView, getPos: () => number | undefined): NodeView =>
    new SelfRefView(node, view, getPos),
};
