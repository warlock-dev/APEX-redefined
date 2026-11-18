// An in-memory stand-in for the Firestore adapter in site/js/backend.js. One cloud is shared by many devices,
// each device gets its own backend view. The cloud can hold snapshots back, fail writes, and be seeded
// with raw records (including malformed ones) so the sync rules can be tested without a network.

export function createFakeCloud() {
  const docs = new Map(); // "uid/collection/id" -> record
  const subs = new Set();
  const cloud = { writes: 0, failNext: 0, paused: false };

  const snapshot = (uid, c) => [...docs.entries()]
    .filter(([k]) => k.startsWith(`${uid}/${c}/`))
    .map(([, r]) => structuredClone(r));

  function deliver(s) {
    if (cloud.paused) { s.pending = true; return; }
    s.cb(snapshot(s.uid, s.c), null);
  }

  function notify(uid, c) {
    for (const s of subs) if (s.live && s.uid === uid && s.c === c) deliver(s);
  }

  /** Deliver snapshots that were held back while paused. */
  cloud.flush = () => {
    cloud.paused = false;
    for (const s of subs) {
      if (s.pending && s.live) { s.pending = false; s.cb(snapshot(s.uid, s.c), null); }
    }
  };

  /** Put a record in the cloud directly, as if another device wrote it. Used to seed bad data too. */
  cloud.raw = (uid, c, record) => { docs.set(`${uid}/${c}/${record.id}`, structuredClone(record)); notify(uid, c); };
  cloud.get = (uid, c, id) => { const r = docs.get(`${uid}/${c}/${id}`); return r ? structuredClone(r) : null; };
  cloud.count = (uid, c) => snapshot(uid, c).length;

  cloud.backend = () => ({
    subscribe(uid, c, cb) {
      const s = { uid, c, cb, live: true, pending: false };
      subs.add(s);
      deliver(s);
      return () => { s.live = false; subs.delete(s); };
    },
    write(uid, c, record) {
      if (cloud.failNext > 0) { cloud.failNext -= 1; return Promise.reject(new Error('offline')); }
      docs.set(`${uid}/${c}/${record.id}`, structuredClone(record));
      cloud.writes += 1;
      notify(uid, c);
      return Promise.resolve();
    },
  });

  return cloud;
}
