import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../site/js/store.js';
import { createSyncEngine } from '../site/js/sync.js';
import { createFakeCloud } from './fake-backend.mjs';

function memory() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function device(cloud, clock, name) {
  let n = 0;
  const store = createStore({ storage: memory(), now: () => clock.ms, makeId: () => `${name}${(n += 1)}` });
  const statuses = [];
  const timers = [];
  const engine = createSyncEngine({
    backend: cloud.backend(),
    store,
    onStatus: (s) => statuses.push(s),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
  });
  return { store, engine, statuses, timers, last: () => statuses.at(-1) };
}

function clock() {
  const c = { ms: Date.parse('2026-11-19T10:00:00+05:30') };
  c.advance = (min) => { c.ms += min * 60000; };
  return c;
}

test('two devices converge on one copy in both directions', async () => {
  const cloud = createFakeCloud();
  const c = clock();
  const a = device(cloud, c, 'a');
  const b = device(cloud, c, 'b');
  a.engine.start('u1');
  b.engine.start('u1');

  const t = a.store.addTrack('Physics', 'exam');
  await flush();
  assert.equal(b.store.doc.tracks.length, 1, 'the phone sees the laptop track');

  c.advance(5);
  b.store.addNode(t, 'Newton');
  await flush();
  assert.equal(a.store.doc.nodes.length, 1, 'the laptop sees the phone node');

  c.advance(5);
  a.store.deleteTrack(t);
  await flush();
  assert.ok(b.store.doc.tracks[0].deletedAt, 'a delete on one device reaches the other as a soft delete');
  for (const c of ['tracks', 'nodes', 'tasks', 'days']) {
    assert.deepEqual(a.store.doc[c], b.store.doc[c], `both devices hold the same ${c}`);
  }
});

test('a converged pair stops writing (no ping-pong)', async () => {
  const cloud = createFakeCloud();
  const c = clock();
  const a = device(cloud, c, 'a');
  const b = device(cloud, c, 'b');
  a.engine.start('u1');
  b.engine.start('u1');
  a.store.addTrack('Chemistry', 'exam');
  await flush();
  const before = cloud.writes;
  a.engine.pushPending();
  b.engine.pushPending();
  await flush();
  assert.equal(cloud.writes, before, 'nothing new was written');
});

test('an old local copy never overwrites a newer cloud copy, even before the first snapshot arrives', async () => {
  const cloud = createFakeCloud();
  const c = clock();
  const a = device(cloud, c, 'a');
  const id = a.store.addTrack('Old name', 'exam');

  cloud.raw('u1', 'tracks', {
    id, name: 'New name', kind: 'exam', createdAt: '2026-11-19T10:00:00.000Z',
    updatedAt: new Date(c.ms + 3600000).toISOString(), deletedAt: null,
  });

  cloud.paused = true;
  a.engine.start('u1');
  await flush();
  assert.equal(cloud.writes, 0, 'nothing is written before the cloud has been read');

  cloud.flush();
  await flush();
  assert.equal(a.store.doc.tracks.find((t) => t.id === id).name, 'New name', 'the newer cloud copy wins');
  assert.equal(cloud.get('u1', 'tracks', id).name, 'New name', 'the cloud copy is not replaced by the old local one');
});

test('a failed write is kept and retried, not lost', async () => {
  const cloud = createFakeCloud();
  const c = clock();
  const a = device(cloud, c, 'a');
  a.engine.start('u1');
  cloud.failNext = 1;
  const id = a.store.addTrack('Biology', 'exam');
  await flush();
  assert.equal(cloud.get('u1', 'tracks', id), null, 'the first write failed');
  assert.equal(a.last().state, 'error', 'the person is told');
  assert.equal(a.timers.length, 1, 'a retry is scheduled');

  a.timers[0]();
  await flush();
  assert.equal(cloud.get('u1', 'tracks', id)?.name, 'Biology', 'the retry wrote it');
  assert.equal(a.last().state, 'synced');
});

test('malformed cloud records are skipped and counted, never merged', async () => {
  const cloud = createFakeCloud();
  const c = clock();
  const a = device(cloud, c, 'a');
  cloud.raw('u1', 'tracks', { id: '../evil', name: 'x', updatedAt: '2026-11-19T10:00:00.000Z', createdAt: '2026-11-19T10:00:00.000Z' });
  cloud.raw('u1', 'tracks', { id: 'good1', name: 'Good', kind: 'exam', updatedAt: '2026-11-19T10:00:00.000Z', createdAt: '2026-11-19T10:00:00.000Z', deletedAt: null });
  a.engine.start('u1');
  await flush();
  assert.deepEqual(a.store.doc.tracks.map((t) => t.id), ['good1']);
  assert.match(a.last().message, /skipped/);
});

test('a device that was offline sends its changes when it comes back', async () => {
  const cloud = createFakeCloud();
  const c = clock();
  const a = device(cloud, c, 'a');
  const b = device(cloud, c, 'b');
  a.engine.start('u1');
  b.engine.start('u1');
  b.engine.stop();
  const t = a.store.addTrack('Maths', 'exam');
  b.store.addTrack('History', 'exam'); // made while stopped: not pushed yet
  b.engine.start('u1');
  await flush();
  assert.equal(a.store.doc.tracks.length, 2, 'both tracks reach the first device');
  assert.ok(cloud.get('u1', 'tracks', t));
});
