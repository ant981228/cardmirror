/**
 * Easter-egg configurator dialog reached by shift+right-clicking
 * the "Enable Clod mode" checkbox in Settings.
 *
 * Tabs: Persona (name + pronouns), one per time period
 * (Morning / Day / Evening / Night) for editing the activity pool,
 * and "Time periods" for the hour boundaries that decide which pool
 * is active. Saves go through the standard settings store.
 */

import { settings } from '../settings.js';
import { setIcon } from '../icons';
import { pushOverlay, popOverlay } from '../overlay-stack.js';
import { installModalKeys, armDialogFocus, captureFocusForDialog } from '../text-prompt.js';
import {
  CLOD_ACTIVITIES_BY_TIME,
  DEFAULT_CLOD_TIME_PERIODS,
  PRONOUN_PRESETS,
  type ClodTimePeriod,
} from './clod.js';

type PronounChoice = 'he' | 'she' | 'they' | 'it' | 'custom';

const PERIODS: ClodTimePeriod[] = ['morning', 'day', 'evening', 'night'];

export function openClodConfigurator(): void {
  // Pre-existing dialog? Bail to avoid stacking.
  if (document.querySelector('.pmd-clod-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'pmd-clod-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  const dialog = document.createElement('div');
  dialog.className = 'pmd-clod-dialog';
  overlay.appendChild(dialog);
  // Register on the overlay stack and own the keyboard while open. The
  // Settings dialog underneath runs installModalKeys too, which swallows
  // every keystroke not aimed at ITS controls while it is the top overlay
  // — without this registration it stayed on top and ate all typing into
  // these fields (field report 2026-09-05; broken since the modal-key
  // sweep of 2026-07-27). Stacked, it stands down by itself.
  const overlayToken = pushOverlay();
  const restoreFocus = captureFocusForDialog();
  let removeKeys: (() => void) | null = null;

  // Header
  const header = document.createElement('header');
  header.className = 'pmd-clod-header';
  const title = document.createElement('h2');
  title.textContent = 'Customize Clod';
  header.appendChild(title);
  const close = (): void => {
    removeKeys?.();
    removeKeys = null;
    popOverlay(overlayToken);
    overlay.remove();
    restoreFocus();
  };
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pmd-clod-close';
  setIcon(closeBtn, 'close');
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', close);
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  // Tab bar
  const tabs = document.createElement('div');
  tabs.className = 'pmd-clod-tabs';
  const body = document.createElement('div');
  body.className = 'pmd-clod-body';
  dialog.appendChild(tabs);
  dialog.appendChild(body);

  const initialActivities = settings.get('clodActivitiesByTime');
  const initialRanges = settings.get('clodTimePeriods');
  const draftActivities = {
    morning: [...(initialActivities.morning ?? [])],
    day: [...(initialActivities.day ?? [])],
    evening: [...(initialActivities.evening ?? [])],
    night: [...(initialActivities.night ?? [])],
  };
  const draftRanges = {
    morning: { ...initialRanges.morning },
    day: { ...initialRanges.day },
    evening: { ...initialRanges.evening },
    night: { ...initialRanges.night },
  };
  const draftPersona = {
    name: settings.get('aiPersonaName'),
    pronounChoice: settings.get('aiPersonaPronouns') as PronounChoice,
    custom: { ...settings.get('aiPersonaCustomPronouns') },
  };

  type Panel = HTMLElement;
  const panels = new Map<string, Panel>();
  const tabButtons = new Map<string, HTMLButtonElement>();

  function activate(name: string): void {
    for (const [k, p] of panels) p.hidden = k !== name;
    for (const [k, btn] of tabButtons) {
      btn.classList.toggle('pmd-clod-tab-active', k === name);
    }
  }

  function addTab(name: string, label: string, panel: HTMLElement): void {
    panels.set(name, panel);
    body.appendChild(panel);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-clod-tab';
    btn.textContent = label;
    btn.addEventListener('click', () => activate(name));
    tabButtons.set(name, btn);
    tabs.appendChild(btn);
  }

  // Persona tab first — name + pronoun set. Drives the AI
  // commenter's display name, the activity templating, and the
  // tooltips throughout the editor.
  const personaPanel = document.createElement('div');
  personaPanel.className = 'pmd-clod-panel';
  const nameRow = document.createElement('label');
  nameRow.className = 'pmd-clod-name-row';
  const nameLabel = document.createElement('span');
  nameLabel.textContent = 'Name';
  nameRow.appendChild(nameLabel);
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'pmd-clod-name-input';
  nameInput.value = draftPersona.name;
  nameInput.spellcheck = false;
  nameInput.autocomplete = 'off';
  nameInput.addEventListener('change', () => {
    const v = nameInput.value.trim();
    draftPersona.name = v || 'Clod';
    if (!v) nameInput.value = 'Clod';
  });
  nameRow.appendChild(nameInput);
  personaPanel.appendChild(nameRow);

  const pronounLabel = document.createElement('div');
  pronounLabel.className = 'pmd-clod-pronoun-heading';
  pronounLabel.textContent = 'Pronouns';
  personaPanel.appendChild(pronounLabel);

  const customRow = document.createElement('div');
  customRow.className = 'pmd-clod-pronoun-custom';
  customRow.hidden = draftPersona.pronounChoice !== 'custom';
  const customFields: Record<'subject' | 'object' | 'possessive' | 'reflexive', HTMLInputElement> = {
    subject: makeCustomField('subject', draftPersona.custom.subject, (v) => { draftPersona.custom.subject = v; }),
    object: makeCustomField('object', draftPersona.custom.object, (v) => { draftPersona.custom.object = v; }),
    possessive: makeCustomField('possessive', draftPersona.custom.possessive, (v) => { draftPersona.custom.possessive = v; }),
    reflexive: makeCustomField('reflexive', draftPersona.custom.reflexive, (v) => { draftPersona.custom.reflexive = v; }),
  };
  for (const f of Object.values(customFields)) customRow.appendChild(f.parentElement!);

  const pronounOptions: { id: PronounChoice; label: string; example: string }[] = [
    { id: 'he', label: 'he / him', example: 'his / himself' },
    { id: 'she', label: 'she / her', example: 'her / herself' },
    { id: 'they', label: 'they / them', example: 'their / themself' },
    { id: 'it', label: 'it / it', example: 'its / itself' },
    { id: 'custom', label: 'Custom…', example: '' },
  ];
  for (const opt of pronounOptions) {
    const row = document.createElement('label');
    row.className = 'pmd-clod-pronoun-row';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'pmd-clod-pronoun';
    radio.value = opt.id;
    radio.checked = draftPersona.pronounChoice === opt.id;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      draftPersona.pronounChoice = opt.id;
      customRow.hidden = opt.id !== 'custom';
    });
    row.appendChild(radio);
    const txt = document.createElement('span');
    txt.textContent = opt.example ? `${opt.label} (${opt.example})` : opt.label;
    row.appendChild(txt);
    personaPanel.appendChild(row);
  }
  personaPanel.appendChild(customRow);

  personaPanel.hidden = true;
  addTab('persona', 'Persona', personaPanel);

  // One tab per time period — text area with newline-separated activities.
  for (const period of PERIODS) {
    const panel = document.createElement('div');
    panel.className = 'pmd-clod-panel';
    const r = draftRanges[period];
    const note = document.createElement('p');
    note.className = 'pmd-clod-note';
    note.textContent =
      `${capitalize(period)} (${formatHour(r.start)}–${formatHour(r.end)}). ` +
      'One activity per line. Leave empty to use the built-in defaults.';
    panel.appendChild(note);

    const ta = document.createElement('textarea');
    ta.className = 'pmd-clod-textarea';
    ta.rows = 14;
    const pool = draftActivities[period];
    ta.value =
      pool.length > 0 ? pool.join('\n') : (CLOD_ACTIVITIES_BY_TIME[period] as readonly string[]).join('\n');
    ta.addEventListener('input', () => {
      draftActivities[period] = ta.value
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    });
    panel.appendChild(ta);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'pmd-clod-reset';
    resetBtn.textContent = 'Reset to defaults';
    resetBtn.addEventListener('click', () => {
      draftActivities[period] = [];
      ta.value = (CLOD_ACTIVITIES_BY_TIME[period] as readonly string[]).join('\n');
    });
    panel.appendChild(resetBtn);

    panel.hidden = true;
    addTab(period, capitalize(period), panel);
  }

  // Time-periods tab — start/end hour spinners.
  const periodsPanel = document.createElement('div');
  periodsPanel.className = 'pmd-clod-panel';
  const periodsNote = document.createElement('p');
  periodsNote.className = 'pmd-clod-note';
  periodsNote.textContent =
    'Configure when each time period starts and ends (0–23). Night may cross midnight (start > end).';
  periodsPanel.appendChild(periodsNote);
  const grid = document.createElement('div');
  grid.className = 'pmd-clod-grid';
  for (const period of PERIODS) {
    const label = document.createElement('span');
    label.className = 'pmd-clod-grid-label';
    label.textContent = capitalize(period);
    grid.appendChild(label);

    const startInput = makeHourInput(draftRanges[period].start, (v) => {
      draftRanges[period].start = v;
    });
    grid.appendChild(startInput);

    const endInput = makeHourInput(draftRanges[period].end, (v) => {
      draftRanges[period].end = v;
    });
    grid.appendChild(endInput);
  }
  periodsPanel.appendChild(grid);

  const resetRangesBtn = document.createElement('button');
  resetRangesBtn.type = 'button';
  resetRangesBtn.className = 'pmd-clod-reset';
  resetRangesBtn.textContent = 'Reset time periods to defaults';
  resetRangesBtn.addEventListener('click', () => {
    for (const p of PERIODS) {
      draftRanges[p] = { ...DEFAULT_CLOD_TIME_PERIODS[p] };
    }
    // Refresh the grid in place.
    grid.replaceChildren();
    for (const period of PERIODS) {
      const label = document.createElement('span');
      label.className = 'pmd-clod-grid-label';
      label.textContent = capitalize(period);
      grid.appendChild(label);
      grid.appendChild(makeHourInput(draftRanges[period].start, (v) => {
        draftRanges[period].start = v;
      }));
      grid.appendChild(makeHourInput(draftRanges[period].end, (v) => {
        draftRanges[period].end = v;
      }));
    }
  });
  periodsPanel.appendChild(resetRangesBtn);
  periodsPanel.hidden = true;
  addTab('periods', 'Time periods', periodsPanel);

  // Footer
  const footer = document.createElement('footer');
  footer.className = 'pmd-clod-footer';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'pmd-clod-btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', close);
  footer.appendChild(cancel);
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'pmd-clod-btn pmd-clod-btn-primary';
  save.textContent = 'Save';
  save.addEventListener('click', () => {
    settings.set('clodActivitiesByTime', draftActivities);
    settings.set('clodTimePeriods', draftRanges);
    settings.set('aiPersonaName', draftPersona.name);
    settings.set('aiPersonaPronouns', draftPersona.pronounChoice);
    settings.set('aiPersonaCustomPronouns', draftPersona.custom);
    close();
  });
  footer.appendChild(save);
  dialog.appendChild(footer);

  document.body.appendChild(overlay);
  activate('persona');

  removeKeys = installModalKeys(dialog, overlayToken, (e) => {
    if (e.key === 'Escape') {
      close();
      return true;
    }
    return false;
  });
  armDialogFocus(dialog, 'dialog', 'Customize Clod');
}

function makeCustomField(label: string, value: string, onChange: (v: string) => void): HTMLInputElement {
  const wrap = document.createElement('label');
  wrap.className = 'pmd-clod-pronoun-custom-field';
  const tag = document.createElement('span');
  tag.textContent = label;
  wrap.appendChild(tag);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.addEventListener('change', () => {
    const v = input.value.trim();
    if (v) onChange(v);
    else input.value = value;
  });
  wrap.appendChild(input);
  return input;
}

function makeHourInput(value: number, onChange: (v: number) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.max = '23';
  input.value = String(value);
  input.className = 'pmd-clod-hour';
  input.addEventListener('change', () => {
    const v = parseInt(input.value, 10);
    if (Number.isInteger(v) && v >= 0 && v <= 23) onChange(v);
    else input.value = String(value);
  });
  return input;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function formatHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}
