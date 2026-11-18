// APEX 2: the rules, with no DOM and no clock. Pass "today" and "nowMs" in, so every result is repeatable.

export const SCHEMA_VERSION = 2;
export const EPOCH = '1970-01-01T00:00:00.000Z';
export const COLLECTIONS = ['tracks', 'nodes', 'tasks', 'days'];

// Spaced review. A topic is learned today; the next review is the first gap, then each review moves one step
// further along this list. Late reviews move the schedule forward from the day they happen and never reset it.
export const LADDER_DAYS = [1, 3, 7, 15, 30, 60];
export const MASTER_AFTER_REVIEWS = 5;
export const DEFAULT_ESTIMATE_MIN = 25;
// A timer left running for longer than this is almost certainly forgotten. It is not counted, and the person is told.
export const SEGMENT_CAP_MS = 6 * 3600 * 1000;

export const REASONS = [
  ['interrupted', 'Interrupted'],
  ['longer', 'Took longer than planned'],
  ['unclear', 'Unclear next step'],
  ['energy', 'Low energy'],
  ['other', 'Something else'],
];

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- ids ----------

export function randomId(prefix = '') {
  const raw = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  return prefix + raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
}

// ---------- dates (a "day key" is a local calendar date, YYYY-MM-DD) ----------

const pad2 = (n) => String(n).padStart(2, '0');

export function dateKeyOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function diffDays(a, b) {
  const t = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 864e5);
}

/** The day a moment belongs to. Before the day-start hour (default 04:00) it still counts as yesterday. */
export function dayKeyFor(ms, startHour = 4) {
  const d = new Date(ms);
  const key = dateKeyOf(d);
  return d.getHours() < startHour ? addDays(key, -1) : key;
}

export function isDateKey(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function isIso(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
}

export function formatMinutes(min) {
  if (!min || min < 0) return '0m';
  const t = Math.round(min);
  const h = Math.floor(t / 60);
  const m = t % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function formatClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
}

// ---------- quick add: "Draft intro 25m", "Read chapter 3 1h30" ----------

export function parseQuickAdd(text) {
  const raw = String(text ?? '').trim();
  const m = raw.match(/\s+(?:(\d+)\s*h(?:\s*(\d+)\s*m?)?|(\d+)\s*m)$/i);
  if (!m) return { title: raw.slice(0, 200), estimateMin: null };
  const minutes = m[3] !== undefined ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2] || 0);
  const title = raw.slice(0, m.index).trim();
  if (!title || minutes <= 0 || minutes > 960) return { title: raw.slice(0, 200), estimateMin: null };
  return { title: title.slice(0, 200), estimateMin: minutes };
}

// ---------- syllabus / skill outline: indented or bulleted text ----------

/** Two levels: a line with no indent starts a topic, an indented line is a subtopic of the topic above it. */
export function parseOutline(text) {
  const out = [];
  let parent = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
    const title = line.trim().replace(/^([-*•]|\d+[.)])\s+/, '').trim().slice(0, 120);
    if (!title) continue;
    if (indent === 0 || !parent) {
      parent = { title, children: [] };
      out.push(parent);
    } else {
      parent.children.push({ title });
    }
  }
  return out;
}

// ---------- tracks and nodes ----------

