/**
 * The per-window Move / Snap ribbon commands: ids, labels, search
 * aliases, and the request each one sends the desktop host. Two sets:
 *
 *  - Move Window Left / Right / Up / Down — stateful, Win+Arrow style.
 *    What happens depends on where the window already is (main decides,
 *    see apps/desktop/src/window-placement.ts for the table).
 *  - Snap Window To … — stateless. Halves, corners, thirds, two-thirds,
 *    sixths, plus Maximize and Restore. Each puts the window in one
 *    fixed place whatever it was doing before.
 *
 * None of these has a ribbon button or a default key; they live in the
 * command palette, the keybindings editor, the shortcuts reference and
 * voice. Users add buttons through Settings → Custom ribbon buttons.
 * They act on the OS window in every mode — the three-pane workspace
 * included (slots have their own Mod-1/2/3 moves).
 *
 * The placement names here mirror `Placement` in the desktop module;
 * `tests/desktop/window-placement.test.ts` asserts the two agree, since
 * renderer code cannot import from apps/desktop.
 */

export type WindowPlacement =
  | 'left-half'
  | 'right-half'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'left-third'
  | 'middle-third'
  | 'right-third'
  | 'left-two-thirds'
  | 'right-two-thirds'
  | 'top-left-sixth'
  | 'top-middle-sixth'
  | 'top-right-sixth'
  | 'bottom-left-sixth'
  | 'bottom-middle-sixth'
  | 'bottom-right-sixth';

export type WindowMoveDirection = 'left' | 'right' | 'up' | 'down';

export type WindowPlaceRequest =
  | { kind: 'place'; action: WindowPlacement | 'maximize' | 'restore' }
  | { kind: 'move'; direction: WindowMoveDirection };

export type WindowPlaceCommandId =
  | 'moveWindowLeft'
  | 'moveWindowRight'
  | 'moveWindowUp'
  | 'moveWindowDown'
  | 'windowLeftHalf'
  | 'windowRightHalf'
  | 'windowTopLeft'
  | 'windowTopRight'
  | 'windowBottomLeft'
  | 'windowBottomRight'
  | 'windowLeftThird'
  | 'windowMiddleThird'
  | 'windowRightThird'
  | 'windowLeftTwoThirds'
  | 'windowRightTwoThirds'
  | 'windowTopLeftSixth'
  | 'windowTopMiddleSixth'
  | 'windowTopRightSixth'
  | 'windowBottomLeftSixth'
  | 'windowBottomMiddleSixth'
  | 'windowBottomRightSixth'
  | 'maximizeWindow'
  | 'restoreWindow';

interface WindowPlaceCommandSpec {
  label: string;
  aliases: readonly string[];
  request: WindowPlaceRequest;
}

const place = (action: WindowPlacement | 'maximize' | 'restore'): WindowPlaceRequest => ({ kind: 'place', action });
const move = (direction: WindowMoveDirection): WindowPlaceRequest => ({ kind: 'move', direction });

/** Declaration order is the order the shortcuts reference and the
 *  keybindings editor list them: the four moves, then the snaps from
 *  coarse to fine, then the two window-state verbs. */
