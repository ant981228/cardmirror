/**
 * Shared thematic grouping of `RibbonCommandId`s — single source of
 * truth for both the Keyboard Shortcuts reference modal
 * (`reference-ui.ts`) and the Settings → Keybindings editor
 * (`keybindings-editor.ts`), so users see the same taxonomy in both.
 *
 * Every `RibbonCommandId` must appear in exactly one group; the
 * module-load assertion at the bottom enforces this.
 */

import { RIBBON_COMMAND_IDS, type RibbonCommandId } from './ribbon-commands.js';

export interface RibbonGroup {
  title: string;
  commands: RibbonCommandId[];
}

export const RIBBON_GROUPS: RibbonGroup[] = [
  {
    title: 'File',
    commands: ['newDocument', 'openFile', 'save', 'saveAs', 'saveSendDoc', 'saveMarkedCards', 'toggleAutosave', 'openContainingFolder', 'goHome'],
  },
  {
    title: 'Speech',
    commands: [
      'newSpeechDocument',
      'markActiveAsSpeech',
      'sendToSpeechAtCursor',
      'sendToSpeechAtEnd',
      'selectSpeechDoc',
    ],
  },
  {
    title: 'Dropzone / Send and Receive Cards',
    commands: [
      'sendToDropzone',
      'sendToStarred',
      'sendToRecipient',
      'insertReceivedAtCursor',
      'insertReceivedAtEnd',
    ],
  },
  {
    title: 'Collaboration',
    commands: [
      'collabStartSession',
      'collabJoinSession',
      'collabCopyShareCode',
      'collabCopyInviteLink',
      'collabInviteStarred',
      'collabEndSession',
      'recoverPreviousVersion',
    ],
  },
  {
    title: 'Quick Cards',
    commands: ['addQuickCard', 'manageQuickCards'],
  },
  {
    title: 'Structural styles',
    commands: ['setPocket', 'setHat', 'setBlock', 'setTag', 'setAnalytic', 'setUndertag'],
  },
  {
    title: 'Numbering',
    commands: ['toggleNumberRole', 'toggleSubRole', 'toggleNumRestart'],
  },
  {
    title: 'Character styles',
    commands: [
      'applyCite',
      'applyUnderline',
      'toggleUnderlineTyping',
      'applyEmphasis',
      'emphasizeAcronym',
      'applyHighlight',
      'highlightAcronym',
      'underlineAcronym',
      'applyShading',
      'applyFontColor',
    ],
  },
  {
    title: 'Inline formatting',
    commands: [
      'toggleBold',
      'toggleItalic',
      'toggleStrikethrough',
      'toggleSuperscript',
      'toggleSubscript',
      'adjustFontSizeUp',
      'adjustFontSizeDown',
    ],
  },
  {
    title: 'Condense',
    commands: [
      'condenseDefault',
      'condenseNoIntegrity',
      'condenseNoIntegrityWithPilcrows',
      'condenseWithWarning',
      'uncondense',
      'toggleCase',
      'toggleParagraphIntegrity',
    ],
  },
  {
    title: 'Editing utilities',
    commands: [
      'pasteAsText',
      'pasteCondensed',
      'clearToNormal',
      'shrink',
      'smartShrink',
      'regrow',
      'copyPreviousCite',
      'convertCardsToReadMode',
      'createReference',
      'extractUndertag',
      'insertImage',
      'insertFootnote',
      'insertLiveZone',
      'insertSelfLiveZone',
      'insertInDocCopy',
      'refreshLiveZone',
      'refreshAllLiveZones',
      'checkLiveZoneSources',
      'detachLiveZone',
      'selectCurrentHeading',
      'deleteCurrentHeading',
      'copyCurrentHeading',
      'moveContainerUp',
      'moveContainerDown',
      'flipQuoteDirection',
    ],
  },
  {
    title: 'Highlight tools',
    commands: [
      'standardizeHighlight',
      'standardizeShading',
      'standardizeHighlightExcept',
      'standardizeShadingExcept',
      'highlightToShading',
      'shadingToHighlight',
      'lockHighlighting',
      'togglePaintbrushHighlight',
      'togglePaintbrushShading',
    ],
  },
  {
    title: 'Color pickers & menus',
    commands: [
      'openHighlightPicker',
      'openShadingPicker',
      'openFontColorPicker',
      'openFontSizePicker',
      'openDocToolsMenu',
      'openCardToolsMenu',
      'openTableMenu',
    ],
  },
  {
    title: 'Find',
    commands: ['openFind', 'openFindReplace', 'openFindByProximity'],
  },
  {
    // The command palette searches everything — cards, dropzone,
    // commands, settings, and files — so it lives in its own group
    // rather than under Quick Cards.
    title: 'Search',
    commands: ['openQuickCardSearch'],
  },
  {
    title: 'View',
    commands: [
      'toggleReadMode',
      'toggleReaderView',
      'toggleNavPane',
      'toggleMorphMode',
      'wordCountSelection',
      'openSettings',
      'cycleTheme',
      'minimizeWindow',
      'openShortcutsReference',
      'startUiTour',
    ],
  },
  {
    title: 'Timer',
    commands: [
      'timerToggleVisible',
      'timerStartPause',
      'timerPreset1',
      'timerPreset2',
      'timerPreset3',
      'timerStartAffPrep',
      'timerStartNegPrep',
      'timerReset',
      'cycleTimerPreset',
    ],
  },
  {
    title: 'Zoom & scale',
    commands: [
      'zoomIn',
      'zoomOut',
      'zoomReset',
      'chromeScaleUp',
      'chromeScaleDown',
      'chromeScaleReset',
    ],
  },
  {
    title: 'Diagnostics',
    commands: ['openDevConsole', 'openJournalsFolder'],
  },
  {
    title: 'Comments',
    commands: ['toggleCommentsVisible', 'addCommentToSelection', 'addNoteToSelection'],
  },
  {
    title: 'Multi-pane workspace',
    commands: [
      'focusSlot1',
      'focusSlot2',
      'focusSlot3',
      'sendDocToSlot1',
      'sendDocToSlot2',
      'sendDocToSlot3',
      'toggleSlotExpand',
      'cycleDocNext',
      'cycleDocPrev',
      'closeDocOrWindow',
    ],
  },
  {
    title: 'AI',
    commands: [
      'aiAskAboutSelection',
      'aiCreateCite',
      'reformatAllCites',
      'translate',
      'repairText',
      'repairFormatting',
    ],
  },
  {
    title: 'Flow',
    commands: [
      'sendToFlowColumn',
      'sendToFlowCell',
      'sendHeadingsToFlowColumn',
      'sendHeadingsToFlowCell',
      'pullFromFlow',
      'createFlow',
      'startFlowHost',
    ],
  },
  {
    title: 'Voice',
    commands: ['toggleVoice'],
  },
  {
    title: 'Card cutter',
    commands: ['openCardCutter', 'addCutterContext', 'openCutterGuidance'],
  },
  {
    title: 'Reading',
    commands: ['toggleReadingMarker'],
  },
  {
    title: 'Learn',
    commands: ['createFlashcard', 'manageFlashcards'],
  },
  {
    title: 'Select',
    commands: ['selectSimilar'],
  },
  {
    title: 'Cleanup',
    commands: [
      'convertAnalyticsToTags',
      'convertCitedAnalyticsToTags',
      'fixFormattingGaps',
      'repairParagraphIntegrity',
      'removeHyperlinks',
    ],
  },
  {
    title: 'Table',
    commands: [
      'insertTable',
      'addRowBefore',
      'addRowAfter',
      'addColumnBefore',
      'addColumnAfter',
      'deleteTableRow',
      'deleteTableColumn',
      'mergeTableCells',
      'splitTableCell',
      'deleteTable',
    ],
  },
];

// Drift guard: throws at module load when a registry command is
// uncategorized, duplicated, or unknown — fail loud instead of
// silently dropping rows from the cheat sheet and rebinding editor.
(function assertGroupsCoverRegistry(): void {
  const placed = new Set<string>();
  const duplicates: string[] = [];
  for (const group of RIBBON_GROUPS) {
    for (const id of group.commands) {
      if (placed.has(id)) duplicates.push(id);
      placed.add(id);
    }
  }
  const missing = RIBBON_COMMAND_IDS.filter((id) => !placed.has(id));
  const extra = [...placed].filter(
    (id) => !(RIBBON_COMMAND_IDS as readonly string[]).includes(id),
  );
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`missing from RIBBON_GROUPS: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    problems.push(`in RIBBON_GROUPS but not in RIBBON_COMMAND_IDS: ${extra.join(', ')}`);
  }
  if (duplicates.length > 0) {
    problems.push(`appear in multiple groups: ${duplicates.join(', ')}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `ribbon-groups RIBBON_GROUPS / RIBBON_COMMAND_IDS mismatch:\n  - ${problems.join('\n  - ')}`,
    );
  }
})();
