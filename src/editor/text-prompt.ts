/**
 * Modal text-prompt dialog. Drop-in replacement for the browser's
 * native `window.prompt` — Electron's BrowserWindows disable
 * `prompt()` outright (it throws "prompt() is not supported"), so
 * every prompt-style flow that needs to run on the desktop edition
 * routes through this helper instead.
 *
 * Returns the trimmed input on submit, or `null` on cancel (Esc,
 * Cancel button, or click outside the dialog box). Auto-focuses the
 * input on open; Enter submits, Esc cancels. Visual shape mirrors
 * the existing `pmd-route-dialog` overlays so it reads as part of
 * the same modal vocabulary.
 *
 * Every dialog here registers on the shared overlay stack for its
 * whole lifetime: background key handlers (the home screen's 1-9
 * shortcuts, its Escape) check `isAnyOverlayOpen()` to stand down, so
 * a dialog that skips registration leaks its number keys through to
 * whatever is underneath — pressing '2' in a route dialog over the
 * home screen would ALSO fire home action 2. Key handling is guarded
 * with `isTopOverlay` so stacked dialogs don't collapse together.
 */

import { pushOverlay, popOverlay, isTopOverlay } from './overlay-stack.js';
import { isBackdropClick } from './backdrop-click.js';

/**
 * Shared modal key wiring (field bug 2026-07-27: Enter confirming the
 * mode-switch dialog ALSO inserted a newline at the editor cursor).
 * These dialogs never steal focus by default, so a keydown's target is
 * the focused editor — and ProseMirror's bubble-phase handler on
 * `view.dom` dispatches transactions (Enter = split-block) BEFORE a
 * bubble-phase document listener runs; a late preventDefault can't
 * undo a dispatched transaction. The fix is the pattern the other ~19
 * modals in this codebase already use: listen in CAPTURE phase, and
 * preventDefault — ProseMirror's `eventBelongsToView` skips its
 * handler entirely for default-prevented events — plus stopPropagation
 * as defense against other document-level listeners. Keys not handled
 * by the dialog and not aimed at its own controls are swallowed too:
 * a modal must never let typing fall through into the document.
 *
 * `handle` returns true when it consumed the key (prevent+stop are
 * applied here), false to fall through to the swallow rule — which
 * exempts events targeting the dialog's own controls, so e.g. a
 * textarea keeps its native Enter-newline.
 */
