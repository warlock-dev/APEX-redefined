import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, STORAGE_KEY } from '../site/js/store.js';
import { emptyDoc } from '../site/js/model.js';

function memory() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, _m: m };
}

function clock(startIso) {
  const c = { ms: Date.parse(startIso) };
  c.advance = (min) => { c.ms += min * 60000; };
  return c;
}

let n = 0;
const ids = () => `x${(n += 1)}`;

test('data survives a reload, and nothing is written until a change is made', () => {
  const st = memory();
  const c = clock('2026-11-19T10:00:00+05:30');
  const a = createStore({ storage: st, now: () => c.ms, makeId: ids });
  assert.equal(st._m.size, 0);
  const t = a.addTrack('Physics', 'exam');
  a.importOutline(t, '1. Mechanics\n  - Newton\n  - Friction');
  a.addTask({ title: 'Read Newton', estimateMin: 45, nodeId: a.doc.nodes.find((x) => x.title === 'Newton').id, kind: 'study' });
  const b = createStore({ storage: st, now: () => c.ms, makeId: ids });
  assert.equal(b.doc.tracks[0].name, 'Physics');
  assert.equal(b.doc.nodes.length, 3);
  assert.equal(b.doc.tasks[0].estimateMin, 45);
});

test('the timer: one running task at a time, time is counted, and a forgotten timer is not counted', () => {
  const c = clock('2026-11-19T10:00:00Z');
  const s = createStore({ storage: memory(), now: () => c.ms, makeId: ids });
  s.addTask({ title: 'A' });
  s.addTask({ title: 'B' });
  const [a, b] = s.doc.tasks;
  s.start(a.id);
  c.advance(20);
  s.start(b.id);
  assert.equal(s.doc.tasks.filter((t) => t.segments.some((x) => x.end == null)).length, 1, 'starting B stopped A');
  c.advance(10);
  s.toggleDone(b.id);
  assert.equal(Math.round(minutesFor(s, b.id, c)), 10);
  s.start(a.id);
  c.advance(7 * 60);
  const res = s.pause(a.id);
  assert.deepEqual(res.overran, ['A'], 'the person is told');
  assert.equal(s.doc.tasks[0].segments.length, 1, 'the forgotten segment was removed, not counted');
  assert.equal(Math.round(minutesFor(s, a.id, c)), 20, 'only the first 20 minutes remain');
});

test('finishing a study task on a topic not yet learned marks the topic learned, and the schedule starts', () => {
  const c = clock('2026-11-19T10:00:00Z');
  const s = createStore({ storage: memory(), now: () => c.ms, makeId: ids });
  const t = s.addTrack('Maths', 'exam');
  s.importOutline(t, 'Algebra');
  const topic = s.doc.nodes[0];
  s.addTask({ title: 'Learn algebra', nodeId: topic.id, kind: 'study' });
  const k = s.doc.tasks[0];
  const res = s.toggleDone(k.id);
  assert.equal(res.learned, 'Algebra');
  const after = s.doc.nodes[0];
  assert.equal(after.learnedOn, '2026-11-19');
  assert.equal(after.nextReviewOn, '2026-11-20');
  s.toggleDone(k.id); // reopening does not undo learning
  assert.equal(s.doc.nodes[0].learnedOn, '2026-11-19');
});

test('reviewing a topic moves its next date, and reviews only happen on live topics', () => {
  const c = clock('2026-11-19T10:00:00Z');
  const s = createStore({ storage: memory(), now: () => c.ms, makeId: ids });
  const t = s.addTrack('Maths', 'exam');
  s.importOutline(t, 'Algebra');
  const id = s.doc.nodes[0].id;
  s.learn(id);
  c.advance(24 * 60);
  s.review(id);
  assert.equal(s.doc.nodes[0].nextReviewOn, '2026-11-23');
  s.deleteNode(id);
  assert.equal(s.review(id), false);
});

test('open tasks from earlier days roll forward and remember where they came from', () => {
  const c = clock('2026-11-19T10:00:00Z');
  const s = createStore({ storage: memory(), now: () => c.ms, makeId: ids });
  s.addTask({ title: 'Left over' });
  c.advance(24 * 60);
  assert.equal(s.rollToToday(), 1);
  const k = s.doc.tasks[0];
  assert.equal(k.date, '2026-11-20');
  assert.equal(k.carriedFrom, '2026-11-19');
});

test('closing the day needs a verdict, and reasons are only kept for days that were not fully done', () => {
  const c = clock('2026-11-19T10:00:00Z');
  const s = createStore({ storage: memory(), now: () => c.ms, makeId: ids });
  assert.equal(s.closeDay('2026-11-19', { outcome: 'maybe' }), false);
  s.closeDay('2026-11-19', { outcome: 'yes', reasons: ['energy'] });
  assert.deepEqual(s.doc.days[0].reasons, []);
  s.closeDay('2026-11-19', { outcome: 'partly', reasons: ['energy', 'energy', 'interrupted'], tomorrow: ' Start with Newton ' });
  assert.deepEqual(s.doc.days[0].reasons, ['energy', 'interrupted']);
  assert.equal(s.doc.days[0].tomorrow, 'Start with Newton');
});

test('two copies merge without losing either side, and merging the same copy again writes nothing', () => {
  const c = clock('2026-11-19T10:00:00Z');
  const phone = createStore({ storage: memory(), now: () => c.ms, makeId: ids });
  const laptop = createStore({ storage: memory(), now: () => c.ms, makeId: ids });
  phone.addTrack('Physics', 'exam');
  c.advance(5);
  laptop.addTask({ title: 'From the laptop' });
  assert.equal(phone.mergeIn(laptop.snapshot()), true);
  assert.equal(phone.doc.tracks.length, 1);
  assert.equal(phone.doc.tasks.length, 1);
  assert.equal(phone.mergeIn(laptop.snapshot()), false, 'the phone already holds everything in the laptop copy');
  assert.equal(laptop.mergeIn(phone.snapshot()), true);
  assert.equal(phone.mergeIn(laptop.snapshot()), false, 'nothing left to change');
});

test('an unreadable saved copy is kept beside the empty start, not overwritten', () => {
  const st = memory();
  st.setItem(STORAGE_KEY, '{"app":"apex","schemaVersion":2, broken');
  const s = createStore({ storage: st, now: () => Date.parse('2026-11-19T10:00:00Z'), makeId: ids });
  assert.match(s.persistError, /could not be read/);
  assert.ok([...st._m.keys()].some((k) => k.includes(':unreadable:')));
});

test('a copy from a newer APEX is refused instead of read partly', () => {
  const st = memory();
  st.setItem(STORAGE_KEY, JSON.stringify({ ...emptyDoc('2026-11-01T00:00:00.000Z'), schemaVersion: 9 }));
  const s = createStore({ storage: st, now: () => Date.parse('2026-11-19T10:00:00Z'), makeId: ids });
  assert.equal(s.doc.tasks.length, 0);
  assert.match(s.persistError, /newer APEX/);
});

import { minutesOf } from '../site/js/model.js';
function minutesFor(s, id, c) { return minutesOf(s.doc.tasks.find((t) => t.id === id), c.ms); }
