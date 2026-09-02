// Wire-contract suite for the relay: mailbox CRUD, gzip and malformed
// bodies, ordering, recipient isolation, SSE hello/push/heartbeat,
// dormant auth endpoints, and the rooms protocol (create/update/page/
// snapshot-fast-path/presence/tombstone/participant-cap). Old-client
// compatibility gate: run before AND after any relay change — the
// results must be identical (see the relay hardening, 2026-07-04).
// Relays without rooms (legacy mailbox-only) skip the rooms section:
// set ROOMS=0.
//
// Usage:  BASE=http://127.0.0.1:8411/relay TOKEN=<token> [HB=1] node dev/relay-contract.mjs
// (HB=1 adds the 25s heartbeat check; omit for fast runs.)
const BASE = process.env.BASE || 'http://127.0.0.1:8300/relay';
const TOK = process.env.TOKEN || 'dev-pairing-token';
const AUTH = { Authorization: `Bearer ${TOK}` };
let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

// 1. health, no auth
{
  const r = await fetch(`${BASE}/health`);
  check('health 200', r.status === 200);
}
// 1b. readiness probes the database (2026-09-01 review, R14)
{
  const r = await fetch(`${BASE}/readyz`);
  check('readyz 200 (DB reachable)', r.status === 200, String(r.status));
}
// 1c. an oversized Content-Length is refused before the body is read (R5)
{
  const http = await import('node:http');
  const u = new URL(`${BASE}/messages`);
  const status = await new Promise((resolve) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json', 'Content-Length': '999999999' } }, (res) => resolve(res.statusCode));
    req.on('error', () => resolve(0));
    req.write('{}');
    req.end();
  });
  check('oversized Content-Length → 413 before reading', status === 413, String(status));
}
// 2. auth required
{
  const r1 = await fetch(`${BASE}/messages?recipient=x`);
  const r2 = await fetch(`${BASE}/stream?recipient=x`);
  const r3 = await fetch(`${BASE}/messages`, { method: 'POST', body: '{}' });
  check('GET unauthenticated 401', r1.status === 401);
  check('stream unauthenticated 401', r2.status === 401, String(r2.status));
  check('POST unauthenticated 401', r3.status === 401);
}
// 3-5. SSE: open stream, POST, receive push; store retains until DELETE
const R = 'contract-recipient-1';
{
  const frames = [];
  let hello = false;
  const ctl = new AbortController();
  const streamDone = (async () => {
    const res = await fetch(`${BASE}/stream?recipient=${R}`, { headers: AUTH, signal: ctl.signal });
    check('stream 200 + event-stream', res.status === 200 && (res.headers.get('content-type') || '').includes('text/event-stream'), String(res.status));
    let buf = '';
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          if (frame.includes('event: hello')) hello = true;
          else if (frame.startsWith('data:')) frames.push(JSON.parse(frame.slice(5).trim()));
        }
      }
    } catch { /* aborted */ }
  })();
  await new Promise((r2) => setTimeout(r2, 400));
  check('hello frame received', hello);

  const body = { recipientCode: R, epk: 'E', iv: 'I', ct: 'C', tag: 'T', v: 1 };
  const post = await fetch(`${BASE}/messages`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  check('POST 202', post.status === 202);
  const { msgId } = await post.json();
  await new Promise((r2) => setTimeout(r2, 500));
  check('pushed over SSE', frames.length === 1 && frames[0].msgId === msgId && frames[0].ct === 'C', JSON.stringify(frames));

  const g1 = await (await fetch(`${BASE}/messages?recipient=${R}`, { headers: AUTH })).json();
  check('store retains after push (catch-up sees it)', g1.messages?.length === 1 && g1.messages[0].msgId === msgId);
  const del = await fetch(`${BASE}/messages/${msgId}`, { method: 'DELETE', headers: AUTH });
  check('DELETE 204', del.status === 204);
  const g2 = await (await fetch(`${BASE}/messages?recipient=${R}`, { headers: AUTH })).json();
  check('gone after DELETE', g2.messages?.length === 0);
  ctl.abort();
  await streamDone;
}
// 5b. gzip body, malformed bodies, ordering, isolation (hardening suite adds)
{
  const { gzipSync } = await import('node:zlib');
  const R2 = `contract-recipient-2-${Date.now()}`;
  const p1 = await fetch(`${BASE}/messages`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipientCode: R2, ct: 'first', v: 1 }),
  });
  const gzBody = gzipSync(Buffer.from(JSON.stringify({ recipientCode: R2, ct: 'second', v: 1 })));
  const p2 = await fetch(`${BASE}/messages`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: gzBody,
  });
  check('POST gzip 202', p2.status === 202, String(p2.status));
  const badGz = await fetch(`${BASE}/messages`, {
    method: 'POST', headers: { ...AUTH, 'Content-Encoding': 'gzip' }, body: 'not-gzip',
  });
  check('POST invalid gzip 400', badGz.status === 400, String(badGz.status));
  const badJson = await fetch(`${BASE}/messages`, { method: 'POST', headers: AUTH, body: '{nope' });
  check('POST invalid json 400', badJson.status === 400, String(badJson.status));
  const noRc = await fetch(`${BASE}/messages`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1 }),
  });
  check('POST missing recipientCode 400', noRc.status === 400, String(noRc.status));
  const id1 = (await p1.json()).msgId, id2 = (await p2.json()).msgId;
  const g = await (await fetch(`${BASE}/messages?recipient=${R2}`, { headers: AUTH })).json();
  check('GET oldest-first, gzip payload intact',
    g.messages?.length === 2 && g.messages[0].msgId === id1 && g.messages[1].msgId === id2 && g.messages[1].ct === 'second',
    JSON.stringify(g.messages?.map((m) => m.ct)));
  const iso = await (await fetch(`${BASE}/messages?recipient=nobody-${Date.now()}`, { headers: AUTH })).json();
  check('recipient isolation (empty for stranger)', iso.messages?.length === 0);
  for (const id of [id1, id2]) await fetch(`${BASE}/messages/${id}`, { method: 'DELETE', headers: AUTH });
}
// 5c. heartbeat (slow: opt in with HB=1)
if (process.env.HB === '1') {
  const ctl = new AbortController();
  const res = await fetch(`${BASE}/stream?recipient=hb-${Date.now()}`, { headers: AUTH, signal: ctl.signal });
  let sawHb = false;
  const t0 = Date.now();
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    if (dec.decode(chunk, { stream: true }).includes(': hb')) { sawHb = true; break; }
    if (Date.now() - t0 > 30000) break;
  }
  check('SSE heartbeat within 30s', sawHb);
  ctl.abort();
}
// 6. dormant auth endpoints 404 while Ghost unconfigured
{
  const c = await fetch(`${BASE}/connect`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectCode: 'AAAA-AAAA', routingCode: 'r', confirmEvict: false }),
  });
  check('connect rejected while dormant (4xx, not 5xx/2xx)', c.status >= 400 && c.status < 500, String(c.status));
  const w = await fetch(`${BASE}/ghost-webhook`, { method: 'POST', body: '{}' });
  // Dormant (no GHOST_WEBHOOK_SECRET) → 404; armed → an unsigned post is 401.
  const armed = !!process.env.WEBHOOK_SECRET;
  check(armed ? 'webhook 401 for an unsigned post while armed' : 'webhook 404 while dormant', w.status === (armed ? 401 : 404), String(w.status));
}
// ── Rooms (collaboration sessions) ──────────────────────────────────
if (process.env.ROOMS !== '0') {
  // 7. create + auth
  const mk = await fetch(`${BASE}/rooms`, { method: 'POST', headers: AUTH });
  check('rooms: create 201 + roomId', mk.status === 201, String(mk.status));
  const { roomId } = await mk.json();
  const noAuth = await fetch(`${BASE}/rooms`, { method: 'POST' });
  check('rooms: create unauthenticated 401', noAuth.status === 401, String(noAuth.status));

  // 8. raw-bytes updates get global, increasing seqs
  const postU = (bytes) =>
    fetch(`${BASE}/rooms/${roomId}/updates`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
  const u1 = await postU(Buffer.from('update-one'));
  check('rooms: POST update 202', u1.status === 202, String(u1.status));
  const seq1 = (await u1.json()).seq;
  const seq2 = (await (await postU(Buffer.from('update-two'))).json()).seq;
  check('rooms: seqs increase', Number.isInteger(seq1) && seq2 > seq1, `${seq1} → ${seq2}`);
  const empty = await postU(Buffer.alloc(0));
  check('rooms: empty update 400', empty.status === 400, String(empty.status));

  // 9. cursor paging
  const g0 = await (await fetch(`${BASE}/rooms/${roomId}/updates?after=0`, { headers: AUTH })).json();
  check('rooms: GET after=0 returns both, in order, lastSeq set',
    g0.updates?.length === 2 && g0.updates[0].seq === seq1 && g0.updates[1].seq === seq2
      && g0.lastSeq === seq2 && g0.more === false && !g0.snapshot,
    JSON.stringify({ n: g0.updates?.length, lastSeq: g0.lastSeq, more: g0.more }));
  const g1 = await (await fetch(`${BASE}/rooms/${roomId}/updates?after=${seq1}`, { headers: AUTH })).json();
  check('rooms: GET after=seq1 returns only the tail',
    g1.updates?.length === 1 && g1.updates[0].seq === seq2, JSON.stringify(g1.updates?.map((u) => u.seq)));

  // 10. stream: hello carries the cursor; updates and presence push; the
  // store never records presence.
  {
    const frames = [];
    let helloSeq = null;
    const ctl = new AbortController();
    const done = (async () => {
      const res = await fetch(`${BASE}/rooms/${roomId}/stream`, { headers: AUTH, signal: ctl.signal });
      check('rooms: stream 200 event-stream',
        res.status === 200 && (res.headers.get('content-type') || '').includes('text/event-stream'), String(res.status));
      let buf = ''; const dec = new TextDecoder();
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            if (frame.includes('event: hello')) helloSeq = JSON.parse(frame.slice(frame.indexOf('data:') + 5).trim()).lastSeq;
            else if (frame.startsWith('data:')) frames.push(JSON.parse(frame.slice(5).trim()));
          }
        }
      } catch { /* aborted */ }
    })();
    await new Promise((r) => setTimeout(r, 400));
    check('rooms: hello lastSeq = current cursor', helloSeq === seq2, String(helloSeq));
    const seq3 = (await (await postU(Buffer.from('update-three'))).json()).seq;
    const pres = await fetch(`${BASE}/rooms/${roomId}/presence`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('cursor-blob'),
    });
    check('rooms: presence 202', pres.status === 202, String(pres.status));
    await new Promise((r) => setTimeout(r, 500));
    const uFrame = frames.find((f) => f.t === 'u');
    const pFrame = frames.find((f) => f.t === 'p');
    check('rooms: update pushed over stream', !!uFrame && uFrame.seq === seq3 && typeof uFrame.blob === 'string', JSON.stringify(frames));
    check('rooms: presence pushed over stream', !!pFrame && typeof pFrame.blob === 'string');
    const gAll = await (await fetch(`${BASE}/rooms/${roomId}/updates?after=0`, { headers: AUTH })).json();
    check('rooms: presence never stored', gAll.updates?.length === 3, String(gAll.updates?.length));
    ctl.abort();
    await done;

    // 11. snapshot compaction + fast-path
    const snap = await fetch(`${BASE}/rooms/${roomId}/snapshot`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob: Buffer.from('snapshot-state').toString('base64'), coversThroughSeq: seq3 }),
    });
    check('rooms: snapshot 204', snap.status === 204, String(snap.status));
    const gS = await (await fetch(`${BASE}/rooms/${roomId}/updates?after=0`, { headers: AUTH })).json();
    check('rooms: snapshot fast-path (blob + truncated log)',
      gS.snapshot?.coversThroughSeq === seq3 && gS.updates?.length === 0 && gS.lastSeq === seq3,
      JSON.stringify({ covers: gS.snapshot?.coversThroughSeq, n: gS.updates?.length }));
    const stale = await fetch(`${BASE}/rooms/${roomId}/snapshot`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ blob: Buffer.from('older').toString('base64'), coversThroughSeq: seq1 }),
    });
    check('rooms: stale snapshot 204 no-op', stale.status === 204, String(stale.status));
    const gS2 = await (await fetch(`${BASE}/rooms/${roomId}/updates?after=0`, { headers: AUTH })).json();
    check('rooms: stale snapshot did not replace', gS2.snapshot?.coversThroughSeq === seq3);
    const badSnap = await fetch(`${BASE}/rooms/${roomId}/snapshot`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: '{nope',
    });
    check('rooms: malformed snapshot 400', badSnap.status === 400, String(badSnap.status));
  }

  // 12. participant cap: MAX streams hold, the next connect is 409.
  {
    const CAP = Number(process.env.ROOM_CAP || 10);
    const ctls = [];
    let opened = 0;
    for (let i = 0; i < CAP; i++) {
      const ctl = new AbortController();
      ctls.push(ctl);
      const res = await fetch(`${BASE}/rooms/${roomId}/stream`, { headers: AUTH, signal: ctl.signal });
      // hold the stream OPEN — canceling the body frees the server slot
      if (res.status === 200) opened++;
    }
    const over = await fetch(`${BASE}/rooms/${roomId}/stream`, { headers: AUTH });
    check(`rooms: participant cap (${CAP} ok, next 409)`, opened === CAP && over.status === 409,
      `opened=${opened} over=${over.status}`);
    over.body?.cancel?.();
    for (const c of ctls) c.abort();
    await new Promise((r) => setTimeout(r, 300));
  }

  // 12b. egress additions (2026-07-24): conditional snapshot, epoch tag,
  // presence no-echo, negotiated gzip. All ADDITIVE — old params absent =
  // old behavior, verified by the untouched checks above.
  {
    // snapCovers on every page + haveSnap conditional snapshot.
    const gA = await (await fetch(`${BASE}/rooms/${roomId}/updates?after=0`, { headers: AUTH })).json();
    const covers = gA.snapshot?.coversThroughSeq ?? 0;
    check('rooms: snapCovers reported on every page', gA.snapCovers === covers,
      `snapCovers=${gA.snapCovers} covers=${covers}`);
    if (covers > 0) {
      const cond = await (await fetch(
        `${BASE}/rooms/${roomId}/updates?after=0&haveSnap=${covers}`, { headers: AUTH })).json();
      check('rooms: haveSnap match withholds the snapshot',
        cond.snapshot === undefined && cond.snapshotUnchanged === true && cond.snapCovers === covers,
        JSON.stringify({ unchanged: cond.snapshotUnchanged, snapCovers: cond.snapCovers }));
      const staleTag = await (await fetch(
        `${BASE}/rooms/${roomId}/updates?after=0&haveSnap=${covers - 1}`, { headers: AUTH })).json();
      check('rooms: stale haveSnap still ships the snapshot', !!staleTag.snapshot);
    }

    // presence no-echo: two streams with sids; ?from= skips the sender's.
    const seenA = [];
    const seenB = [];
    const openSse = (sid, sink) => {
      const ctl = new AbortController();
      const done = fetch(`${BASE}/rooms/${roomId}/stream?sid=${sid}`, { headers: AUTH, signal: ctl.signal })
        .then(async (res) => {
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          for (;;) {
            const { done: d, value } = await reader.read();
            if (d) return;
            sink.push(dec.decode(value));
          }
        })
        .catch(() => {});
      return { ctl, done };
    };
    const a = openSse('echo-a', seenA);
    const b = openSse('echo-b', seenB);
    await new Promise((r) => setTimeout(r, 400));
    await fetch(`${BASE}/rooms/${roomId}/presence?from=echo-a`, {
      method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/octet-stream' },
      body: 'presence-noecho-probe',
    });
    await new Promise((r) => setTimeout(r, 500));
    const bGot = seenB.join('').includes('"t":"p"');
    const aGot = seenA.join('').includes('"t":"p"');
    check('rooms: presence ?from= reaches peers but never echoes the sender',
      bGot && !aGot, `peer=${bGot} senderEcho=${aGot}`);
    a.ctl.abort(); b.ctl.abort();
    await new Promise((r) => setTimeout(r, 300));

    // negotiated gzip: a blob-heavy updates response compresses when the
    // client advertises (node fetch always does), and the JSON round-trips.
    const gz = await fetch(`${BASE}/rooms/${roomId}/updates?after=0`, { headers: AUTH });
    const enc = gz.headers.get('content-encoding') ?? '';
    const body = await gz.json();
    const big = JSON.stringify(body).length > 500;
    check('rooms: gzip negotiated on blob-heavy responses (and body round-trips)',
      (!big || enc === 'gzip') && Array.isArray(body.updates),
      `encoding=${enc || 'identity'} size>${500}=${big}`);
  }

  // 13. unknown room vs tombstone
  const g404 = await fetch(`${BASE}/rooms/never-existed/updates?after=0`, { headers: AUTH });
  check('rooms: unknown room 404', g404.status === 404, String(g404.status));
  const del = await fetch(`${BASE}/rooms/${roomId}`, { method: 'DELETE', headers: AUTH });
  check('rooms: DELETE 204', del.status === 204, String(del.status));
  const g410 = await fetch(`${BASE}/rooms/${roomId}/updates?after=0`, { headers: AUTH });
  check('rooms: tombstone 410 (ended ≠ never existed)', g410.status === 410, String(g410.status));
  const s410 = await fetch(`${BASE}/rooms/${roomId}/stream`, { headers: AUTH });
  check('rooms: tombstoned stream 410', s410.status === 410, String(s410.status));
}

