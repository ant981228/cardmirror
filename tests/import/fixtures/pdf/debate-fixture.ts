/**
 * The source of the PDF-import fixtures: a small debate document using every
 * style PDF import has to recover (Pocket, Hat, Block, tags, cites, Underline,
 * Emphasis, highlights in two colors, shrunk text, an analytic, a loose
 * paragraph, wrapped multi-line paragraphs).
 *
 * The PDFs beside this file were made from it:
 *   - cardmirror-chromium.pdf: the doc serialized with CardMirror's frozen
 *     clipboard styles (as Save As → PDF does) and printed by headless
 *     Chrome (`--print-to-pdf`).
 *   - verbatim-word.pdf: `toDocx` of the doc, opened in Microsoft Word for
 *     Mac and saved as PDF.
 * Regenerate both whenever this document changes.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../../../src/schema/index.js';

export function buildDebateFixture(): PMNode {
  const n = schema.nodes;
  const m = schema.marks;
  const t = (s: string, ...marks: Mark[]) => schema.text(s, marks);
  const U = () => m['underline_mark']!.create();
  const E = () => m['emphasis_mark']!.create();
  const C = () => m['cite_mark']!.create();
  const H = (color = 'yellow') => m['highlight']!.create({ color });
  const S8 = () => m['font_size']!.create({ halfPoints: 16 });
  const id = () => ({ id: newHeadingId() });
  const filler =
    'Economists across the spectrum agree that the fiscal outlook depends on how quickly the next administration moves, and the evidence from prior cycles shows that delay compounds costs for every sector of the economy.';
  const card = (tag: string, cite: string, details: string, body: PMNode[]) =>
    n['card']!.createChecked(null, [
      n['tag']!.create(id(), t(tag)),
      n['cite_paragraph']!.create(null, [t(cite, C()), t(' ' + details)]),
      ...body,
    ]);
  return n['doc']!.createChecked(null, [
    n['pocket']!.create(id(), t('Affirmative Case')),
    n['hat']!.create(id(), t('Advantage One')),
    n['block']!.create(id(), t('Economy Scenario')),
    card(
      'Single payer saves money by cutting administrative waste',
      'Smith 24',
      '(Jane Smith, Professor of Health Economics at State University, "The Cost of Complexity," Journal of Health Policy, 3/12/2024, https://example.org/cost) //JD',
      [
        n['card_body']!.create(null, [
          t('The current system ', S8()),
          t('spends nearly a third of every dollar on billing', U(), H()),
          t(' and paperwork that ', S8()),
          t('a single payer would eliminate', E(), H()),
          t(' entirely, according to the analysis. ' + filler, S8()),
          t(' Savings would reach ', S8()),
          t('hundreds of billions', U(), H('cyan')),
          t(' within the first decade.', S8()),
        ]),
        n['card_body']!.create(null, [
          t('Moreover, ', S8()),
          t('streamlined coverage improves outcomes', U()),
          t(
            ' for patients who currently delay care because of cost, a pattern documented across every income bracket and region studied.',
            S8(),
          ),
        ]),
      ],
    ),
    card(
      'Recession risk is rising now',
      'Lee and Park 25',
      '[Min Lee and Dana Park, senior economists at the Institute for Fiscal Studies, "Warning Signs," 2025]',
      [
        n['card_body']!.create(null, [
          t('Leading indicators ', S8()),
          t('point to a sharp slowdown by next year', E()),
          t(', with the yield curve and manufacturing orders both flashing red. ' + filler, S8()),
        ]),
      ],
    ),
    n['analytic_unit']!.createChecked(null, [
      n['analytic']!.create(id(), t('Their evidence is outdated and ignores the recent data')),
    ]),
    n['block']!.create(id(), t('Answers To Counterplans')),
    n['paragraph']!.create(null, t('Note to self: read the permutation first and extend it in every speech.')),
    card(
      'The permutation solves',
      'Garcia 23',
      '(Luis Garcia, policy analyst, "Doing Both," Policy Review, 2023)',
      [
        n['card_body']!.create(null, [
          t('Doing both ', S8()),
          t('captures the benefits of each approach', U(), H()),
          t(
            ' without the tradeoffs the negative describes, and nothing about the counterplan is exclusive of the plan.',
            S8(),
          ),
        ]),
      ],
    ),
  ]);
}
