import test from 'node:test';
import * as M from '../site/js/model.js';
import assert from 'node:assert/strict';


const T = '2026-11-19';

test('the review ladder: learn, then 1, 3, 7, 15, 30, 60 days; five reviews master the topic and it still returns every 60 days', () => {
  let n = { id: 'n_a', learnedOn: null, reviewCount: 0, nextReviewOn: null };
  n = M.learnNode(n, T);
  assert.equal(n.nextReviewOn, '2026-11-20', 'first gap is one day');
  assert.equal(M.stageOf(n), 'learned');
  const gaps = [];
  let day = T;
  for (let i = 0; i < 7; i++) {
    n = M.reviewNode(n, day);
    gaps.push(M.diffDays(day, n.nextReviewOn));
    day = n.nextReviewOn;
  }
  assert.deepEqual(gaps, [3, 7, 15, 30, 60, 60, 60]);
  assert.equal(M.stageOf(n), 'mastered');
});

test('a late review moves the schedule forward from the day it happens and does not reset the ladder', () => {
  let n = M.learnNode({ id: 'n_a' }, '2026-11-01');
  n = M.reviewNode(n, '2026-11-02'); // count 1, next +3 => 11-05
  n = M.reviewNode(n, '2026-11-20'); // 18 days late: count 2, next +7 => 11-27
  assert.equal(n.reviewCount, 2);
  assert.equal(n.nextReviewOn, '2026-11-27');
});

test('reviewing something never learned counts as learning it, not as a review', () => {
  const n = M.reviewNode({ id: 'n_a', learnedOn: null, reviewCount: 0 }, T);
  assert.equal(n.reviewCount, 0);
  assert.equal(n.learnedOn, T);
});

test('unlearning clears the schedule completely', () => {
  const n = M.unlearnNode(M.reviewNode(M.learnNode({ id: 'x' }, T), T));
  assert.equal(n.learnedOn, null);
  assert.equal(n.nextReviewOn, null);
  assert.equal(n.reviewCount, 0);
});

test('due means the review date has arrived, and overdue reviews stay due', () => {
  assert.equal(M.isDue({ nextReviewOn: '2026-11-19' }, T), true);
  assert.equal(M.isDue({ nextReviewOn: '2026-11-10' }, T), true);
  assert.equal(M.isDue({ nextReviewOn: '2026-11-20' }, T), false);
  assert.equal(M.isDue({ nextReviewOn: '2026-11-10', deletedAt: '2026-11-11T00:00:00.000Z' }, T), false);
});

test('quick add reads a trailing estimate and leaves ordinary numbers in the title', () => {
  assert.deepEqual(M.parseQuickAdd('Draft intro 25m'), { title: 'Draft intro', estimateMin: 25 });
  assert.deepEqual(M.parseQuickAdd('Read chapter 3 1h30'), { title: 'Read chapter 3', estimateMin: 90 });
  assert.deepEqual(M.parseQuickAdd('Chapter 2'), { title: 'Chapter 2', estimateMin: null });
  assert.deepEqual(M.parseQuickAdd('  Newton 2h  '), { title: 'Newton', estimateMin: 120 });
  assert.deepEqual(M.parseQuickAdd('0m'), { title: '0m', estimateMin: null });
});

test('an outline: unindented lines are topics, indented ones are subtopics, bullets and numbers are dropped', () => {
  const out = M.parseOutline(`1. Mechanics
  - Newton's laws
  - Friction

Optics
\tLenses`);
  assert.deepEqual(out, [
    { title: 'Mechanics', children: [{ title: "Newton's laws" }, { title: 'Friction' }] },
    { title: 'Optics', children: [{ title: 'Lenses' }] },
  ]);
});