export function installModalKeys(
  dialog: HTMLElement,
  overlayToken: symbol,
  handle: (e: KeyboardEvent) => boolean,
): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (!isTopOverlay(overlayToken)) return;
    if (handle(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!dialog.contains(e.target as Node)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  document.addEventListener('keydown', onKey, true);
  return () => document.removeEventListener('keydown', onKey, true);
}

/** Give the dialog a coherent focus + accessibility story: focus moves
 *  INTO the dialog (so keydown targets can never be the editor — the
 *  second, independent line of defense against key leaks, and the one
 *  that survives Electron focus-restore flakiness), and assistive tech
 *  gets a labeled modal. Focus the container, not a button — a focused
 *  button would ALSO native-activate on Enter and double-fire. */
export function armDialogFocus(
  dialog: HTMLElement,
  role: 'dialog' | 'alertdialog',
  label: string,
): void {
  dialog.setAttribute('role', role);
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', label);
  dialog.tabIndex = -1;
  dialog.focus();
}

/** Capture the focused element at dialog open; returns a restorer to call on
 *  close. In-DOM overlays don't steal OS-level focus, but removing them
 *  leaves the caret on <body> — the editor keeps its visible selection yet
 *  takes no keystrokes until clicked. Restoring the captured element (when
 *  it's still in the DOM) puts the caret back with zero caller involvement.
 *  Exported for one-off overlays (e.g. the select-speech-doc modal) that
 *  don't ride these helpers. */
export function captureFocusForDialog(): () => void {
  const prev = document.activeElement;
  return () => {
    if (prev instanceof HTMLElement && prev.isConnected) {
      try {
        prev.focus();
      } catch {
        /* element refuses focus — nothing to restore */
      }
    }
  };
}

export interface TextPromptOptions {
  /** Title / question shown above the input. */
  message: string;
  /** Initial value of the input. Defaults to ''. */
  initial?: string;
  /** Placeholder when the input is empty. */
  placeholder?: string;
  /** Label on the submit button. Defaults to 'OK'. */
  okLabel?: string;
  /** Label on the cancel button. Defaults to 'Cancel'. */
  cancelLabel?: string;
  /** Render a `<textarea>` (multi-line) instead of `<input type=text>`.
   *  In multiline mode, Enter inserts a newline; Ctrl/Cmd+Enter submits. */
  multiline?: boolean;
  /** Mask the input (`type="password"`) and DON'T trim the result —
   *  a password's own leading/trailing spaces are significant. */
  password?: boolean;
  /** Optional second line under the message — context or an error
   *  (e.g. "Incorrect password — try again"). Rendered read-only. */
  detail?: string;
}

export function promptForText(opts: TextPromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const restoreFocus = captureFocusForDialog();
    const overlayToken = pushOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog pmd-text-prompt-dialog';

    const header = document.createElement('div');
    header.className = 'pmd-route-header';
    header.textContent = opts.message;
    dialog.appendChild(header);

    if (opts.detail) {
      const detail = document.createElement('div');
      detail.className = 'pmd-text-prompt-detail';
      detail.textContent = opts.detail;
      dialog.appendChild(detail);
    }

    const input: HTMLInputElement | HTMLTextAreaElement = opts.multiline
      ? document.createElement('textarea')
      : document.createElement('input');
    if (input instanceof HTMLInputElement) input.type = opts.password ? 'password' : 'text';
    input.className = 'pmd-text-prompt-input';
    input.value = opts.initial ?? '';
    if (opts.placeholder) input.placeholder = opts.placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    dialog.appendChild(input);

    const buttons = document.createElement('div');
    buttons.className = 'pmd-text-prompt-buttons';

    let settled = false;
    let removeKeys = (): void => {};
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      popOverlay(overlayToken);
      overlay.remove();
      removeKeys();
      restoreFocus();
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'pmd-route-cancel';
    cancelBtn.textContent = opts.cancelLabel ?? 'Cancel';
    cancelBtn.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });
    buttons.appendChild(cancelBtn);

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'pmd-text-prompt-ok';
    okBtn.textContent = opts.okLabel ?? 'OK';
    okBtn.addEventListener('click', () => {
      cleanup();
      resolve(opts.password ? input.value : input.value.trim());
    });
    buttons.appendChild(okBtn);

    dialog.appendChild(buttons);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (isBackdropClick(e, overlay)) {
        cleanup();
        resolve(null);
      }
    });

    removeKeys = installModalKeys(dialog, overlayToken, (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(null);
        return true;
      }
      if (e.key === 'Enter') {
        // Multiline: Enter inserts a newline (falls through to the
        // input's native behavior); Ctrl/Cmd+Enter submits.
        if (opts.multiline && !(e.ctrlKey || e.metaKey)) return false;
        cleanup();
        resolve(opts.password ? input.value : input.value.trim());
        return true;
      }
      return false;
    });

    document.body.appendChild(overlay);
    armDialogFocus(dialog, 'dialog', opts.message);
    // Focus + select so users can immediately type a replacement
    // when an initial value is supplied.
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

export interface ChoicePromptOptions<T extends string> {
  /** Title / question shown above the choice buttons. */
  message: string;
  /** Optional second-line body — used to show details the choice is
   *  about (e.g., the existing alt text the user is deciding to keep
   *  or replace). Rendered read-only beneath the message. */
  detail?: string;
  /** Buttons in left-to-right display order. Each button's `value` is
   *  what the returned promise resolves to. The button marked
   *  `primary: true` (or the first one if none is) is activated by
   *  Enter; Esc / overlay-click always resolves to null. */
  choices: { value: T; label: string; primary?: boolean }[];
  /** Label on the trailing cancel button. Defaults to 'Cancel'. */
  cancelLabel?: string;
  /** Render `detail` as ordinary inline prose under the message — no
   *  box, no height cap, never scrolls — for a short explanation of
   *  the question itself. The default boxed style suits quoted content
   *  the choice is about (existing alt text), which can be long. */
  detailInline?: boolean;
}

/** Modal that asks the user to pick one of N options. Returns the
 *  chosen `value`, or `null` if the user cancels.
 *
 *  Visual shape mirrors `promptForText` so it reads as part of the
 *  same dialog vocabulary. */
export function promptForChoice<T extends string>(
  opts: ChoicePromptOptions<T>,
): Promise<T | null> {
  return new Promise((resolve) => {
    const restoreFocus = captureFocusForDialog();
    const overlayToken = pushOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog pmd-text-prompt-dialog';

    const header = document.createElement('div');
    header.className = 'pmd-route-header';
    header.textContent = opts.message;
    dialog.appendChild(header);

    if (opts.detail) {
      const detail = document.createElement('div');
      detail.className = opts.detailInline
        ? 'pmd-choice-prompt-detail-inline'
        : 'pmd-choice-prompt-detail';
      detail.textContent = opts.detail;
      if (opts.detailInline) dialog.classList.add('pmd-choice-prompt-prose');
      dialog.appendChild(detail);
    }

    const buttons = document.createElement('div');
    buttons.className = 'pmd-text-prompt-buttons';

    let settled = false;
    let removeKeys = (): void => {};
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      popOverlay(overlayToken);
      overlay.remove();
      removeKeys();
      restoreFocus();
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'pmd-route-cancel';
    cancelBtn.textContent = opts.cancelLabel ?? 'Cancel';
    cancelBtn.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });
    buttons.appendChild(cancelBtn);

    const primary = opts.choices.find((c) => c.primary) ?? opts.choices[0]!;
    for (const choice of opts.choices) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-text-prompt-ok';
      btn.textContent = choice.label;
      btn.addEventListener('click', () => {
        cleanup();
        resolve(choice.value);
      });
      buttons.appendChild(btn);
    }

    dialog.appendChild(buttons);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (isBackdropClick(e, overlay)) {
        cleanup();
        resolve(null);
      }
    });

    removeKeys = installModalKeys(dialog, overlayToken, (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(null);
        return true;
      }
      if (e.key === 'Enter') {
        cleanup();
        resolve(primary.value);
        return true;
      }
      return false;
    });

    document.body.appendChild(overlay);
    armDialogFocus(dialog, 'dialog', opts.message);
  });
}

