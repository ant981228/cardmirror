/**
 * One-time offer (macOS desktop): bind Move Window Left / Right / Up /
 * Down to ⌘ + the matching arrow key.
 *
 * The Move Window commands ship unbound everywhere. Windows and Linux
 * already have Win/Super + arrow window management, so nothing is
 * offered there. macOS has no equivalent, and ⌘ + arrows is the natural
 * fit — but those keys move the caret to the start/end of the line or
 * document, which people rely on, so taking them is the user's call.
 * This asks once, the first time a build with the commands runs.
 *
 * Sequencing: a fresh profile that is about to get the UI tour is asked
 * when the tour ends (Done, Skip or Esc), never on top of it. Everyone
 * else is asked once the app is ready and no other modal is open.
 *
 * The offer is skipped — and recorded as seen, so it never comes back —
 * when the user has already touched any of the four commands' bindings
 * or bound any of the four keys to something else: they have made their
 * own choice and a prompt would only second-guess it.
 */

import { settings } from './settings.js';
import { ribbonCommandForKey } from './ribbon-commands.js';
import { isAnyOverlayOpen } from './overlay-stack.js';
import { getElectronHost, isMacHost } from './host/index.js';

type Overrides = Partial<Record<string, string | string[]>>;

/** The proposed bindings, in the order the dialog describes them. */
export const WINDOW_MOVE_KEYS = {
  moveWindowLeft: 'Mod-ArrowLeft',
  moveWindowRight: 'Mod-ArrowRight',
  moveWindowUp: 'Mod-ArrowUp',
  moveWindowDown: 'Mod-ArrowDown',
} as const;

export type WindowKeysOfferDecision =
  /** Show the dialog. */
  | 'ask'
  /** Nothing to do this session; leave the flag alone. */
  | 'skip'
  /** Moot for this profile — record as seen without asking. */
  | 'mark-seen';

/** Pure policy: should this profile be asked? */
export function windowKeysOfferDecision(input: {
  seen: boolean;
  isMacDesktop: boolean;
  overrides: Overrides;
}): WindowKeysOfferDecision {
  if (input.seen) return 'skip';
  // Not a Mac desktop: leave the flag unset. Settings are per-device,
  // and the flag only ever gates the Mac prompt.
  if (!input.isMacDesktop) return 'skip';
  const ids = Object.keys(WINDOW_MOVE_KEYS);
  if (ids.some((id) => id in input.overrides)) return 'mark-seen';
  const taken = Object.values(WINDOW_MOVE_KEYS).some(
    (key) => ribbonCommandForKey(key, input.overrides) !== null,
  );
  return taken ? 'mark-seen' : 'ask';
}

/** The override map with the four Move Window bindings added. */
export function withWindowMoveKeys(overrides: Overrides): Overrides {
  return { ...overrides, ...WINDOW_MOVE_KEYS };
}

export type WindowKeysChoice = 'bind' | 'leave';

/** The dialog itself: an ordinary small prompt. Resolves 'bind',
 *  'leave', or null for "ask me next time" (Esc, overlay click, or
 *  the trailing button). Enter takes the bind option. */
export async function promptWindowKeys(): Promise<WindowKeysChoice | null> {
  const { promptForChoice } = await import('./text-prompt.js');
  return promptForChoice<WindowKeysChoice>({
    message: 'Move this window with ⌘ and the arrow keys?',
    detail:
      'CardMirror can snap its window to halves, corners and full size with Move Window Left, Right, Up and Down. ' +
      'Binding them to ⌘← ⌘→ ⌘↑ ⌘↓ will prevent you from using those key combinations to jump the cursor to the start or end of the line or document.\n\n' +
      'You can change this at any time in Settings → Keyboard shortcuts.',
    detailInline: true,
    choices: [
      { value: 'leave', label: 'Leave unbound' },
      { value: 'bind', label: 'Use ⌘ + arrows (Recommended)', primary: true },
    ],
    cancelLabel: 'Ask me next time',
  });
}

export interface WindowKeysOfferDeps {
  isMacDesktop: () => boolean;
  prompt: () => Promise<WindowKeysChoice | null>;
}

const defaultDeps: WindowKeysOfferDeps = {
  isMacDesktop: isMacHost,
  prompt: promptWindowKeys,
};