export function liveTracks(doc) {
  return doc.tracks.filter((t) => !t.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function liveNodes(doc, trackId) {
  return doc.nodes.filter((n) => !n.deletedAt && n.trackId === trackId).sort((a, b) => a.order - b.order);
}

/** Items that carry the schedule: a node with no children, since a heading is only a grouping. */
export function scheduledItems(nodes) {
  const parents = new Set(nodes.filter((n) => n.parentId).map((n) => n.parentId));
  return nodes.filter((n) => !parents.has(n.id));
}

export function stageOf(n) {
  if (!n.learnedOn) return 'new';
  if (n.reviewCount >= MASTER_AFTER_REVIEWS) return 'mastered';
  return n.reviewCount > 0 ? 'revising' : 'learned';
}

export const STAGE_LABEL = { new: 'Not started', learned: 'Learned', revising: 'Revising', mastered: 'Mastered' };

export function isDue(n, today) {
  return !n.deletedAt && Boolean(n.nextReviewOn) && n.nextReviewOn <= today;
}

export function learnNode(n, today, ladder = LADDER_DAYS) {
  return { ...n, learnedOn: today, reviewCount: 0, lastReviewedOn: null, nextReviewOn: addDays(today, ladder[0]) };
}

export function reviewNode(n, today, ladder = LADDER_DAYS) {
  if (!n.learnedOn) return learnNode(n, today, ladder); // the first time is learning, not a review
  const reviewCount = n.reviewCount + 1;
  const step = ladder[Math.min(reviewCount, ladder.length - 1)];
  return { ...n, reviewCount, lastReviewedOn: today, nextReviewOn: addDays(today, step) };
}

export function unlearnNode(n) {
  return { ...n, learnedOn: null, reviewCount: 0, lastReviewedOn: null, nextReviewOn: null };
}

export function trackProgress(doc, trackId, today) {
  const items = scheduledItems(liveNodes(doc, trackId));
  const learned = items.filter((n) => n.learnedOn).length;
  const mastered = items.filter((n) => stageOf(n) === 'mastered').length;
  const due = items.filter((n) => isDue(n, today)).length;
  return { total: items.length, learned, mastered, due, percent: items.length ? Math.round((100 * learned) / items.length) : 0 };
}

export function dueItems(doc, today) {
  const names = new Map(liveTracks(doc).map((t) => [t.id, t.name]));
  return doc.nodes
    .filter((n) => isDue(n, today) && names.has(n.trackId) && !doc.nodes.some((c) => c.parentId === n.id && !c.deletedAt))
    .sort((a, b) => a.nextReviewOn.localeCompare(b.nextReviewOn) || a.order - b.order)
    .map((n) => ({ node: n, trackName: names.get(n.trackId), overdueDays: diffDays(n.nextReviewOn, today) }));
}

// ---------- tasks and time ----------

export const liveTasksOn = (doc, date) => doc.tasks.filter((t) => !t.deletedAt && t.date === date).sort((a, b) => a.order - b.order);

export function isRunning(t) {
  return (t.segments || []).some((s) => s.end == null);
}

/** Minutes spent on a task. A running segment counts up to nowMs; a running segment over the cap is not counted. */
export function minutesOf(task, nowMs) {
  let total = task.manualMin || 0;
  for (const s of task.segments || []) {
    const start = Date.parse(s.start);
    const end = s.end == null ? nowMs : Date.parse(s.end);
    const dur = end - start;
    if (!(dur >= 0)) continue;
    if (s.end == null && dur > SEGMENT_CAP_MS) continue;
    total += dur / 60000;
  }
  return total;
}

/** Days from `today` back to a 7-day window, inclusive, as day keys. */
export function lastSevenDays(today) {
  return Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
}

export function weekSummary(doc, today, nowMs) {
  const days = new Set(lastSevenDays(today));
  const closed = doc.days.filter((d) => !d.deletedAt && days.has(d.id) && d.closedAt);
  const tasks = doc.tasks.filter((t) => !t.deletedAt && days.has(t.date));
  return {
    closedDays: closed.length,
    doneTasks: tasks.filter((t) => t.status === 'done').length,
    minutes: tasks.reduce((sum, t) => sum + minutesOf(t, nowMs), 0),
    outcomes: { yes: closed.filter((d) => d.outcome === 'yes').length, partly: closed.filter((d) => d.outcome === 'partly').length, no: closed.filter((d) => d.outcome === 'no').length },
  };
}

// ---------- merge (two copies of the same data, e.g. phone and laptop) ----------

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Compare timestamps as instants: "+05:30" and "Z" strings do not sort by time.
const instant = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t; };

/** The newer version of one record wins whole. Ties are broken by content, so the result is the same on both devices. */
export function pickRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = instant(a.updatedAt);
  const tb = instant(b.updatedAt);
  if (ta !== tb) return ta > tb ? a : b;
  return canonicalJson(a) >= canonicalJson(b) ? a : b;
}