export interface RouteChoiceOption<T extends string> {
  /** What the returned promise resolves to when this button is picked. */
  value: T;
  /** Bold first line. */
  label: string;
  /** Optional second line beneath the label (mirrors the Save-dialog's
   *  "Write to the existing file, then close." style). */
  description?: string;
}

export interface RouteChoiceOptions<T extends string> {
  /** Title / question shown above the buttons. */
  message: string;
  /** Optional read-only body between the title and the buttons —
   *  for details too long for a button description (e.g. a list of
   *  what a destructive action will remove). Newlines are kept. */
  detail?: string;
  /** Buttons in display order, rendered as two-line `pmd-route-btn`s and
   *  numbered 1..N. Number keys 1-9 (no modifier) activate them; Enter picks
   *  the first; Esc / overlay-click / Cancel resolves to null. */
  choices: RouteChoiceOption<T>[];
  /** Label on the trailing cancel button. Defaults to 'Cancel'. */
  cancelLabel?: string;
  /** Abort → the dialog closes itself and resolves null, exactly like
   *  a cancel — for prompts whose question can become moot while open
   *  (the save watchdog's still-saving dialog when the write lands). */
  signal?: AbortSignal;
}

/** Modal choice dialog in the SAME visual vocabulary as the unsaved-changes
 *  Save / Don't save / Cancel prompt (`confirmCloseUnsaved`): two-line buttons
 *  with number-key (1/2/3) shortcuts. Use for confirmations that should read as
 *  part of that family (the co-editing start / close / end flows). Returns the
 *  chosen `value`, or null on cancel. */
export function promptForRouteChoice<T extends string>(
  opts: RouteChoiceOptions<T>,
): Promise<T | null> {
  return new Promise((resolve) => {
    const restoreFocus = captureFocusForDialog();
    const overlayToken = pushOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog';

    const header = document.createElement('div');
    header.className = 'pmd-route-header';
    header.textContent = opts.message;
    dialog.appendChild(header);

    if (opts.detail) {
      const detail = document.createElement('div');
      detail.className = 'pmd-choice-prompt-detail';
      detail.style.whiteSpace = 'pre-line'; // keep list line breaks
      detail.textContent = opts.detail;
      dialog.appendChild(detail);
    }

    const buttons = document.createElement('div');
    buttons.className = 'pmd-route-buttons';

    let settled = false;
    let removeKeys = (): void => {};
    let detachAbort = (): void => {};
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      popOverlay(overlayToken);
      overlay.remove();
      removeKeys();
      detachAbort();
      restoreFocus();
    };

    if (opts.signal) {
      const sig = opts.signal;
      const onAbort = (): void => {
        cleanup();
        resolve(null);
      };
      if (sig.aborted) {
        // Moot before it ever rendered — resolve like an instant cancel.
        onAbort();
        return;
      }
      sig.addEventListener('abort', onAbort, { once: true });
      detachAbort = () => sig.removeEventListener('abort', onAbort);
    }

    const pick = (value: T): void => {
      cleanup();
      resolve(value);
    };

    for (const choice of opts.choices) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pmd-route-btn';
      const strong = document.createElement('strong');
      strong.textContent = choice.label;
      btn.appendChild(strong);
      if (choice.description) {
        btn.appendChild(document.createElement('br'));
        const span = document.createElement('span');
        span.textContent = choice.description;
        btn.appendChild(span);
      }
      btn.addEventListener('click', () => pick(choice.value));
      buttons.appendChild(btn);
    }
    dialog.appendChild(buttons);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-route-cancel';
    cancel.textContent = opts.cancelLabel ?? 'Cancel';
    cancel.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });
    dialog.appendChild(cancel);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (isBackdropClick(e, overlay)) {
        cleanup();
        resolve(null);
      }
    });

    removeKeys = installModalKeys(dialog, overlayToken, (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(null);
        return true;
      }
      if (e.key === 'Enter') {
        // Enter picks the first choice, per the interface contract.
        pick(opts.choices[0]!.value);
        return true;
      }
      // Number keys mirror button order (1 = first). Skip when a modifier is
      // held so chords (e.g. Ctrl+1 slot focus) stay available.
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= opts.choices.length) {
        pick(opts.choices[n - 1]!.value);
        return true;
      }
      return false;
    });

    document.body.appendChild(overlay);
    armDialogFocus(dialog, 'dialog', opts.message);
  });
}

