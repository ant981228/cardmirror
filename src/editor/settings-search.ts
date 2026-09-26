/**
 * Query matching for the Settings dialog's search box.
 *
 * Every query word must hit the row's haystack (label, section, aliases,
 * tab label), but a word also counts as a hit through a synonym — the UI
 * calls the toolbar the "ribbon", so "toolbar" should find ribbon rows.
 * Generic verbs like "customize" / "change" are dropped when the query
 * has something more specific to match, so "customize toolbar" lists all
 * the ribbon settings rather than only rows that literally say "custom".
 */

/** Each group's words are interchangeable for matching. */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['toolbar', 'ribbon'],
  ['search', 'powersearch'],
  ['shortcut', 'keybinding', 'hotkey', 'keyboard'],
  ['colour', 'color'],
  ['customise', 'customize', 'custom'],
];

/** Words that say "I want to change settings" rather than which ones. */
const FILLER_WORDS = new Set([
  'customize',
  'customise',
  'customization',
  'customisation',
  'configure',
  'change',
  'edit',
  'setting',
  'settings',
  'option',
  'options',
  'the',
  'my',
  'a',
  'an',
  'of',
  'to',
  'for',
]);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Alternatives for one query word: itself plus its synonyms. */
function alternatives(word: string): string[] {
  const out = [word];
  for (const group of SYNONYM_GROUPS) {
    // Prefix match so partial typing ("toolb", "keybindings") still expands;
    // a 1–2 letter fragment is too ambiguous to expand.
    if (group.some((g) => word.startsWith(g) || (word.length >= 3 && g.startsWith(word)))) {
      for (const g of group) if (!out.includes(g)) out.push(g);
    }
  }
  return out;
}

/** A compiled query: returns whether a haystack matches. An empty query
 *  matches everything. */
export function compileSettingsQuery(query: string): (haystack: string) => boolean {
  const words = normalize(query).split(' ').filter(Boolean);
  const specific = words.filter((w) => !FILLER_WORDS.has(w));
  const effective = specific.length > 0 ? specific : words;
  const needs = effective.map(alternatives);
  return (haystack: string): boolean => {
    const hay = normalize(haystack);
    return needs.every((alts) => alts.some((a) => hay.includes(a)));
  };
}
