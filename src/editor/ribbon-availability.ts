/**
 * Ribbon-command availability.
 *
 * Some commands only make sense in certain contexts and should be hidden
 * from the command-discovery surfaces (the search-palette command bar, the
 * keybindings editor, and the printed shortcuts reference) when they don't
 * apply:
 *
 *   - Verbatim Flow commands work only on the Windows desktop (the COM
 *     bridge is Windows-only); off Windows they'd toast "Windows-only".
 *   - Voice control is desktop-only.
 *   - The opt-in card-cutter command stays invisible until the experiment
 *     is enabled.
 *
 * This gates *visibility* only. The keymap still binds every command — the
 * commands themselves self-guard (Flow toasts, the cutter command falls
 * through when off), so a stale user override never does harm. Conflict
 * detection in the keybindings editor likewise scans the full id set, not
 * this filtered one, so a hidden command's binding still blocks reuse.
 */

import { RIBBON_COMMAND_IDS, type AnyCommandId, type RibbonCommandId } from './ribbon-commands.js';
import { pluginCommandIds } from './plugin-registry.js';
import { settings } from './settings.js';
import { collabEnabled } from './collab/collab-gate.js';
import { researchBrowserEnabled } from './research-browser-gate.js';
import { getElectronHost, isWindowsHost } from './host/index.js';

const FLOW_COMMANDS = new Set<RibbonCommandId>([
  'sendToFlowColumn',
  'sendToFlowCell',
  'sendHeadingsToFlowColumn',
  'sendHeadingsToFlowCell',
  'pullFromFlow',
  'createFlow',
  'startFlowHost',
]);

/** Whether a command should be offered in the discovery surfaces now. */
const COLLAB_COMMANDS = new Set<RibbonCommandId>([
  'collabStartSession',
  'collabJoinSession',
  'collabCopyShareCode',
  'collabInviteStarred',
  'collabEndSession',
]);

export function isRibbonCommandAvailable(id: RibbonCommandId): boolean {
  if (FLOW_COMMANDS.has(id)) return isWindowsHost();
  if (id === 'toggleVoice') return getElectronHost() !== null;
  // The dev console is Chromium DevTools via the Electron host; on the
  // web the browser's own DevTools exist and we can't open them anyway.
  if (id === 'openDevConsole') return getElectronHost() !== null;
  // Reads the clipboard — Electron host IPC OR the browser's async Clipboard
  // API (Chromium). The command self-guards and falls through where no read is
  // available (e.g. Firefox/Safari), so hide it only where neither exists.
  if (id === 'pasteCondensed') {
    return (
      getElectronHost() !== null ||
      (typeof navigator !== 'undefined' && !!navigator.clipboard?.readText)
    );
  }
  if (id === 'openCardCutter') return settings.get('cardCutterEnabled') === true;
  // Browsers can't minimize their own window — desktop only.
  if (id === 'minimizeWindow') return getElectronHost() !== null;
  if (id === 'openJournalsFolder') return getElectronHost() !== null;
  // Creating/refreshing a live zone reads other files from disk — desktop only.
  // Detach works on an already-cached zone, so it stays available everywhere.
  if (
    id === 'insertLiveZone' ||
    id === 'refreshLiveZone' ||
    id === 'refreshAllLiveZones' ||
    id === 'checkLiveZoneSources'
  ) {
    return getElectronHost() !== null;
  }
  // Intra-doc live windows work entirely within the open doc (no disk), so
  // they're available everywhere (not desktop-gated).
  if (COLLAB_COMMANDS.has(id)) return collabEnabled();
  // Embeds a native WebContentsView — desktop only.
  if (id === 'toggleResearchBrowser') return researchBrowserEnabled();
  return true;
}

/** The currently-available command ids, in registry order. Plugin
 *  commands (registered = enabled) append after the static set. */
export function availableRibbonCommandIds(): AnyCommandId[] {
  return [...RIBBON_COMMAND_IDS.filter(isRibbonCommandAvailable), ...pluginCommandIds()];
}