function mergeCollection(listA = [], listB = []) {
  const byId = new Map();
  for (const r of listA) byId.set(r.id, r);
  for (const r of listB) byId.set(r.id, pickRecord(byId.get(r.id), r));
  return [...byId.values()].sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : x.id < y.id ? -1 : 1));
}

export function mergeDocs(a, b) {
  const out = { app: 'apex', schemaVersion: SCHEMA_VERSION };
  out.settings = { ...pickRecord(a.settings || {}, b.settings || {}) };
  const latest = [a.meta?.updatedAt, b.meta?.updatedAt].filter(Boolean).sort((x, y) => instant(y) - instant(x))[0] || '';
  const earliest = [a.meta?.createdAt, b.meta?.createdAt].filter(Boolean).sort((x, y) => instant(x) - instant(y))[0] || '';
  out.meta = { createdAt: earliest, updatedAt: latest };
  for (const c of COLLECTIONS) out[c] = mergeCollection(a[c], b[c]);
  return out;
}

/** Why a single cloud record cannot be used, or null if it can. Never throws. */
export function recordProblem(collection, r) {
  if (!COLLECTIONS.includes(collection)) return 'unknown collection';
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object';
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return 'invalid id';
  if (collection === 'days' && !isDateKey(r.id)) return 'invalid date';
  if (!isIso(r.updatedAt) || !isIso(r.createdAt)) return 'invalid timestamp';
  return null;
}

/** The content of a document, ignoring when it was last touched. Equal keys mean nothing needs saving. */
export function contentKey(doc) {
  return canonicalJson({ ...doc, meta: { ...doc.meta, updatedAt: '' } });
}

// ---------- shape and safety ----------

export function emptyDoc(nowIso) {
  return {
    app: 'apex',
    schemaVersion: SCHEMA_VERSION,
    meta: { createdAt: nowIso, updatedAt: nowIso },
    settings: { updatedAt: EPOCH, dayStartHour: 4 },
    tracks: [], nodes: [], tasks: [], days: [],
  };
}

/** Checks the shape of a document. It never throws; read `ok` and `errors`. */
export function validateDoc(d) {
  const errors = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, errors: ['This is not an APEX document.'] };
  if (d.app !== 'apex') errors.push('The file is not from APEX.');
  if (!Number.isInteger(d.schemaVersion) || d.schemaVersion < 1) errors.push('The schema version is missing.');
  else if (d.schemaVersion > SCHEMA_VERSION) errors.push(`This data was made by a newer APEX (schema ${d.schemaVersion}). Update the app first.`);
  for (const c of COLLECTIONS) {
    if (!Array.isArray(d[c])) { errors.push(`"${c}" is missing or not a list.`); continue; }
    for (const r of d[c]) {
      if (!r || typeof r !== 'object') { errors.push(`A record in "${c}" is not an object.`); break; }
      if (typeof r.id !== 'string' || !ID_RE.test(r.id)) { errors.push(`A record in "${c}" has an invalid id.`); break; }
      if (c === 'days' && !isDateKey(r.id)) { errors.push('A day record has an invalid date.'); break; }
      if (!isIso(r.updatedAt) || !isIso(r.createdAt)) { errors.push(`A record in "${c}" has an invalid timestamp.`); break; }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Fills in fields a document may lack and repairs time segments that end before they start. */
export function normalizeDoc(d, nowIso) {
  const out = structuredClone(d);
  out.app = 'apex';
  out.schemaVersion = SCHEMA_VERSION;
  out.meta = { createdAt: out.meta?.createdAt || nowIso, updatedAt: out.meta?.updatedAt || nowIso };
  out.settings = { updatedAt: EPOCH, dayStartHour: 4, ...(out.settings || {}) };
  for (const c of COLLECTIONS) out[c] = Array.isArray(out[c]) ? out[c] : [];
  for (const t of out.tasks) {
    t.segments = (t.segments || []).map((s) => {
      if (s.end != null && Date.parse(s.end) < Date.parse(s.start)) return { ...s, end: s.start };
      return s;
    });
    t.manualMin = Number(t.manualMin) || 0;
  }
  return out;
}
