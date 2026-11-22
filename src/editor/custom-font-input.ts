/**
 * "Other font..." support for the settings font pickers: a free-text
 * family name field with installed-font suggestions where available.
 */
import { settings } from './settings.js';
import { isFontAvailable } from './font-detect.js';

/** Sentinel `<option>` value for "Other font..." in the font pickers. */
export const OTHER_FONT_VALUE = '__pmd_other_font__';

export function buildOtherFontOption(): HTMLOptionElement {
  const opt = document.createElement('option');
  opt.value = OTHER_FONT_VALUE;
  opt.textContent = 'Other font...';
  return opt;
}

/** Installed family names via the Local Font Access API (Chromium and
 *  Electron only). Resolves to [] where unsupported or denied. */
let localFontsPromise: Promise<string[]> | null = null;
function loadLocalFontFamilies(): Promise<string[]> {
  const query = (window as unknown as {
    queryLocalFonts?: () => Promise<Array<{ family: string }>>;
  }).queryLocalFonts;
  if (!query) return Promise.resolve([]);
  localFontsPromise ??= query()
    .then((fonts) => [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b)))
    .catch(() => {
      localFontsPromise = null; // denied or no user activation: retry next time
      return [];
    });
  return localFontsPromise;
}

/** Wires the select's change handler and adds a free-text font name
 *  field shown when "Other font..." is picked. The field suggests
 *  installed fonts where the browser can list them, and accepts any
 *  name, as Word does. */
export function attachCustomFontInput(
  wrap: HTMLElement,
  select: HTMLSelectElement,
  key: 'bodyFont' | 'uiFont',
): void {
  const datalist = document.createElement('datalist');
  datalist.id = `pmd-font-list-${key}`;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pmd-body-font-select';
  input.placeholder = 'Font name';
  input.setAttribute('aria-label', 'Font name');
  input.setAttribute('list', datalist.id);
  input.hidden = true;
  const note = document.createElement('span');
  note.className = 'pmd-settings-row-desc';
  note.setAttribute('role', 'status');

  select.addEventListener('change', () => {
    if (select.value !== OTHER_FONT_VALUE) {
      input.hidden = true;
      note.textContent = '';
      settings.set(key, select.value);
      return;
    }
    input.hidden = false;
    input.value = settings.get(key);
    input.focus();
    // Called inside the change event so Chromium sees user activation.
    void loadLocalFontFamilies().then((families) => {
      if (datalist.childElementCount) return;
      for (const family of families) {
        const opt = document.createElement('option');
        opt.value = family;
        datalist.appendChild(opt);
      }
    });
  });

  input.addEventListener('change', () => {
    const name = input.value.replace(/["',]/g, '').trim();
    if (!name) return;
    note.textContent = isFontAvailable(name)
      ? ''
      : `"${name}" was not found on this device; a fallback font will be shown.`;
    settings.set(key, name);
  });

  wrap.append(select, input, datalist, note);
}