/** In-DOM replacement for `window.alert` — same dialog vocabulary as the
 *  prompts above (route overlay + accent OK button). Resolves when dismissed
 *  (OK, Enter, Esc, or overlay click) and restores focus to whatever had it.
 *
 *  NEVER call the native `window.alert`/`confirm` from renderer code:
 *  Electron's native dialogs on Windows/Linux don't hand keyboard focus back
 *  to the webContents on dismiss — the editor keeps its selection and takes
 *  mouse events but no keystrokes until a reload (field bugs 2026-07-03 and
 *  2026-07-11; renderer-side `.focus()` after the alert does NOT fix it). */
export function alertDialog(message: string, opts?: { title?: string }): Promise<void> {
  return new Promise((resolve) => {
    const restoreFocus = captureFocusForDialog();
    const overlayToken = pushOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog pmd-text-prompt-dialog';

    if (opts?.title) {
      const header = document.createElement('div');
      header.className = 'pmd-route-header';
      header.textContent = opts.title;
      dialog.appendChild(header);
    }
    // The body reuses the choice-detail block (bordered surface panel) so
    // multi-sentence messages read comfortably; with no title, style the
    // message as the header line instead.
    const body = document.createElement('div');
    body.className = opts?.title ? 'pmd-choice-prompt-detail' : 'pmd-route-header';
    body.textContent = message;
    dialog.appendChild(body);

    const buttons = document.createElement('div');
    buttons.className = 'pmd-text-prompt-buttons';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'pmd-text-prompt-ok';
    okBtn.textContent = 'OK';
    let settled = false;
    let removeKeys = (): void => {};
    const done = (): void => {
      if (settled) return;
      settled = true;
      popOverlay(overlayToken);
      overlay.remove();
      removeKeys();
      restoreFocus();
      resolve();
    };
    okBtn.addEventListener('click', done);
    buttons.appendChild(okBtn);
    dialog.appendChild(buttons);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (isBackdropClick(e, overlay)) done();
    });
    removeKeys = installModalKeys(dialog, overlayToken, (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        done();
        return true;
      }
      return false;
    });
    document.body.appendChild(overlay);
    armDialogFocus(dialog, 'alertdialog', opts?.title ?? message);
  });
}

/** In-DOM replacement for `window.confirm` (see alertDialog's warning about
 *  the native dialogs). Resolves true on OK / Enter, false on Cancel / Esc /
 *  overlay click. */
export function confirmDialog(
  message: string,
  opts?: { title?: string; okLabel?: string; cancelLabel?: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    const restoreFocus = captureFocusForDialog();
    const overlayToken = pushOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog pmd-text-prompt-dialog';

    if (opts?.title) {
      const header = document.createElement('div');
      header.className = 'pmd-route-header';
      header.textContent = opts.title;
      dialog.appendChild(header);
    }
    const body = document.createElement('div');
    body.className = opts?.title ? 'pmd-choice-prompt-detail' : 'pmd-route-header';
    body.style.whiteSpace = 'pre-line'; // multi-line bodies keep their breaks
    body.textContent = message;
    dialog.appendChild(body);

    const buttons = document.createElement('div');
    buttons.className = 'pmd-text-prompt-buttons';
    let settled = false;
    let removeKeys = (): void => {};
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      popOverlay(overlayToken);
      overlay.remove();
      removeKeys();
      restoreFocus();
      resolve(value);
    };
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'pmd-route-cancel';
    cancelBtn.textContent = opts?.cancelLabel ?? 'Cancel';
    cancelBtn.addEventListener('click', () => finish(false));
    buttons.appendChild(cancelBtn);
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'pmd-text-prompt-ok';
    okBtn.textContent = opts?.okLabel ?? 'OK';
    okBtn.addEventListener('click', () => finish(true));
    buttons.appendChild(okBtn);
    dialog.appendChild(buttons);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (isBackdropClick(e, overlay)) finish(false);
    });
    removeKeys = installModalKeys(dialog, overlayToken, (e) => {
      if (e.key === 'Escape') {
        finish(false);
        return true;
      }
      if (e.key === 'Enter') {
        finish(true);
        return true;
      }
      return false;
    });
    document.body.appendChild(overlay);
    armDialogFocus(dialog, 'alertdialog', opts?.title ?? message);
  });
}