// 14b. pages are byte-bounded, not just row-bounded (2026-09-01 review, R4)
{
  const mk = await fetch(`${BASE}/rooms`, { method: 'POST', headers: AUTH });
  const { roomId } = await mk.json();
  const big = Buffer.alloc(2_200_000, 7); // ~2.9 MB of base64 each; three exceed a 4 MB page budget
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}/rooms/${roomId}/updates`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/octet-stream' }, body: big });
    check(`rooms: big update ${i} 202`, r.status === 202, String(r.status));
  }
  const p1 = await (await fetch(`${BASE}/rooms/${roomId}/updates?after=0`, { headers: AUTH })).json();
  check('rooms: byte budget splits a 3-row page (more:true, <3 rows)', p1.more === true && p1.updates.length >= 1 && p1.updates.length < 3, JSON.stringify({ n: p1.updates?.length, more: p1.more }));
  let total = p1.updates.length, pages = 1, after = p1.lastSeq, more = p1.more;
  while (more && pages < 6) {
    const pg = await (await fetch(`${BASE}/rooms/${roomId}/updates?after=${after}`, { headers: AUTH })).json();
    total += pg.updates.length; pages++; after = pg.lastSeq; more = pg.more;
  }
  check('rooms: paging to more:false delivers all 3 rows', total === 3 && more === false && pages >= 2, JSON.stringify({ total, pages, more }));
  await fetch(`${BASE}/rooms/${roomId}`, { method: 'DELETE', headers: AUTH });
}
// 14c. admin metrics exists but is admin-gated (404 without the admin token) (R13)
{
  const r = await fetch(`${BASE}/admin/metrics`, { headers: AUTH });
  check('admin metrics gated (404 without admin token)', r.status === 404, String(r.status));
}

// 15. participant cap: a reconnect with the SAME sid replaces its own ghost
// instead of counting against the cap (2026-09-01 review, R7)
{
  const mk = await fetch(`${BASE}/rooms`, { method: 'POST', headers: AUTH });
  const { roomId } = await mk.json();
  const ctls = [];
  const open = async (sid) => {
    const ctl = new AbortController();
    const res = await fetch(`${BASE}/rooms/${roomId}/stream?sid=${sid}`, { headers: AUTH, signal: ctl.signal });
    ctls.push(ctl);
    return res.status;
  };
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push(await open(`sid${i}`));
  check('rooms: 10 streams open', statuses.every((st) => st === 200), statuses.join(','));
  const eleventh = await open('sid-new');
  check('rooms: 11th distinct sid → 409', eleventh === 409, String(eleventh));
  // Drop sid0 abruptly (no server-side reap yet) and reconnect AS sid0.
  ctls[0].abort();
  await new Promise((r2) => setTimeout(r2, 50));
  const again = await open('sid0');
  check('rooms: same-sid reconnect replaces its ghost (200, not 409)', again === 200, String(again));
  for (const c of ctls) c.abort();
  await fetch(`${BASE}/rooms/${roomId}`, { method: 'DELETE', headers: AUTH });
}

// 16. seats: pick-a-machine eviction (2026-09-02). Needs the relay booted
// with RELAY_DEV_FAKE_SESSION=1 (the local recipe) so /connect-code mints
// codes for a fake member; against a dormant relay the section is skipped.
{
  const member = `seat-test-${Date.now()}`;
  const mint = async () => {
    const r = await fetch(`${BASE}/connect-code`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionJwt: member }),
    });
    return r.status === 200 ? (await r.json()).code : null;
  };
  const connect = async (body, bearer) => {
    const r = await fetch(`${BASE}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const code0 = await mint();
  if (!code0) {
    console.log('  --  seats: /connect-code unavailable (relay not in dev fake-session mode) — section skipped');
  } else {
    const t = Date.now();
    const A = `seatA-${t}`, B = `seatB-${t}`, C = `seatC-${t}`, D = `seatD-${t}`;
    const a = await connect({ connectCode: code0, routingCode: A, deviceLabel: 'Laptop A' });
    check('seats: A links (200)', a.status === 200, String(a.status));
    const b = await connect({ connectCode: await mint(), routingCode: B, deviceLabel: 'Desktop B' });
    check('seats: B links (200)', b.status === 200, String(b.status));
    const c1 = await connect({ connectCode: await mint(), routingCode: C, deviceLabel: 'Phone C' });
    check('seats: a third machine → 409 seatLimit', c1.status === 409 && c1.body?.detail?.error === 'seatLimit', String(c1.status));
    const cands = c1.body?.detail?.candidates ?? [];
    check('seats: 409 lists both seats, oldest first, with labels',
      cands.length === 2 && cands[0]?.routingCode === A && cands[0]?.label === 'Laptop A' && cands[1]?.routingCode === B && cands[1]?.label === 'Desktop B',
      JSON.stringify(cands).slice(0, 200));
    check('seats: 409 keeps the legacy wouldEvict (oldest)', c1.body?.detail?.wouldEvict?.routingCode === A.slice(0, 8));
    const bogus = await connect({ connectCode: c1.body?.detail?.retryCode, routingCode: C, confirmEvict: true, evict: 'no-such-machine' });
    check('seats: unknown evict target → 409 again (evictUnknown) with a fresh retryCode',
      bogus.status === 409 && bogus.body?.detail?.reason === 'evictUnknown' && typeof bogus.body?.detail?.retryCode === 'string', String(bogus.status));
    const c2 = await connect({ connectCode: bogus.body?.detail?.retryCode, routingCode: C, confirmEvict: true, evict: B });
    check('seats: evict=B → C links (200)', c2.status === 200, String(c2.status));
    const bRenew = await connect({ connectCode: '', routingCode: B }, b.body?.entitlement);
    check('seats: the picked machine (B) is evicted — its renewal says youWereEvicted', bRenew.status === 409 && bRenew.body?.detail?.error === 'youWereEvicted', String(bRenew.status));
    const aRenew = await connect({ connectCode: '', routingCode: A, deviceLabel: 'Laptop A (renamed)' }, a.body?.entitlement);
    check('seats: the kept machine (A) still renews (200)', aRenew.status === 200, String(aRenew.status));
    // Pre-picker client at the limit: confirmEvict alone still evicts the OLDEST (A).
    const d1 = await connect({ connectCode: await mint(), routingCode: D });
    const dc = d1.body?.detail?.candidates ?? [];
    check('seats: renewal refreshed A\'s label and lastSeenAt', dc[0]?.routingCode === A && dc[0]?.label === 'Laptop A (renamed)' && dc[0]?.lastSeenAt > dc[0]?.boundAt, JSON.stringify(dc[0]).slice(0, 160));
    const d2 = await connect({ connectCode: d1.body?.detail?.retryCode, routingCode: D, confirmEvict: true });
    check('seats: legacy confirmEvict evicts the oldest (A) and links D (200)', d2.status === 200, String(d2.status));
    const aRenew2 = await connect({ connectCode: '', routingCode: A }, aRenew.body?.entitlement);
    check('seats: A is now the evicted one', aRenew2.status === 409 && aRenew2.body?.detail?.error === 'youWereEvicted', String(aRenew2.status));
  }
}

