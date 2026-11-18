import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendar, CalendarAuthError, CALENDAR_BASE } from '../site/js/calendar.js';
import { emptyDoc } from '../site/js/model.js';

const NOW = '2026-11-19T10:00:00.000Z';

function docWith(nodes) {
  const d = emptyDoc(NOW);
  d.tracks.push({ id: 'tr1', name: 'Physics', kind: 'exam', createdAt: NOW, updatedAt: NOW, deletedAt: null });
  for (const n of nodes) {
    d.nodes.push({
      id: n.id, trackId: 'tr1', title: n.title ?? 'Newton', parentId: null, learnedOn: null, nextReviewOn: null,
      reviewCount: 0, lastReviewedOn: null, createdAt: NOW, updatedAt: NOW, deletedAt: null,
      calendarEventId: null, calendarOn: null, ...n,
    });
  }
  return d;
}

function fakeStore() {
  const calls = [];
  return { calls, setCalendar: (id, fields) => { calls.push({ id, ...fields }); return true; } };
}

function fakeFetch(handler) {
  const log = [];
  const fetchImpl = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    log.push({ url, method: opts.method, body, auth: opts.headers.Authorization });
    const r = handler(url, opts.method, body);
    return { ok: r.status < 400, status: r.status, json: async () => r.json ?? {} };
  };
  return { fetchImpl, log };
}

const token = () => 'tok-123';

test('creates one all-day event for a learned topic with a due date, and stores its id', async () => {
  const doc = docWith([{ id: 'n1', learnedOn: '2026-11-18', nextReviewOn: '2026-11-19' }]);
  const { fetchImpl, log } = fakeFetch(() => ({ status: 200, json: { id: 'ev1' } }));
  const store = fakeStore();
  const summary = await createCalendar({ getToken: token, fetchImpl }).reconcile(doc, store);

  assert.equal(summary.created, 1);
  assert.equal(log.length, 1);
  assert.equal(log[0].method, 'POST');
  assert.equal(log[0].url, CALENDAR_BASE);
  assert.equal(log[0].auth, 'Bearer tok-123');
  assert.deepEqual(log[0].body.start, { date: '2026-11-19' });
  assert.deepEqual(log[0].body.end, { date: '2026-11-20' }, 'all-day events end the next day');
  assert.equal(log[0].body.extendedProperties.private.apexNodeId, 'n1');
  assert.deepEqual(store.calls, [{ id: 'n1', calendarEventId: 'ev1', calendarOn: '2026-11-19' }]);
});

test('does nothing when the event is already on the right day', async () => {
  const doc = docWith([{ id: 'n1', learnedOn: '2026-11-18', nextReviewOn: '2026-11-21', calendarEventId: 'ev1', calendarOn: '2026-11-21' }]);
  const { fetchImpl, log } = fakeFetch(() => { throw new Error('should not call'); });
  const summary = await createCalendar({ getToken: token, fetchImpl }).reconcile(doc, fakeStore());
  assert.equal(log.length, 0);
  assert.deepEqual(summary, { created: 0, moved: 0, removed: 0, failed: 0 });
});

test('moves the existing event when the review date changes', async () => {
  const doc = docWith([{ id: 'n1', learnedOn: '2026-11-18', nextReviewOn: '2026-11-25', calendarEventId: 'ev1', calendarOn: '2026-11-19' }]);
  const { fetchImpl, log } = fakeFetch(() => ({ status: 200, json: {} }));
  const store = fakeStore();
  const summary = await createCalendar({ getToken: token, fetchImpl }).reconcile(doc, store);
  assert.equal(summary.moved, 1);
  assert.equal(log[0].method, 'PATCH');
  assert.equal(log[0].url, `${CALENDAR_BASE}/ev1`);
  assert.equal(log[0].body.start.date, '2026-11-25');
  assert.deepEqual(store.calls, [{ id: 'n1', calendarEventId: 'ev1', calendarOn: '2026-11-25' }]);
});

test('removes the event when a topic is unlearned or deleted', async () => {
  const doc = docWith([
    { id: 'n1', learnedOn: null, nextReviewOn: null, calendarEventId: 'ev1', calendarOn: '2026-11-19' },
    { id: 'n2', learnedOn: '2026-11-18', nextReviewOn: '2026-11-19', deletedAt: NOW, calendarEventId: 'ev2', calendarOn: '2026-11-19' },
  ]);
  const { fetchImpl, log } = fakeFetch(() => ({ status: 204 }));
  const store = fakeStore();
  const summary = await createCalendar({ getToken: token, fetchImpl }).reconcile(doc, store);
  assert.equal(summary.removed, 2);
  assert.deepEqual(log.map((x) => [x.method, x.url]), [['DELETE', `${CALENDAR_BASE}/ev1`], ['DELETE', `${CALENDAR_BASE}/ev2`]]);
  assert.deepEqual(store.calls.map((x) => [x.id, x.calendarEventId]), [['n1', null], ['n2', null]]);
});

test('creates the event again when it was deleted in Google Calendar', async () => {
  const doc = docWith([{ id: 'n1', learnedOn: '2026-11-18', nextReviewOn: '2026-11-22', calendarEventId: 'gone', calendarOn: '2026-11-19' }]);
  const { fetchImpl, log } = fakeFetch((url, method) => (method === 'PATCH' ? { status: 404 } : { status: 200, json: { id: 'ev9' } }));
  const store = fakeStore();
  const summary = await createCalendar({ getToken: token, fetchImpl }).reconcile(doc, store);
  assert.deepEqual(log.map((x) => x.method), ['PATCH', 'POST']);
  assert.equal(summary.created, 1);
  assert.deepEqual(store.calls.at(-1), { id: 'n1', calendarEventId: 'ev9', calendarOn: '2026-11-22' });
});

test('an expired token stops the whole run and asks for a reconnect; nothing is marked done', async () => {
  const doc = docWith([{ id: 'n1', learnedOn: '2026-11-18', nextReviewOn: '2026-11-19' }]);
  const { fetchImpl } = fakeFetch(() => ({ status: 401 }));
  const store = fakeStore();
  await assert.rejects(createCalendar({ getToken: token, fetchImpl }).reconcile(doc, store), CalendarAuthError);
  assert.equal(store.calls.length, 0);
});

test('no token at all is an auth problem, without any network call', async () => {
  const doc = docWith([{ id: 'n1', learnedOn: '2026-11-18', nextReviewOn: '2026-11-19' }]);
  const { fetchImpl, log } = fakeFetch(() => ({ status: 200 }));
  await assert.rejects(createCalendar({ getToken: () => null, fetchImpl }).reconcile(doc, fakeStore()), CalendarAuthError);
  assert.equal(log.length, 0);
});

test('one failed event does not stop the others', async () => {
  const doc = docWith([
    { id: 'n1', learnedOn: '2026-11-18', nextReviewOn: '2026-11-19' },
    { id: 'n2', learnedOn: '2026-11-18', nextReviewOn: '2026-11-20' },
  ]);
  let n = 0;
  const { fetchImpl } = fakeFetch(() => (n++ === 0 ? { status: 500 } : { status: 200, json: { id: 'ev2' } }));
  const store = fakeStore();
  const summary = await createCalendar({ getToken: token, fetchImpl }).reconcile(doc, store);
  assert.equal(summary.failed, 1);
  assert.equal(summary.created, 1);
  assert.equal(store.calls[0].id, 'n2');
});