export const WINDOW_PLACE_COMMANDS: Record<WindowPlaceCommandId, WindowPlaceCommandSpec> = {
  moveWindowLeft: {
    label: 'Move Window Left',
    aliases: ['snap left', 'window left', 'win left', 'tile left', 'move left'],
    request: move('left'),
  },
  moveWindowRight: {
    label: 'Move Window Right',
    aliases: ['snap right', 'window right', 'win right', 'tile right', 'move right'],
    request: move('right'),
  },
  moveWindowUp: {
    label: 'Move Window Up',
    aliases: ['snap up', 'window up', 'win up', 'tile up', 'move up'],
    request: move('up'),
  },
  moveWindowDown: {
    label: 'Move Window Down',
    aliases: ['snap down', 'window down', 'win down', 'tile down', 'move down'],
    request: move('down'),
  },
  windowLeftHalf: {
    label: 'Window: Left Half',
    aliases: ['snap window', 'left half', 'half left', 'tile window'],
    request: place('left-half'),
  },
  windowRightHalf: {
    label: 'Window: Right Half',
    aliases: ['snap window', 'right half', 'half right', 'tile window'],
    request: place('right-half'),
  },
  windowTopLeft: {
    label: 'Window: Top Left Corner',
    aliases: ['snap window', 'top left', 'corner', 'quarter', 'upper left'],
    request: place('top-left'),
  },
  windowTopRight: {
    label: 'Window: Top Right Corner',
    aliases: ['snap window', 'top right', 'corner', 'quarter', 'upper right'],
    request: place('top-right'),
  },
  windowBottomLeft: {
    label: 'Window: Bottom Left Corner',
    aliases: ['snap window', 'bottom left', 'corner', 'quarter', 'lower left'],
    request: place('bottom-left'),
  },
  windowBottomRight: {
    label: 'Window: Bottom Right Corner',
    aliases: ['snap window', 'bottom right', 'corner', 'quarter', 'lower right'],
    request: place('bottom-right'),
  },
  windowLeftThird: {
    label: 'Window: Left Third',
    aliases: ['snap window', 'left third', 'third', 'thirds'],
    request: place('left-third'),
  },
  windowMiddleThird: {
    label: 'Window: Middle Third',
    aliases: ['snap window', 'middle third', 'center third', 'centre third', 'third', 'thirds'],
    request: place('middle-third'),
  },
  windowRightThird: {
    label: 'Window: Right Third',
    aliases: ['snap window', 'right third', 'third', 'thirds'],
    request: place('right-third'),
  },
  windowLeftTwoThirds: {
    label: 'Window: Left Two Thirds',
    aliases: ['snap window', 'left two thirds', 'two thirds', 'thirds'],
    request: place('left-two-thirds'),
  },
  windowRightTwoThirds: {
    label: 'Window: Right Two Thirds',
    aliases: ['snap window', 'right two thirds', 'two thirds', 'thirds'],
    request: place('right-two-thirds'),
  },
  windowTopLeftSixth: {
    label: 'Window: Top Left Sixth',
    aliases: ['snap window', 'top left sixth', 'sixth', 'sixths'],
    request: place('top-left-sixth'),
  },
  windowTopMiddleSixth: {
    label: 'Window: Top Middle Sixth',
    aliases: ['snap window', 'top middle sixth', 'top center sixth', 'sixth', 'sixths'],
    request: place('top-middle-sixth'),
  },
  windowTopRightSixth: {
    label: 'Window: Top Right Sixth',
    aliases: ['snap window', 'top right sixth', 'sixth', 'sixths'],
    request: place('top-right-sixth'),
  },
  windowBottomLeftSixth: {
    label: 'Window: Bottom Left Sixth',
    aliases: ['snap window', 'bottom left sixth', 'sixth', 'sixths'],
    request: place('bottom-left-sixth'),
  },
  windowBottomMiddleSixth: {
    label: 'Window: Bottom Middle Sixth',
    aliases: ['snap window', 'bottom middle sixth', 'bottom center sixth', 'sixth', 'sixths'],
    request: place('bottom-middle-sixth'),
  },
  windowBottomRightSixth: {
    label: 'Window: Bottom Right Sixth',
    aliases: ['snap window', 'bottom right sixth', 'sixth', 'sixths'],
    request: place('bottom-right-sixth'),
  },
  maximizeWindow: {
    label: 'Maximize Window',
    aliases: ['maximize', 'maximise', 'full size', 'zoom window', 'fill screen'],
    request: place('maximize'),
  },
  restoreWindow: {
    label: 'Restore Window Size',
    aliases: ['restore', 'unmaximize', 'unsnap', 'un-snap', 'previous size', 'free window'],
    request: place('restore'),
  },
};

export const WINDOW_PLACE_COMMAND_IDS = Object.keys(WINDOW_PLACE_COMMANDS) as WindowPlaceCommandId[];

export function isWindowPlaceCommandId(id: string): id is WindowPlaceCommandId {
  return Object.prototype.hasOwnProperty.call(WINDOW_PLACE_COMMANDS, id);
}

export const WINDOW_PLACE_LABELS: Record<WindowPlaceCommandId, string> = Object.fromEntries(
  WINDOW_PLACE_COMMAND_IDS.map((id) => [id, WINDOW_PLACE_COMMANDS[id].label]),
) as Record<WindowPlaceCommandId, string>;

export const WINDOW_PLACE_ALIASES: Record<WindowPlaceCommandId, readonly string[]> = Object.fromEntries(
  WINDOW_PLACE_COMMAND_IDS.map((id) => [id, WINDOW_PLACE_COMMANDS[id].aliases]),
) as Record<WindowPlaceCommandId, readonly string[]>;

/** All unbound by default, like Arrange Windows. */
export const WINDOW_PLACE_DEFAULT_KEYS: Record<WindowPlaceCommandId, string> = Object.fromEntries(
  WINDOW_PLACE_COMMAND_IDS.map((id) => [id, '']),
) as Record<WindowPlaceCommandId, string>;
