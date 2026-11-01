// Worker body for loro-diff-after-snapshot.test.ts: builds a doc the way a
// co-editing session does (a MovableList of cards, a snapshot the guest
// loads, then partner moves + marks imported as a burst) and runs the diff
// the binding's import hold runs. Lives in a worker so a hang (loro-crdt
// 1.13.6, see DETAILED_CHANGELOG "Unreleased") fails the test by timeout
// instead of wedging the vitest process.
import { parentPort, workerData } from 'node:worker_threads';
import { LoroDoc, LoroMap, LoroText } from 'loro-crdt';

const { cards, textLen, rounds } = workerData;
const style = { underline_mark: { expand: 'after' } };
const host = new LoroDoc();
host.setPeerId('1');
host.configTextStyle(style);
const list = host.getMovableList('children');
const maps = [];
for (let i = 0; i < cards; i++) {
  const m = list.insertContainer(i, new LoroMap());
  maps.push(m);
  m.setContainer('text', new LoroText()).insert(0, `card ${i} ` + 'lorem ipsum '.repeat(Math.ceil(textLen / 12)));
  host.commit();
}
for (let r = 0; r < 5; r++) {
  for (let i = 0; i < cards; i++) {
    const t = maps[i].get('text');
    t.mark({ start: 5, end: 25 + r }, 'underline_mark', true);
    t.insert(3, 'x');
  }
  host.commit();
}
const guest = new LoroDoc();
guest.setPeerId('2');
guest.configTextStyle(style);
guest.import(host.export({ mode: 'snapshot' }));
const from = guest.frontiers();
const blobs = [];
for (let r = 0; r < rounds; r++) {
  const v = host.version();
  for (let k = 0; k < 10; k++) {
    list.move(k, cards - 1 - k);
    const t = maps[(k * 7 + r) % cards].get('text');
    t.mark({ start: 10, end: 40 }, 'underline_mark', true);
    t.insert(1, 'y');
  }
  host.commit();
  blobs.push(host.export({ mode: 'update', from: v }));
}
for (const b of blobs) guest.import(b);
const t0 = performance.now();
const diff = guest.diff(from, guest.frontiers(), false);
parentPort.postMessage({ containers: diff.length, ms: performance.now() - t0 });
