/**
 * Read-aloud word counting — the body/structure split and the two-rate
 * read-time math (2026-07-29). The split's contract: tags + analytics +
 * cite-marked text form the `other` bucket (a reader's optional second
 * speed); highlighted non-shaded body text forms `body`; everything
 * else counts nowhere. Blank second rate must reproduce the single-rate
 * arithmetic exactly.
 */

import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import {
  countReadAloudSplit,
  countReadAloudWords,
  countCards,
  totalWords,
  readTimeSeconds,
  formatReadTimeFor,
  formatReadTime,
} from '../../src/editor/word-count.js';

const n = schema.nodes;
const m = schema.marks;

function fixtureDoc(): PMNode {
  return n['doc']!.create(null, [
    n['card']!.create(null, [
      // 3 words at the tags/cites rate.
      n['tag']!.create({ id: 'T' }, schema.text('HEG SOLVES WAR')),
      // 2 cite-marked words at the tags/cites rate; the rest of the
      // cite paragraph is silent.
      n['cite_paragraph']!.create(null, [
        schema.text('Brooks 24', [m['cite_mark']!.create()]),
        schema.text(' — professor of things, quals quals quals '),
        // 3 highlighted words INSIDE the cite: read at BODY speed (they
        // can't carry cite_mark — underline excludes it — and read mode
        // shows them, so the clock must count them at full rate).
        schema.text('quote inside quals', [
          m['underline_mark']!.create(),
          m['highlight']!.create(),
        ]),
        // Shading still silences, cites included.
        schema.text(' shaded cite skip', [m['highlight']!.create(), m['shading']!.create()]),
      ]),
      n['card_body']!.create(null, [
        // 4 highlighted words at the body rate.
        schema.text('read these four words', [m['highlight']!.create()]),
        // Unhighlighted body text is not read.
        schema.text(' and lots of unread argument text here'),
        // Shaded highlight = reference-style, not read.
        schema.text(' shaded skip', [m['highlight']!.create(), m['shading']!.create()]),
      ]),
    ]),
    // 5 words at the tags/cites rate.
    n['analytic']!.create({ id: 'A' }, schema.text('extend this analytic every time')),
  ]);
}

describe('countReadAloudSplit', () => {
  it('buckets tags, analytics, and cites as `other`; highlighted text as `body`', () => {
    const counts = countReadAloudSplit(fixtureDoc());
    // body: 4 highlighted body words + 3 highlighted-in-cite words.
    expect(counts).toEqual({ body: 7, other: 10 }); // other: 3 tag + 2 cite + 5 analytic
    expect(totalWords(counts)).toBe(17);
    expect(countReadAloudWords(fixtureDoc())).toBe(17); // total wrapper agrees
  });

  it('empty range counts nothing', () => {
    expect(countReadAloudSplit(fixtureDoc(), 3, 3)).toEqual({ body: 0, other: 0 });
  });
});

describe('countCards', () => {
  function cardDoc(): PMNode {
    const card = (id: string, text: string) =>
      n['card']!.create(null, [
        n['tag']!.create({ id }, schema.text(`Tag ${id}`)),
        n['card_body']!.create(null, schema.text(text)),
      ]);
    return n['doc']!.create(null, [
      card('one', 'First body'),
      n['paragraph']!.create(null, schema.text('Loose text')),
      card('two', 'Second body'),
    ]);
  }

  it('counts every structural card in the full document', () => {
    expect(countCards(cardDoc())).toBe(2);
  });

  it('counts each card intersecting a selected range once', () => {
    const doc = cardDoc();
    const positions: number[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === 'card') positions.push(pos);
      return true;
    });

    expect(countCards(doc, positions[0]! + 2, positions[0]! + 5)).toBe(1);
    expect(countCards(doc, positions[0]! + 2, positions[1]! + 3)).toBe(2);
  });

  it('returns zero when the selected range intersects no card', () => {
    const doc = cardDoc();
    let looseParagraphPos = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph') looseParagraphPos = pos;
      return true;
    });

    expect(countCards(doc, looseParagraphPos + 1, looseParagraphPos + 5)).toBe(0);
  });
});

describe('two-rate read time', () => {
  const counts = { body: 100, other: 50 };

  it('blank second rate reproduces the single-rate arithmetic exactly', () => {
    expect(readTimeSeconds(counts, { wpm: 200 })).toBe(45); // 150 words @ 200
    expect(formatReadTimeFor(counts, { wpm: 200 })).toBe(formatReadTime(150, 200));
  });

  it('with tagWpm set, body reads at wpm and the rest at tagWpm', () => {
    // 100 @ 200 = 30s, 50 @ 300 = 10s.
    expect(readTimeSeconds(counts, { wpm: 200, tagWpm: 300 })).toBe(40);
    expect(formatReadTimeFor(counts, { wpm: 200, tagWpm: 300 })).toBe('0:40');
  });

  it('an unusable tagWpm falls back to the main rate', () => {
    expect(readTimeSeconds(counts, { wpm: 200, tagWpm: 0 })).toBe(45);
    expect(readTimeSeconds(counts, { wpm: 200, tagWpm: -5 })).toBe(45);
  });

  it('an unusable main rate renders as a dash', () => {
    expect(formatReadTimeFor(counts, { wpm: 0 })).toBe('—');
  });
});