let asking = false;

/** Decide, ask if needed, and apply the answer. Returns what happened,
 *  for tests. Safe to call more than once: a second call while the
 *  dialog is up, or after it was answered, does nothing. */
export async function runWindowKeysOffer(
  deps: WindowKeysOfferDeps = defaultDeps,
  force = false,
): Promise<'bound' | 'left' | 'deferred' | 'not-asked'> {
  if (asking) return 'not-asked';
  const decision = force
    ? 'ask'
    : windowKeysOfferDecision({
        seen: settings.get('hasSeenWindowKeysOffer'),
        isMacDesktop: deps.isMacDesktop(),
        overrides: settings.get('ribbonKeyOverrides'),
      });
  if (decision === 'skip') return 'not-asked';
  if (decision === 'mark-seen') {
    settings.set('hasSeenWindowKeysOffer', true);
    return 'not-asked';
  }
  asking = true;
  // Recorded before the dialog opens, not after: settings sync across
  // windows, so a second CardMirror window starting at the same moment
  // sees the flag and stays quiet instead of asking the same question.
  settings.set('hasSeenWindowKeysOffer', true);
  try {
    const choice = await deps.prompt();
    if (choice === 'bind') {
      settings.set('ribbonKeyOverrides', withWindowMoveKeys(settings.get('ribbonKeyOverrides')));
      return 'bound';
    }
    if (choice === 'leave') return 'left';
    // "Ask me next time": put the flag back so the next launch asks.
    settings.set('hasSeenWindowKeysOffer', false);
    return 'deferred';
  } finally {
    asking = false;
  }
}

/** Whether the app has something on screen to ask over: the editor
 *  chrome or the home screen. */
function appReady(): boolean {
  return (
    document.documentElement.classList.contains('pmd-home-active') ||
    (document.querySelector('.ProseMirror') !== null &&
      document.getElementById('formatting-panel') !== null)
  );
}

/** Ask at the first calm moment: app ready, this window focused, no
 *  other modal open. Gives up quietly after two minutes — the flag
 *  stays unset, so the next launch tries again. */
function askWhenCalm(deps: WindowKeysOfferDeps, force = false): void {
  let tries = 0;
  const poll = window.setInterval(() => {
    tries++;
    if ((!force && settings.get('hasSeenWindowKeysOffer')) || tries > 240) {
      window.clearInterval(poll);
      return;
    }
    if (!appReady() || !document.hasFocus() || isAnyOverlayOpen()) return;
    window.clearInterval(poll);
    void runWindowKeysOffer(deps, force);
  }, 500);
}

/** Dev aid, dev server only: start it with
 *  `VITE_CM_FORCE_WINDOW_KEYS_OFFER=1` to show the dialog on every
 *  launch regardless of the seen flag or existing bindings — for
 *  looking at the dialog, which a real profile shows exactly once.
 *  Compiled out of production builds (`import.meta.env.DEV`). */
function forcedForDev(): boolean {
  const env = (import.meta as { env?: Record<string, unknown> }).env;
  return env?.DEV === true && Boolean(env.VITE_CM_FORCE_WINDOW_KEYS_OFFER);
}

/** Entry point, called once at startup (desktop layout only).
 *  `afterTour` is the tour's end hook when a tour is about to run for
 *  this profile; null when it is not. */
export function scheduleWindowKeysOffer(
  afterTour: ((cb: () => void) => unknown) | null,
  deps: WindowKeysOfferDeps = defaultDeps,
): void {
  if (deps === defaultDeps && forcedForDev() && getElectronHost() !== null) {
    if (afterTour) afterTour(() => window.setTimeout(() => askWhenCalm(deps, true), 350));
    else askWhenCalm(deps, true);
    return;
  }
  // Cheap exit before any polling: web, Windows, Linux, or already seen.
  if (getElectronHost() === null && deps === defaultDeps) return;
  if (!deps.isMacDesktop() || settings.get('hasSeenWindowKeysOffer')) return;
  if (afterTour) {
    // The tour's last card closing and this dialog opening in the same
    // frame reads as a glitch; a short beat separates them.
    afterTour(() => window.setTimeout(() => askWhenCalm(deps), 350));
  } else {
    askWhenCalm(deps);
  }
}
