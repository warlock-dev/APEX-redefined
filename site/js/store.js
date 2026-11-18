// The one place data changes. Every change is recorded with a timestamp, saved, and announced to the screen.

import {
  DEFAULT_ESTIMATE_MIN, SEGMENT_CAP_MS, addDays, canonicalJson, contentKey, emptyDoc, learnNode, liveNodes,
  mergeDocs, normalizeDoc, parseOutline, randomId, reviewNode, stageOf, unlearnNode, validateDoc, isRunning,
} from './model.js';

export const STORAGE_KEY = 'apex2:data';

export function createStore({
  storage = globalThis.localStorage,
  now = () => Date.now(),
  makeId = randomId,
  startHour = 4,
  key = STORAGE_KEY,
} = {}) {
  const iso = () => new Date(now()).toISOString();
  const dayFor = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return d.getHours() < startHour ? addDays(local, -1) : local;
  };
  const today = () => dayFor(now());
  const listeners = new Set();
  let persistError = null;

  function loadFromStorage() {
    let raw = null;
    try { raw = storage?.getItem(key) ?? null; } catch (e) { persistError = `This browser would not let APEX read its saved data (${e.message}).`; return emptyDoc(iso()); }
    if (!raw) return emptyDoc(iso());
    try {
      const parsed = JSON.parse(raw);
      const v = validateDoc(parsed);
      if (v.ok) return normalizeDoc(parsed, iso());
      throw new Error(v.errors[0]);
    } catch (e) {
      // Never overwrite data we cannot read: keep an untouched copy beside it.
      try { storage.setItem(`${key}:unreadable:${now()}`, raw); } catch { /* storage full: the original stays where it is */ }
      persistError = `Saved data could not be read (${e.message}). A copy was kept, and APEX started empty.`;
      return emptyDoc(iso());
    }
  }

  let doc = loadFromStorage();

  function save() {
    try { storage?.setItem(key, JSON.stringify(doc)); persistError = null; } catch (e) { persistError = `Changes are not being saved in this browser (${e.message}). Export a backup now.`; }
  }
  function notify() { for (const fn of [...listeners]) fn(); }

  /** Apply a change to a copy. Return false to change nothing. */
  function commit(fn) {
    const draft = structuredClone(doc);
    const result = fn(draft, { today: today(), nowMs: now(), ts: iso() });
    if (result === false) return false;
    draft.meta.updatedAt = iso();
    doc = draft;
    save();
    notify();
    return result === undefined ? true : result;
  }

  const touch = (rec, ts) => { rec.updatedAt = ts; return rec; };
  const findLive = (list, id) => list.find((r) => r.id === id && !r.deletedAt);

  // ---------- reading ----------
  return {
    get doc() { return doc; },
    snapshot: () => structuredClone(doc),
    today,
    dayFor,
    now,
    get persistError() { return persistError; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    // ---------- tracks (an exam or a skill) ----------
    addTrack(name, kind = 'exam') {
      const title = String(name ?? '').trim().slice(0, 80);
      if (!title) return false;
      return commit((d, { ts }) => {
        const id = makeId('t_');
        d.tracks.push({ id, name: title, kind: kind === 'skill' ? 'skill' : 'exam', createdAt: ts, updatedAt: ts, deletedAt: null });
        return id;
      });
    },
    renameTrack(id, name) {
      const title = String(name ?? '').trim().slice(0, 80);
      if (!title) return false;
      return commit((d, { ts }) => { const t = findLive(d.tracks, id); if (!t) return false; touch(t, ts).name = title; });
    },
    deleteTrack(id) {
      return commit((d, { ts }) => {
        const t = findLive(d.tracks, id);
        if (!t) return false;
        touch(t, ts).deletedAt = ts;
        for (const n of d.nodes) if (n.trackId === id && !n.deletedAt) touch(n, ts).deletedAt = ts;
      });
    },

    // ---------- topics and subtopics ----------
    addNode(trackId, title, parentId = null) {
      const text = String(title ?? '').trim().slice(0, 120);
      if (!text) return false;
      return commit((d, { ts }) => {
        if (!findLive(d.tracks, trackId)) return false;
        if (parentId && !findLive(d.nodes, parentId)) return false;
        const order = Math.max(-1, ...liveNodes(d, trackId).filter((n) => n.parentId === parentId).map((n) => n.order)) + 1;
        const id = makeId('n_');
        d.nodes.push({ id, trackId, parentId, title: text, order, learnedOn: null, reviewCount: 0, lastReviewedOn: null, nextReviewOn: null, createdAt: ts, updatedAt: ts, deletedAt: null });
        return id;
      });
    },
    /** Adds a whole outline at once: each topic, and its subtopics beneath it. */
    importOutline(trackId, text) {
      const outline = parseOutline(text);
      if (outline.length === 0) return 0;
      return commit((d, { ts }) => {
        if (!findLive(d.tracks, trackId)) return false;
        let order = Math.max(-1, ...liveNodes(d, trackId).map((n) => n.order)) + 1;
        let count = 0;
        for (const top of outline) {
          const topId = makeId('n_');
          d.nodes.push({ id: topId, trackId, parentId: null, title: top.title, order: order++, learnedOn: null, reviewCount: 0, lastReviewedOn: null, nextReviewOn: null, createdAt: ts, updatedAt: ts, deletedAt: null });
          count += 1;
          let child = 0;
          for (const sub of top.children) {
            d.nodes.push({ id: makeId('n_'), trackId, parentId: topId, title: sub.title, order: child++, learnedOn: null, reviewCount: 0, lastReviewedOn: null, nextReviewOn: null, createdAt: ts, updatedAt: ts, deletedAt: null });
            count += 1;
          }
        }
        return count;
      });
    },
    renameNode(id, title) {
      const text = String(title ?? '').trim().slice(0, 120);
      if (!text) return false;
      return commit((d, { ts }) => { const n = findLive(d.nodes, id); if (!n) return false; touch(n, ts).title = text; });
    },
    deleteNode(id) {
      return commit((d, { ts }) => {
        const n = findLive(d.nodes, id);
        if (!n) return false;
        const gone = new Set([id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const c of d.nodes) if (!c.deletedAt && gone.has(c.parentId) && !gone.has(c.id)) { gone.add(c.id); grew = true; }
        }
        for (const c of d.nodes) if (gone.has(c.id) && !c.deletedAt) touch(c, ts).deletedAt = ts;
      });
    },
    learn(id) {
      return commit((d, { ts, today: t }) => {
        const n = findLive(d.nodes, id);
        if (!n || stageOf(n) !== 'new') return false;
        Object.assign(touch(n, ts), learnNode(n, t));
      });
    },
    unlearn(id) {
      return commit((d, { ts }) => {
        const n = findLive(d.nodes, id);
        if (!n || !n.learnedOn) return false;
        Object.assign(touch(n, ts), unlearnNode(n));
      });
    },
    review(id) {
      return commit((d, { ts, today: t }) => {
        const n = findLive(d.nodes, id);
        if (!n) return false;
        Object.assign(touch(n, ts), reviewNode(n, t));
        return stageOf(n);
      });
    },

    // ---------- tasks ----------
    addTask({ title, estimateMin = DEFAULT_ESTIMATE_MIN, nodeId = null, kind = 'plain' } = {}) {
      const text = String(title ?? '').trim().slice(0, 200);
      if (!text) return false;
      return commit((d, { ts, today: t }) => {
        if (nodeId && !findLive(d.nodes, nodeId)) nodeId = null;
        const order = Math.max(-1, ...d.tasks.filter((x) => !x.deletedAt && x.date === t).map((x) => x.order)) + 1;
        d.tasks.push({
          id: makeId('k_'), title: text, date: t, nodeId, kind: kind === 'study' ? 'study' : 'plain',
          estimateMin: estimateMin > 0 ? estimateMin : null, status: 'open', doneAt: null,
          manualMin: 0, segments: [], order, carriedFrom: null, createdAt: ts, updatedAt: ts, deletedAt: null,
        });
        return true;
      });
    },
    renameTask(id, title) {
      const text = String(title ?? '').trim().slice(0, 200);
      if (!text) return false;
      return commit((d, { ts }) => { const k = findLive(d.tasks, id); if (!k) return false; touch(k, ts).title = text; });
    },
    setEstimate(id, minutes) {
      return commit((d, { ts }) => { const k = findLive(d.tasks, id); if (!k) return false; touch(k, ts).estimateMin = minutes > 0 ? minutes : null; });
    },
    /** Starts the timer on one task and stops any other running timer. */
    start(id) {
      return commit((d, { ts, nowMs }) => {
        const k = findLive(d.tasks, id);
        if (!k || k.status === 'done') return false;
        const notes = [];
        for (const other of d.tasks) {
          if (other.deletedAt || !isRunning(other)) continue;
          const seg = other.segments.find((s) => s.end == null);
          const overran = closeSegment(seg, nowMs, other, ts);
          if (overran) notes.push(other.title);
        }
        k.segments.push({ start: ts, end: null });
        touch(k, ts);
        return { overran: notes };
      });
    },
    pause(id) {
      return commit((d, { ts, nowMs }) => {
        const k = findLive(d.tasks, id);
        if (!k || !isRunning(k)) return false;
        const overran = closeSegment(k.segments.find((s) => s.end == null), nowMs, k, ts);
        touch(k, ts);
        return { overran: overran ? [k.title] : [] };
      });
    },
    /** Finishing a study task on a topic not yet learned also marks the topic learned. */
    toggleDone(id) {
      return commit((d, { ts, nowMs, today: t }) => {
        const k = findLive(d.tasks, id);
        if (!k) return false;
        const overran = [];
        if (isRunning(k)) {
          const o = closeSegment(k.segments.find((s) => s.end == null), nowMs, k, ts);
          if (o) overran.push(k.title);
        }
        touch(k, ts);
        if (k.status === 'done') { k.status = 'open'; k.doneAt = null; return { overran, learned: null }; }
        k.status = 'done';
        k.doneAt = ts;
        let learned = null;
        if (k.kind === 'study' && k.nodeId) {
          const n = findLive(d.nodes, k.nodeId);
          if (n && stageOf(n) === 'new') {
            Object.assign(touch(n, ts), learnNode(n, t));
            learned = n.title;
          }
        }
        return { overran, learned };
      });
    },
    /** Adds the time typed in by hand, e.g. when the timer was not used. */
    addManualMinutes(id, minutes) {
      const m = Number(minutes);
      if (!(m > 0 && m <= 960)) return false;
      return commit((d, { ts }) => { const k = findLive(d.tasks, id); if (!k) return false; touch(k, ts).manualMin = (k.manualMin || 0) + m; });
    },
    moveToTomorrow(id) {
      return commit((d, { ts, today: t }) => {
        const k = findLive(d.tasks, id);
        if (!k) return false;
        if (isRunning(k)) closeSegment(k.segments.find((s) => s.end == null), now(), k, ts);
        touch(k, ts).date = addDays(t, 1);
        k.carriedFrom = k.carriedFrom || t;
      });
    },
    deleteTask(id) {
      return commit((d, { ts }) => { const k = findLive(d.tasks, id); if (!k) return false; touch(k, ts).deletedAt = ts; });
    },
    /** Open tasks from earlier days move to today, and remember where they came from. */
    rollToToday() {
      return commit((d, { ts, today: t }) => {
        let moved = 0;
        for (const k of d.tasks) {
          if (k.deletedAt || k.status !== 'open' || k.date >= t) continue;
          k.carriedFrom = k.carriedFrom || k.date;
          k.date = t;
          touch(k, ts);
          moved += 1;
        }
        return moved === 0 ? false : moved;
      });
    },

    // ---------- days ----------
    setMission(date, text) {
      const value = String(text ?? '').trim().slice(0, 200);
      return commit((d, { ts }) => {
        let day = d.days.find((x) => x.id === date && !x.deletedAt);
        if (!day) { day = { id: date, mission: '', outcome: null, tomorrow: '', reasons: [], closedAt: null, createdAt: ts, updatedAt: ts, deletedAt: null }; d.days.push(day); }
        touch(day, ts).mission = value;
      });
    },
    closeDay(date, { outcome, tomorrow = '', reasons = [] } = {}) {
      if (!['yes', 'partly', 'no'].includes(outcome)) return false;
      return commit((d, { ts }) => {
        let day = d.days.find((x) => x.id === date && !x.deletedAt);
        if (!day) { day = { id: date, mission: '', outcome: null, tomorrow: '', reasons: [], closedAt: null, createdAt: ts, updatedAt: ts, deletedAt: null }; d.days.push(day); }
        Object.assign(touch(day, ts), {
          outcome,
          tomorrow: String(tomorrow).trim().slice(0, 200),
          reasons: outcome === 'yes' ? [] : [...new Set(reasons)].slice(0, 5),
          closedAt: ts,
        });
      });
    },

    // ---------- other copies (the same data on another device, or another tab) ----------
    /** Merge another copy into this one. Returns true only if something changed, so two copies cannot keep rewriting each other. */
    mergeIn(remote) {
      const merged = normalizeDoc(mergeDocs(doc, remote), iso());
      if (contentKey(merged) === contentKey(doc)) return false;
      doc = merged;
      save();
      notify();
      return true;
    },
    /** Merge cloud records for some collections. Collections not given are left as they are. Does not change meta.updatedAt. */
    mergeCollections(partial) {
      const remote = structuredClone(doc);
      for (const c of ['tracks', 'nodes', 'tasks', 'days']) {
        if (Array.isArray(partial[c])) remote[c] = partial[c];
      }
      const merged = normalizeDoc(mergeDocs(doc, remote), iso());
      if (contentKey(merged) === contentKey(doc)) return false;
      doc = merged;
      save();
      notify();
      return true;
    },
    /** Store the calendar event id for a topic. Bumps the record so the value syncs to other devices. */
    setCalendar(id, fields) {
      const n = doc.nodes.find((x) => x.id === id);
      if (!n) return false;
      Object.assign(touch(n, iso()), { calendarEventId: fields.calendarEventId ?? null, calendarOn: fields.calendarOn ?? null });
      save();
      notify();
      return true;
    },
    /** Replace everything with one copy, e.g. after the person restores a backup and picks "replace". */
    replaceAll(copy) {
      const next = normalizeDoc(copy, iso());
      doc = next;
      save();
      notify();
    },
    eraseAll() {
      doc = emptyDoc(iso());
      try { storage?.removeItem(key); } catch { /* nothing saved */ }
      notify();
    },
    canonical: () => canonicalJson(doc),
  };
}

/** Ends a running segment. Over the cap it is removed instead, and the caller is told. Returns true if removed. */
function closeSegment(seg, nowMs, task, ts) {
  if (!seg) return false;
  const start = Date.parse(seg.start);
  if (nowMs - start > SEGMENT_CAP_MS) {
    task.segments = task.segments.filter((s) => s !== seg);
    task.updatedAt = ts;
    return true;
  }
  seg.end = new Date(Math.max(start, nowMs)).toISOString();
  task.updatedAt = ts;
  return false;
}