test('minutes: stopped time counts, a running timer counts up to now, and a running timer past the cap does not count', () => {
  const t0 = Date.parse('2026-11-19T10:00:00Z');
  const task = { manualMin: 5, segments: [{ start: new Date(t0).toISOString(), end: new Date(t0 + 20 * 60000).toISOString() }, { start: new Date(t0 + 30 * 60000).toISOString(), end: null }] };
  assert.equal(Math.round(M.minutesOf(task, t0 + 40 * 60000)), 5 + 20 + 10);
  const stuck = { manualMin: 0, segments: [{ start: new Date(t0).toISOString(), end: null }] };
  assert.equal(M.minutesOf(stuck, t0 + 7 * 3600000), 0, 'a timer forgotten for seven hours counts for nothing');
});

test('day keys follow the day-start hour, so 02:00 still belongs to the day before', () => {
  const at = (h) => new Date(2026, 10, 19, h, 0).getTime();
  assert.equal(M.dayKeyFor(at(2), 4), '2026-11-18');
  assert.equal(M.dayKeyFor(at(5), 4), '2026-11-19');
  assert.equal(M.addDays('2026-03-07', 1), '2026-03-08');
  assert.equal(M.addDays('2026-10-31', 1), '2026-11-01');
});

test('merge: the newer copy of a record wins whole, times compare as instants, and the result does not depend on order', () => {
  const base = M.emptyDoc('2026-11-01T00:00:00.000Z');
  const rec = (title, ts) => ({ id: 'n_a', trackId: 't_1', parentId: null, title, order: 0, learnedOn: null, reviewCount: 0, lastReviewedOn: null, nextReviewOn: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: ts, deletedAt: null });
  const a = { ...base, tracks: [{ id: 't_1', name: 'Physics', kind: 'exam', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', deletedAt: null }], nodes: [rec('Old', '2026-11-05T10:00:00+05:30')] };
  const b = { ...base, tracks: a.tracks, nodes: [rec('New', '2026-11-05T05:00:00Z')] }; // 04:30+05:30 is earlier than 10:00+05:30 in instants, but later in text
  const ab = M.mergeDocs(a, b);
  const ba = M.mergeDocs(b, a);
  assert.equal(ab.nodes[0].title, 'New', 'by instant, 10:00 +05:30 is 04:30Z, which is earlier than 05:00Z, so the other copy is newer');
  assert.equal(M.canonicalJson(ab), M.canonicalJson(ba), 'same result in either order');
  assert.equal(M.canonicalJson(M.mergeDocs(ab, ab)), M.canonicalJson(ab), 'merging twice changes nothing');
});

test('a document from a newer APEX is refused, and broken ids are caught', () => {
  const d = M.emptyDoc('2026-11-01T00:00:00.000Z');
  assert.equal(M.validateDoc(d).ok, true);
  assert.equal(M.validateDoc({ ...d, schemaVersion: 99 }).ok, false);
  assert.equal(M.validateDoc({ ...d, tasks: [{ id: 'bad id!', createdAt: d.meta.createdAt, updatedAt: d.meta.createdAt }] }).ok, false);
  assert.equal(M.validateDoc({ ...d, days: [{ id: '2026-13-40', createdAt: d.meta.createdAt, updatedAt: d.meta.createdAt }] }).ok, false);
});

test('weekly summary counts only the last seven days', () => {
  const d = M.emptyDoc('2026-11-01T00:00:00.000Z');
  d.days = [
    { id: '2026-11-19', outcome: 'yes', closedAt: 'x', updatedAt: 'x', createdAt: 'x' },
    { id: '2026-11-13', outcome: 'no', closedAt: 'x', updatedAt: 'x', createdAt: 'x' },
    { id: '2026-11-12', outcome: 'yes', closedAt: 'x', updatedAt: 'x', createdAt: 'x' }, // outside the window
  ];
  const s = M.weekSummary(d, '2026-11-19', Date.now());
  assert.equal(s.closedDays, 2);
  assert.equal(s.outcomes.yes, 1);
  assert.equal(s.outcomes.no, 1);
});