// 17. Ghost webhook: signed deliveries flip lapsed⇄active but NEVER touch
// evicted seats (2026-09-02). Needs the relay booted with
// GHOST_WEBHOOK_SECRET and the same value in WEBHOOK_SECRET here, plus dev
// fake-session mode for /connect-code; skipped otherwise.
{
  const secret = process.env.WEBHOOK_SECRET || '';
  const mint = async (member) => {
    const r = await fetch(`${BASE}/connect-code`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionJwt: member }),
    });
    return r.status === 200 ? (await r.json()).code : null;
  };
  const connect = async (body, bearer) => {
    const r = await fetch(`${BASE}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const member = `hook-member-${Date.now()}`;
  const code0 = secret ? await mint(member) : null;
  if (!secret || !code0) {
    console.log('  --  webhook: WEBHOOK_SECRET unset or /connect-code unavailable — section skipped');
  } else {
    const { createHmac } = await import('node:crypto');
    const deliver = async (payload, sig) => {
      const body = JSON.stringify(payload);
      const ts = String(Date.now());
      const mac = createHmac('sha256', secret).update(body + ts).digest('hex');
      const r = await fetch(`${BASE}/ghost-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ghost-Signature': sig ?? `sha256=${mac}, t=${ts}` },
        body,
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const t = Date.now();
    const X = `hookX-${t}`, Y = `hookY-${t}`, Z = `hookZ-${t}`;
    const x = await connect({ connectCode: code0, routingCode: X, deviceLabel: 'X' });
    const y = await connect({ connectCode: await mint(member), routingCode: Y, deviceLabel: 'Y' });
    const z1 = await connect({ connectCode: await mint(member), routingCode: Z, deviceLabel: 'Z' });
    const z = await connect({ connectCode: z1.body?.detail?.retryCode, routingCode: Z, confirmEvict: true, evict: X });
    check('webhook: fixture — X evicted, Y + Z active', x.status === 200 && y.status === 200 && z.status === 200, `${x.status}/${y.status}/${z.status}`);
    const bad = await deliver({ member: { current: { uuid: member, status: 'free' } } }, 'sha256=deadbeef, t=1');
    check('webhook: bad signature → 401', bad.status === 401, String(bad.status));
    const lapse = await deliver({ member: { current: { uuid: member, status: 'free', email: 'm@example.com' }, previous: { status: 'paid' } } });
    check('webhook: member → free lapses the 2 ACTIVE seats only (updated=2)', lapse.status === 200 && lapse.body?.updated === 2, JSON.stringify(lapse.body));
    const yLapsed = await connect({ connectCode: '', routingCode: Y }, y.body?.entitlement);
    check('webhook: lapsed Y renews inside grace (200, grace:true)', yLapsed.status === 200 && yLapsed.body?.grace === true, `${yLapsed.status} ${JSON.stringify(yLapsed.body).slice(0, 80)}`);
    const xEv1 = await connect({ connectCode: '', routingCode: X }, x.body?.entitlement);
    check('webhook: evicted X stays evicted after the lapse', xEv1.status === 409 && xEv1.body?.detail?.error === 'youWereEvicted', String(xEv1.status));
    const back = await deliver({ member: { current: { uuid: member, status: 'paid', email: 'm@example.com' }, previous: { status: 'free' } } });
    check('webhook: member → paid reactivates the 2 LAPSED seats only (updated=2)', back.status === 200 && back.body?.updated === 2, JSON.stringify(back.body));
    const yBack = await connect({ connectCode: '', routingCode: Y }, yLapsed.body?.entitlement);
    check('webhook: Y renews normally again (200, no grace) — unblocked without re-linking', yBack.status === 200 && !yBack.body?.grace, `${yBack.status} ${JSON.stringify(yBack.body).slice(0, 80)}`);
    const xEv2 = await connect({ connectCode: '', routingCode: X }, x.body?.entitlement);
    check('webhook: evicted X is NOT resurrected by the reactivation', xEv2.status === 409 && xEv2.body?.detail?.error === 'youWereEvicted', String(xEv2.status));
    const idem = await deliver({ member: { current: { uuid: member, status: 'paid' } } });
    check('webhook: repeat "paid" delivery is a no-op (updated=0)', idem.status === 200 && idem.body?.updated === 0, JSON.stringify(idem.body));
    const gone = await deliver({ member: { previous: { uuid: member, status: 'paid' } } });
    check('webhook: member.deleted (previous only) lapses the active seats (updated=2)', gone.status === 200 && gone.body?.updated === 2, JSON.stringify(gone.body));
    const unknown = await deliver({ member: { current: { uuid: 'nobody-here', status: 'paid' } } });
    check('webhook: unknown member → 200, updated=0', unknown.status === 200 && unknown.body?.updated === 0, JSON.stringify(unknown.body));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
