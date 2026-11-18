// Keeps this device's data and the cloud copy in step. Rules:
//  - Each record is one document. The newer version (by updatedAt, compared as instants) wins whole.
//  - Nothing is written until the cloud copy of a collection has been read, so an old local copy can never
//    overwrite a newer cloud one.
//  - Local records that are newer than the cloud copy, or missing from it, are written. Writes that fail
//    are retried on the next change, on the next visit, or after 15 seconds.
//  - Cloud records are checked before use. A malformed one is ignored, not merged.

import { COLLECTIONS, canonicalJson, pickRecord, recordProblem } from './model.js';

const RETRY_MS = 15000;

export function createSyncEngine({ backend, store, onStatus = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let uid = null;
  let unsubscribers = [];
  let unsubscribeStore = null;
  let ready = {};
  const cloud = new Map(); // "collection/id" -> record as last seen in the cloud
  const known = new Map(); // "collection/id" -> canonical JSON the cloud is known to hold
  const inflight = new Map(); // "collection/id" -> canonical JSON being written
  let retryTimer = null;
  let ignored = 0;

  const key = (c, id) => `${c}/${id}`;
  const statusAt = () => new Date(store.now()).toLocaleTimeString();

  function start(nextUid) {
    stop();
    uid = nextUid;
    ready = {};
    cloud.clear();
    known.clear();
    inflight.clear();
    onStatus({ state: 'syncing', message: 'Syncing…' });
    unsubscribers = COLLECTIONS.map((c) => backend.subscribe(uid, c, (records, err) => {
      if (err) { onStatus({ state: 'error', message: 'Could not read from the cloud. Check your connection; changes are kept on this device.' }); return; }
      onRemote(c, records);
    }));
    unsubscribeStore = store.subscribe(pushPending);
  }

  function stop() {
    for (const u of unsubscribers) { try { u(); } catch { /* already closed */ } }
    unsubscribers = [];
    unsubscribeStore?.();
    unsubscribeStore = null;
    clearTimer(retryTimer);
    retryTimer = null;
    uid = null;
    ready = {};
  }

  function onRemote(c, records) {
    const list = [];
    for (const r of Array.isArray(records) ? records : []) {
      if (recordProblem(c, r)) { ignored += 1; continue; }
      list.push(r);
    }
    for (const r of list) cloud.set(key(c, r.id), r);
    store.mergeCollections({ [c]: list }); // pulls in anything newer from the cloud
    for (const r of list) known.set(key(c, r.id), canonicalJson(r));
    ready[c] = true;
    pushPending();
    if (COLLECTIONS.every((x) => ready[x])) {
      onStatus({ state: 'synced', message: `Synced ${statusAt()}.${ignored ? ` ${ignored} unreadable cloud item(s) were skipped.` : ''}` });
    }
  }

  function pushPending() {
    if (!uid) return;
    for (const c of COLLECTIONS) {
      if (!ready[c]) continue;
      for (const r of store.doc[c]) {
        const k = key(c, r.id);
        const json = canonicalJson(r);
        if (known.get(k) === json || inflight.get(k) === json) continue;
        const copy = cloud.get(k);
        if (copy) {
          const cj = canonicalJson(copy);
          if (cj === json) { known.set(k, json); continue; }
          if (pickRecord(copy, r) !== r) { continue; } // the cloud copy is newer; the merge brings it in
        }
        write(c, r, k, json);
      }
    }
  }

  function write(c, r, k, json) {
    inflight.set(k, json);
    backend.write(uid, c, r)
      .then(() => {
        if (inflight.get(k) === json) inflight.delete(k);
        cloud.set(k, r);
        known.set(k, json);
        onStatus({ state: 'synced', message: `Synced ${statusAt()}.` });
      })
      .catch(() => {
        if (inflight.get(k) === json) inflight.delete(k);
        onStatus({ state: 'error', message: 'Some changes could not be saved to the cloud yet. They will be retried.' });
        scheduleRetry();
      });
  }

  function scheduleRetry() {
    clearTimer(retryTimer);
    retryTimer = setTimer(() => { retryTimer = null; pushPending(); }, RETRY_MS);
  }

  return { start, stop, pushPending, isRunning: () => uid !== null };
}
