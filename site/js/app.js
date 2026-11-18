// Screens, routing and sync. All rules live in model.js; all changes go through store.js.

import {
  DEFAULT_ESTIMATE_MIN, REASONS, STAGE_LABEL, dueItems, diffDays, formatClock, formatMinutes, isDue,
  isRunning, liveTasksOn, liveTracks, liveNodes, minutesOf, parseQuickAdd, stageOf, trackProgress,
  validateDoc, weekSummary, lastSevenDays, normalizeDoc,
} from './model.js';
import { STORAGE_KEY, createStore } from './store.js';
import { createSyncEngine } from './sync.js';
import { createCalendar, CalendarAuthError } from './calendar.js';
import { FIREBASE_CONFIG, isFirebaseConfigured } from './firebase-config.js';

// ---------- tiny DOM helper (text is always a text node, never HTML) ----------

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    // Styles go through the CSSOM, which the page's CSP allows; a style="" attribute would be blocked.
    else if (k === 'style' && typeof v === 'object') { for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val)); }
    else if (k === 'value') el.value = String(v);
    else if (k === 'checked' || k === 'selected') el[k] = Boolean(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const GLYPH = { new: '○', learned: '◔', revising: '◑', mastered: '●' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function formatDay(key) {
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

// ---------- state that belongs to the screen, not to the data ----------

const ui = {
  showAll: false,
  edit: null, // { kind: 'rename-task' | 'time-task' | 'rename-node' | 'rename-track', id }
  close: null, // draft of the day-close form
  restore: null, // a backup file waiting for the person's choice
};

export function startApp({ storage = globalThis.localStorage, root = document, win = globalThis } = {}) {
  const store = createStore({ storage });
  const main = root.getElementById('main');
  const nav = root.getElementById('nav');
  const toasts = root.getElementById('toasts');
  const banner = root.getElementById('banner');
  const readLS = (k) => { try { return storage?.getItem(k) ?? ''; } catch { return ''; } };
  const writeLS = (k, v) => { try { storage?.setItem(k, v); } catch { /* storage refused: the setting lasts this visit only */ } };

  // ---------- toast ----------
  function toast(message, { action = null, onAction = null, ms = 4500 } = {}) {
    const node = h('div', { class: 'toast', role: 'status' }, h('span', null, message),
      action && h('button', { type: 'button', class: 'toast-action', onclick: () => { onAction?.(); node.remove(); } }, action));
    toasts.append(node);
    setTimeout(() => node.remove(), ms);
  }

  // ---------- rendering ----------
  let scheduled = false;
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; render(); });
  }

  function captureFocus() {
    const el = root.activeElement;
    if (!el || !el.id || !main.contains(el)) return null;
    const pos = el.selectionStart ?? null;
    return { id: el.id, value: el.value, pos, end: el.selectionEnd ?? null };
  }
  function restoreFocus(snap) {
    if (!snap) return;
    const el = root.getElementById(snap.id);
    if (!el) return;
    if (el.value !== snap.value && 'value' in el) el.value = snap.value;
    el.focus({ preventScroll: true });
    if (snap.pos != null && el.setSelectionRange) { try { el.setSelectionRange(snap.pos, snap.end ?? snap.pos); } catch { /* not a text field */ } }
  }

  function route() {
    const [name, arg] = (win.location.hash || '#/today').replace(/^#\/?/, '').split('/');
    return { name: ['tracks', 'track', 'close', 'progress', 'more'].includes(name) ? name : 'today', arg: arg || null };
  }

  const NAV = [['today', 'Today', '☀'], ['tracks', 'Tracks', '▤'], ['close', 'Close day', '☾'], ['progress', 'Progress', '↗'], ['more', 'More', '⋯']];

  function render() {
    const snap = captureFocus();
    const r = route();
    const view = {
      today: todayView, tracks: tracksView, track: () => trackView(r.arg), close: closeView, progress: progressView, more: moreView,
    }[r.name];
    main.replaceChildren(view());
    if (!nav.childElementCount) {
      for (const [key, label, glyph] of NAV) nav.append(h('a', { href: `#/${key}`, 'data-nav': key }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, glyph), h('span', null, label)));
    }
    for (const a of nav.querySelectorAll('a')) {
      const active = a.dataset.nav === (r.name === 'track' ? 'tracks' : r.name);
      if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    banner.replaceChildren(...(store.persistError ? [h('div', { class: 'notice', role: 'alert' }, store.persistError)] : []));
    restoreFocus(snap);
    // On a computer, typing starts a task straight away. Phones keep the keyboard closed until tapped.
    if (r.name === 'today' && root.activeElement === root.body && win.matchMedia?.('(pointer: fine)').matches) {
      root.getElementById('quick')?.focus({ preventScroll: true });
    }
  }

  // ---------- actions shared by several screens ----------
  function startTask(id) {
    const res = store.start(id);
    if (res?.overran?.length) toast('A timer had been running for over 6 hours, so that time was not counted.');
  }
  function pauseTask(id) {
    const res = store.pause(id);
    if (res?.overran?.length) toast('A timer had been running for over 6 hours, so that time was not counted.');
  }
  function finishTask(task) {
    if (task.status === 'done') { store.toggleDone(task.id); return; }
    const res = store.toggleDone(task.id);
    if (res?.overran?.length) toast('A timer had been running for over 6 hours, so that time was not counted.');
    if (res?.learned) toast(`Marked learned: ${res.learned}. Undo it from Tracks.`);
  }
  function reviewTopic(node) {
    const stage = store.review(node.id);
    if (stage === false) return;
    const fresh = store.doc.nodes.find((n) => n.id === node.id);
    const gap = fresh?.nextReviewOn ? diffDays(store.today(), fresh.nextReviewOn) : null;
    toast(gap == null ? 'Reviewed.' : `Reviewed. Next review in ${plural(gap, 'day')}.`);
  }

  // ---------- Today ----------
  function todayView() {
    const day = store.today();
    const doc = store.doc;
    const tasks = liveTasksOn(doc, day);
    const open = tasks.filter((t) => t.status === 'open');
    const done = tasks.filter((t) => t.status === 'done');
    const current = open.find(isRunning) || open[0];
    const rest = open.filter((t) => t !== current);
    const shown = ui.showAll ? rest : rest.slice(0, 3);
    const day0 = doc.days.find((d) => d.id === day && !d.deletedAt);
    const due = dueItems(doc, day);
    const trackedMin = tasks.reduce((s, t) => s + minutesOf(t, store.now()), 0);

    return h('div', { class: 'screen today' },
      h('header', { class: 'screen-head' },
        h('p', { class: 'eyebrow' }, formatDay(day)),
        h('p', { class: 'summary', id: 'summary' },
          tasks.length ? `${done.length} of ${tasks.length} done · ${formatMinutes(trackedMin)} tracked` : 'Nothing planned yet')),
      h('input', {
        id: 'mission', class: 'mission', type: 'text', maxlength: 200, autocomplete: 'off',
        placeholder: 'One outcome for today (optional)', value: day0?.mission || '', 'aria-label': 'One outcome for today',
        onchange: (e) => store.setMission(day, e.target.value),
      }),
      current ? nowCard(current) : emptyNow(done.length),
      due.length ? dueCard(due) : null,
      rest.length ? h('section', { class: 'list-block', 'aria-label': 'Up next' },
        h('h2', { class: 'label' }, 'Up next'),
        h('ul', { class: 'tasks' }, shown.map((t) => taskRow(t))),
        rest.length > 3 && h('button', { type: 'button', class: 'btn btn--quiet', onclick: () => { ui.showAll = !ui.showAll; render(); } },
          ui.showAll ? 'Show fewer' : `Show ${rest.length - 3} more`)) : null,
      quickAdd(),
      done.length ? h('details', { class: 'done-block' },
        h('summary', null, `Done today (${done.length})`),
        h('ul', { class: 'tasks' }, done.map((t) => taskRow(t)))) : null,
      h('p', { class: 'closing' }, h('a', { href: '#/close' }, 'Close the day →')));
  }

  function nowCard(t) {
    const running = isRunning(t);
    const node = t.nodeId ? store.doc.nodes.find((n) => n.id === t.nodeId) : null;
    const track = node ? store.doc.tracks.find((x) => x.id === node.trackId) : null;
    const tracked = minutesOf(t, store.now());
    return h('section', { class: `now${running ? ' now--running' : ''}`, 'aria-label': 'Now' },
      h('p', { class: 'eyebrow' }, running ? 'Running' : 'Now'),
      h('h2', { class: 'now-title' }, t.title),
      (track || node) && h('p', { class: 'muted' }, [track?.name, node?.title].filter(Boolean).join(' › ')),
      t.carriedFrom && h('p', { class: 'muted small' }, `Carried over from ${t.carriedFrom}`),
      h('p', { class: 'clock', 'data-clock': t.id },
        running ? formatClock(tracked * 60000) : (tracked > 0 ? formatMinutes(tracked) : 'not started'),
        t.estimateMin ? ` · planned ${formatMinutes(t.estimateMin)}` : ''),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn--primary btn--big', onclick: () => (running ? pauseTask(t.id) : startTask(t.id)) }, running ? 'Pause' : 'Start'),
        h('button', { type: 'button', class: 'btn btn--big', onclick: () => finishTask(t) }, 'Done')));
  }

  function emptyNow(doneCount) {
    return h('section', { class: 'now now--empty', 'aria-label': 'Now' },
      h('h2', { class: 'now-title' }, doneCount ? 'Everything planned is done.' : 'Nothing planned yet.'),
      h('p', { class: 'muted' }, doneCount ? 'Close the day when you are ready, or add something else.' : 'Type your first task below. Add “25m” or “1h” at the end to set a time.'),
      doneCount ? h('div', { class: 'btn-row' }, h('a', { class: 'btn btn--primary', href: '#/close' }, 'Close the day')) : null);
  }

  function dueCard(due) {
    const shown = due.slice(0, 4);
    return h('section', { class: 'panel due', 'aria-label': 'Reviews due' },
      h('h2', { class: 'label' }, `${plural(due.length, 'review')} due`),
      h('ul', { class: 'due-list' }, shown.map(({ node, trackName, overdueDays }) => h('li', { class: 'due-row' },
        h('div', { class: 'due-body' },
          h('p', { class: 'due-title' }, node.title),
          h('p', { class: 'muted small' }, `${trackName} · ${overdueDays > 0 ? `${plural(overdueDays, 'day')} late` : 'due today'}`)),
        h('button', { type: 'button', class: 'btn btn--small btn--primary', onclick: () => reviewTopic(node), 'aria-label': `Reviewed: ${node.title}` }, 'Reviewed')))),
      due.length > shown.length && h('a', { class: 'small', href: '#/tracks' }, `All ${due.length} due`));
  }

  function quickAdd() {
    return h('form', {
      class: 'quick', autocomplete: 'off',
      onsubmit: (e) => {
        e.preventDefault();
        const input = root.getElementById('quick');
        const parsed = parseQuickAdd(input.value);
        if (!parsed.title) return;
        input.value = '';
        store.addTask({ title: parsed.title, estimateMin: parsed.estimateMin ?? DEFAULT_ESTIMATE_MIN });
      },
    },
    h('label', { class: 'sr', for: 'quick' }, 'Add a task'),
    h('input', { id: 'quick', type: 'text', maxlength: 220, placeholder: 'Add a task, e.g. “Newton 45m”', enterkeyhint: 'done' }),
    h('button', { type: 'submit', class: 'btn btn--primary' }, 'Add'));
  }

  function taskRow(t) {
    const done = t.status === 'done';
    const running = isRunning(t);
    const editing = ui.edit && ui.edit.id === t.id;
    const node = t.nodeId ? store.doc.nodes.find((n) => n.id === t.nodeId && !n.deletedAt) : null;
    const tracked = minutesOf(t, store.now());
    const meta = [
      t.estimateMin ? `planned ${formatMinutes(t.estimateMin)}` : null,
      tracked > 0 ? `tracked ${formatMinutes(tracked)}` : null,
      t.carriedFrom ? `from ${t.carriedFrom}` : null,
      node ? node.title : null,
    ].filter(Boolean).join(' · ');

    if (editing && (ui.edit.kind === 'rename-task' || ui.edit.kind === 'time-task')) {
      return h('li', { class: 'task task--edit' }, editForm(t.id, ui.edit.kind));
    }
    return h('li', { class: `task${done ? ' task--done' : ''}${running ? ' task--running' : ''}` },
      h('button', {
        type: 'button', class: 'check', role: 'checkbox', 'aria-checked': done ? 'true' : 'false',
        'aria-label': `${done ? 'Reopen' : 'Finish'}: ${t.title}`, onclick: () => finishTask(t),
      }, done ? '✓' : ''),
      h('div', { class: 'task-body' },
        h('p', { class: 'task-title' }, t.title),
        meta && h('p', { class: 'muted small' }, meta)),
      !done && h('button', {
        type: 'button', class: 'icon-btn', 'aria-label': `${running ? 'Pause' : 'Start'}: ${t.title}`,
        onclick: () => (running ? pauseTask(t.id) : startTask(t.id)),
      }, running ? '❚❚' : '▶'),
      h('details', { class: 'menu' },
        h('summary', { 'aria-label': `More for ${t.title}` }, '⋯'),
        h('div', { class: 'menu-items' },
          h('button', { type: 'button', onclick: () => { ui.edit = { kind: 'rename-task', id: t.id }; render(); } }, 'Rename'),
          h('button', { type: 'button', onclick: () => { ui.edit = { kind: 'time-task', id: t.id }; render(); } }, 'Add time'),
          !done && h('button', { type: 'button', onclick: () => store.setEstimate(t.id, DEFAULT_ESTIMATE_MIN * 2) }, 'Double the plan'),
          !done && h('button', { type: 'button', onclick: () => store.moveToTomorrow(t.id) }, 'Move to tomorrow'),
          h('button', { type: 'button', class: 'danger', onclick: () => { if (win.confirm(`Delete “${t.title}”?`)) store.deleteTask(t.id); } }, 'Delete'))));
  }

  function editForm(id, kind) {
    const isTime = kind === 'time-task';
    const save = () => {
      const value = root.getElementById(`edit-${id}`).value;
      if (isTime) {
        const mins = parseQuickAdd(`x ${value}`).estimateMin ?? Number(value);
        if (!(mins > 0)) { toast('Type minutes, for example 20 or 1h10.'); return; }
        store.addManualMinutes(id, mins);
      } else {
        store.renameTask(id, value);
      }
      ui.edit = null;
      render();
    };
    return h('form', { class: 'inline-edit', onsubmit: (e) => { e.preventDefault(); save(); } },
      h('label', { class: 'sr', for: `edit-${id}` }, isTime ? 'Minutes to add' : 'Task title'),
      h('input', { id: `edit-${id}`, type: 'text', maxlength: 200, autofocus: true, placeholder: isTime ? 'Minutes, e.g. 20 or 1h10' : '', value: '' }),
      h('button', { type: 'submit', class: 'btn btn--small btn--primary' }, 'Save'),
      h('button', { type: 'button', class: 'btn btn--small btn--quiet', onclick: () => { ui.edit = null; render(); } }, 'Cancel'));
  }

  // ---------- Tracks ----------
  function tracksView() {
    const doc = store.doc;
    const tracks = liveTracks(doc);
    return h('div', { class: 'screen' },
      h('header', { class: 'screen-head' }, h('h1', { class: 'h-page' }, 'Tracks'),
        h('p', { class: 'muted' }, 'An exam or a skill, split into topics and subtopics. Each topic comes back for review on a fixed schedule.')),
      tracks.length === 0 && h('div', { class: 'panel' }, h('p', null, 'No track yet. Create one below, then paste its syllabus or list of topics.')),
      h('ul', { class: 'track-list' }, tracks.map((t) => {
        const p = trackProgress(doc, t.id, store.today());
        return h('li', { class: 'panel track-card' },
          h('a', { href: `#/track/${t.id}`, class: 'track-link' },
            h('span', { class: 'track-name' }, t.name),
            h('span', { class: 'muted small' }, `${t.kind === 'skill' ? 'Skill' : 'Exam'} · ${p.learned} of ${p.total} learned${p.due ? ` · ${p.due} due` : ''}`)),
          h('div', { class: 'bar', role: 'img', 'aria-label': `${p.percent}% learned` }, h('div', { class: 'bar-fill', style: { width: `${p.percent}%` } })));
      })),
      h('form', {
        class: 'panel stack', autocomplete: 'off',
        onsubmit: (e) => {
          e.preventDefault();
          const name = root.getElementById('track-name').value;
          const kind = root.getElementById('track-kind').value;
          if (!store.addTrack(name, kind)) { toast('Give the track a name first.'); return; }
          win.location.hash = '#/tracks';
          render();
        },
      },
      h('h2', { class: 'label' }, 'New track'),
      h('label', { class: 'field' }, h('span', null, 'Name'), h('input', { id: 'track-name', type: 'text', maxlength: 80, placeholder: 'e.g. Physics for the exam, or Spanish' })),
      h('label', { class: 'field' }, h('span', null, 'Kind'),
        h('select', { id: 'track-kind' }, h('option', { value: 'exam' }, 'Exam syllabus'), h('option', { value: 'skill' }, 'Skill'))),
      h('button', { type: 'submit', class: 'btn btn--primary' }, 'Create track')));
  }

  function trackView(id) {
    const doc = store.doc;
    const track = doc.tracks.find((t) => t.id === id && !t.deletedAt);
    if (!track) return h('div', { class: 'screen' }, h('p', null, 'This track no longer exists.'), h('a', { href: '#/tracks' }, 'Back to tracks'));
    const today = store.today();
    const p = trackProgress(doc, id, today);
    const nodes = liveNodes(doc, id);
    const tops = nodes.filter((n) => !n.parentId);
    const dues = dueItems(doc, today).filter((d) => d.node.trackId === id);
    const editingTrack = ui.edit && ui.edit.kind === 'rename-track' && ui.edit.id === id;

    return h('div', { class: 'screen' },
      h('p', { class: 'small' }, h('a', { href: '#/tracks' }, '← Tracks')),
      h('header', { class: 'screen-head' },
        editingTrack
          ? h('form', { class: 'inline-edit', onsubmit: (e) => { e.preventDefault(); store.renameTrack(id, root.getElementById('edit-track').value); ui.edit = null; render(); } },
            h('label', { class: 'sr', for: 'edit-track' }, 'Track name'),
            h('input', { id: 'edit-track', type: 'text', maxlength: 80, value: track.name, autofocus: true }),
            h('button', { type: 'submit', class: 'btn btn--small btn--primary' }, 'Save'))
          : h('h1', { class: 'h-page' }, track.name),
        h('p', { class: 'muted' }, `${track.kind === 'skill' ? 'Skill' : 'Exam'} · ${p.learned} of ${p.total} learned · ${p.mastered} mastered`),
        h('div', { class: 'bar', role: 'img', 'aria-label': `${p.percent}% learned` }, h('div', { class: 'bar-fill', style: { width: `${p.percent}%` } }))),
      dues.length ? h('section', { class: 'panel due' },
        h('h2', { class: 'label' }, `${plural(dues.length, 'review')} due here`),
        h('ul', { class: 'due-list' }, dues.map(({ node, overdueDays }) => h('li', { class: 'due-row' },
          h('div', { class: 'due-body' }, h('p', { class: 'due-title' }, node.title),
            h('p', { class: 'muted small' }, overdueDays > 0 ? `${plural(overdueDays, 'day')} late` : 'due today')),
          h('button', { type: 'button', class: 'btn btn--small btn--primary', onclick: () => reviewTopic(node) }, 'Reviewed'))))) : null,
      h('section', { class: 'stack' },
        h('h2', { class: 'label' }, 'Topics'),
        tops.length === 0 && h('p', { class: 'muted' }, 'No topics yet. Paste the syllabus below.'),
        h('ul', { class: 'node-list' }, tops.map((top) => topicBlock(top, nodes))),
        h('form', {
          class: 'quick', autocomplete: 'off',
          onsubmit: (e) => {
            e.preventDefault();
            const input = root.getElementById('new-topic');
            const text = input.value;
            input.value = '';
            if (!store.addNode(id, text)) toast('Type the topic name first.');
          },
        },
        h('label', { class: 'sr', for: 'new-topic' }, 'Add a topic'),
        h('input', { id: 'new-topic', type: 'text', maxlength: 120, placeholder: 'Add a topic' }),
        h('button', { type: 'submit', class: 'btn' }, 'Add'))),
      h('details', { class: 'panel' },
        h('summary', null, 'Paste a syllabus or list'),
        h('p', { class: 'muted small' }, 'One topic per line. Indent a line to make it a subtopic. Numbers and dashes are removed for you.'),
        h('label', { class: 'sr', for: 'outline' }, 'Syllabus'),
        h('textarea', { id: 'outline', rows: 8, placeholder: '1. Mechanics\n   Newton’s laws\n   Friction\n2. Optics\n   Lenses' }),
        h('button', {
          type: 'button', class: 'btn btn--primary', onclick: () => {
            const text = root.getElementById('outline').value;
            const n = store.importOutline(id, text);
            if (!n) { toast('Nothing to add. Paste at least one line.'); return; }
            toast(`Added ${plural(n, 'topic')}.`);
          },
        }, 'Add these topics')),
      h('section', { class: 'stack small' },
        editingTrack ? null : h('button', { type: 'button', class: 'btn btn--quiet', onclick: () => { ui.edit = { kind: 'rename-track', id }; render(); } }, 'Rename track'),
        h('button', { type: 'button', class: 'btn btn--text danger', onclick: () => { if (win.confirm(`Delete “${track.name}” and its topics? You can undo this from a backup, not from here.`)) { store.deleteTrack(id); win.location.hash = '#/tracks'; } } }, 'Delete track')));
  }

  function topicBlock(top, all) {
    const children = all.filter((n) => n.parentId === top.id);
    if (children.length === 0) return nodeRow(top, 0);
    const learned = children.filter((c) => c.learnedOn).length;
    return h('li', { class: 'topic-group' },
      h('div', { class: 'group-head' },
        h('p', { class: 'group-title' }, top.title),
        h('p', { class: 'muted small' }, `${learned} of ${children.length} learned`),
        editRow(top, 'rename-node', true)),
      h('ul', { class: 'node-list nested' }, children.map((c) => nodeRow(c, 1))));
  }

  function editRow(node, kind, inlineOnly = false) {
    const edit = ui.edit && ui.edit.id === node.id && ui.edit.kind === kind;
    if (edit) {
      return h('form', { class: 'inline-edit', onsubmit: (e) => { e.preventDefault(); store.renameNode(node.id, root.getElementById(`edit-${node.id}`).value); ui.edit = null; render(); } },
        h('label', { class: 'sr', for: `edit-${node.id}` }, 'Topic name'),
        h('input', { id: `edit-${node.id}`, type: 'text', maxlength: 120, value: node.title, autofocus: true }),
        h('button', { type: 'submit', class: 'btn btn--small btn--primary' }, 'Save'),
        h('button', { type: 'button', class: 'btn btn--small btn--quiet', onclick: () => { ui.edit = null; render(); } }, 'Cancel'));
    }
    return h('details', { class: 'menu' },
      h('summary', { 'aria-label': `More for ${node.title}` }, '⋯'),
      h('div', { class: 'menu-items' },
        h('button', { type: 'button', onclick: () => { ui.edit = { kind, id: node.id }; render(); } }, 'Rename'),
        inlineOnly ? null : h('button', { type: 'button', class: 'danger', onclick: () => { if (win.confirm(`Delete “${node.title}”?`)) store.deleteNode(node.id); } }, 'Delete'),
        inlineOnly ? h('button', { type: 'button', class: 'danger', onclick: () => { if (win.confirm(`Delete “${node.title}” and its subtopics?`)) store.deleteNode(node.id); } }, 'Delete with subtopics') : null));
  }

  function nodeRow(n, depth) {
    const stage = stageOf(n);
    const due = isDue(n, store.today());
    const next = n.nextReviewOn ? diffDays(store.today(), n.nextReviewOn) : null;
    const state = due ? (next < 0 ? `${plural(-next, 'day')} late` : 'due today') : next != null ? `next review in ${plural(next, 'day')}` : '';
    const label = `${STAGE_LABEL[stage]}${state ? ` · ${state}` : ''}`;
    const editing = ui.edit && ui.edit.kind === 'rename-node' && ui.edit.id === n.id;
    return h('li', { class: `node node--${stage}${due ? ' node--due' : ''}` },
      h('span', { class: 'stage-mark', 'aria-hidden': 'true' }, GLYPH[stage]),
      h('div', { class: 'node-body' },
        editing ? editRow(n, 'rename-node') : h('p', { class: 'node-title' }, n.title),
        !editing && h('p', { class: 'muted small' }, label)),
      !editing && h('div', { class: 'node-actions' },
        stage === 'new'
          ? h('button', { type: 'button', class: 'btn btn--small btn--primary', onclick: () => store.learn(n.id), 'aria-label': `Learned: ${n.title}` }, 'Learned')
          : h('button', { type: 'button', class: `btn btn--small${due ? ' btn--primary' : ''}`, onclick: () => reviewTopic(n), 'aria-label': `Reviewed: ${n.title}` }, 'Reviewed'),
        h('button', {
          type: 'button', class: 'btn btn--small btn--quiet', 'aria-label': `Add to today: ${n.title}`,
          onclick: () => { store.addTask({ title: n.title, estimateMin: DEFAULT_ESTIMATE_MIN, nodeId: n.id, kind: 'study' }); toast('Added to today.'); },
        }, 'Today'),
        h('details', { class: 'menu' },
          h('summary', { 'aria-label': `More for ${n.title}` }, '⋯'),
          h('div', { class: 'menu-items' },
            n.learnedOn && h('button', { type: 'button', onclick: () => store.unlearn(n.id) }, 'Undo learned'),
            h('button', { type: 'button', onclick: () => { ui.edit = { kind: 'rename-node', id: n.id }; render(); } }, 'Rename'),
            h('button', { type: 'button', class: 'danger', onclick: () => { if (win.confirm(`Delete “${n.title}”?`)) store.deleteNode(n.id); } }, 'Delete')))));
  }

  // ---------- Close the day ----------
  function closeView() {
    const day = store.today();
    const tasks = liveTasksOn(store.doc, day);
    const done = tasks.filter((t) => t.status === 'done').length;
    const open = tasks.length - done;
    const existing = store.doc.days.find((d) => d.id === day && !d.deletedAt);
    if (!ui.close) ui.close = { outcome: existing?.outcome ?? null, tomorrow: existing?.tomorrow ?? '', reasons: existing?.reasons ?? [] };
    const draft = ui.close;
    const outcomes = [['yes', 'Did what I planned'], ['partly', 'Some of it'], ['no', 'Not really']];
    const reasonsOn = draft.outcome && draft.outcome !== 'yes';

    return h('div', { class: 'screen' },
      h('header', { class: 'screen-head' },
        h('h1', { class: 'h-page' }, 'Close the day'),
        h('p', { class: 'muted' }, `${plural(done, 'task')} done${open ? `, ${open} still open` : ''}. Open tasks move to tomorrow on their own.`)),
      h('fieldset', { class: 'stack-s' },
        h('legend', { class: 'label' }, 'How did the day go?'),
        h('div', { class: 'choice-row' }, outcomes.map(([k, label]) => h('button', {
          type: 'button', class: `choice${draft.outcome === k ? ' choice--on' : ''}`, 'aria-pressed': draft.outcome === k ? 'true' : 'false',
          onclick: () => { draft.outcome = k; render(); },
        }, label)))),
      reasonsOn && h('fieldset', { class: 'stack-s' },
        h('legend', { class: 'label' }, 'What got in the way? (optional)'),
        h('div', { class: 'chips' }, REASONS.map(([k, label]) => h('button', {
          type: 'button', class: `chip${draft.reasons.includes(k) ? ' chip--on' : ''}`, 'aria-pressed': draft.reasons.includes(k) ? 'true' : 'false',
          onclick: () => { draft.reasons = draft.reasons.includes(k) ? draft.reasons.filter((x) => x !== k) : [...draft.reasons, k]; render(); },
        }, label)))),
      h('label', { class: 'field' }, h('span', null, 'First step tomorrow (optional)'),
        h('input', { id: 'tomorrow', type: 'text', maxlength: 200, placeholder: 'e.g. Newton’s second law, 25m', value: draft.tomorrow, onchange: (e) => { draft.tomorrow = e.target.value; } })),
      h('div', { class: 'btn-row' },
        h('button', {
          type: 'button', class: 'btn btn--primary btn--big', disabled: !draft.outcome,
          onclick: () => {
            const value = root.getElementById('tomorrow')?.value ?? draft.tomorrow;
            if (!store.closeDay(day, { outcome: draft.outcome, tomorrow: value, reasons: draft.reasons })) return;
            ui.close = null;
            toast('Day closed. See you tomorrow.');
            win.location.hash = '#/today';
          },
        }, existing?.closedAt ? 'Update the day' : 'Close the day')),
      existing?.closedAt && h('p', { class: 'muted small' }, 'Today is already closed. Saving again changes the record.'));
  }

  // ---------- Progress ----------
  function progressView() {
    const doc = store.doc;
    const now = store.now();
    const week = weekSummary(doc, store.today(), now);
    const days = lastSevenDays(store.today());
    const reasons = new Map();
    for (const d of doc.days) if (!d.deletedAt && days.includes(d.id) && d.closedAt) for (const r of d.reasons || []) reasons.set(r, (reasons.get(r) || 0) + 1);
    const tracks = liveTracks(doc);
    return h('div', { class: 'screen' },
      h('header', { class: 'screen-head' },
        h('h1', { class: 'h-page' }, 'Progress'),
        h('p', { class: 'muted' }, 'The last seven days. These figures describe what happened. They are not a score.')),
      h('section', { class: 'panel stats' },
        stat(`${week.closedDays} of 7`, 'days closed'),
        stat(String(week.doneTasks), 'tasks finished'),
        stat(formatMinutes(week.minutes), 'time tracked')),
      h('section', { class: 'panel' },
        h('h2', { class: 'label' }, 'How the days went'),
        h('p', null, `Did what I planned: ${week.outcomes.yes} · Some: ${week.outcomes.partly} · Not really: ${week.outcomes.no}`)),
      reasons.size ? h('section', { class: 'panel' },
        h('h2', { class: 'label' }, 'What got in the way'),
        h('ul', { class: 'plain' }, [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => h('li', null, `${REASONS.find((r) => r[0] === k)?.[1] ?? k}: ${n}`)))) : null,
      h('section', { class: 'stack' },
        h('h2', { class: 'label' }, 'Tracks'),
        tracks.length === 0 && h('p', { class: 'muted' }, 'No tracks yet.'),
        tracks.map((t) => {
          const p = trackProgress(doc, t.id, store.today());
          return h('div', { class: 'panel track-card' },
            h('p', { class: 'track-name' }, t.name),
            h('p', { class: 'muted small' }, `${p.learned} of ${p.total} learned · ${p.mastered} mastered · ${p.due} due now`),
            h('div', { class: 'bar', role: 'img', 'aria-label': `${p.percent}% learned` }, h('div', { class: 'bar-fill', style: { width: `${p.percent}%` } })));
        })));
  }

  const stat = (value, label) => h('div', { class: 'stat' }, h('p', { class: 'stat-value' }, value), h('p', { class: 'muted small' }, label));

  // ---------- More: sync, backup, settings ----------
  function moreView() {
    const restore = ui.restore;
    return h('div', { class: 'screen' },
      h('header', { class: 'screen-head' }, h('h1', { class: 'h-page' }, 'More')),
      h('section', { class: 'panel stack' },
        h('h2', { class: 'label' }, 'Account and sync'),
        accountBody()),
      h('section', { class: 'panel stack' },
        h('h2', { class: 'label' }, 'Backup'),
        h('p', { class: 'muted small' }, 'A backup is a single file with everything. Keep one somewhere safe now and then.'),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', onclick: () => downloadBackup() }, 'Download backup')),
        h('label', { class: 'field' }, h('span', null, 'Restore from a backup file'),
          h('input', { id: 'restore-file', type: 'file', accept: 'application/json,.json', onchange: (e) => readRestore(e.target.files?.[0]) })),
        restore && h('div', { class: 'notice-block' },
          h('p', null, `${restore.summary}. Choose what to do with it:`),
          h('div', { class: 'btn-row' },
            h('button', { type: 'button', class: 'btn btn--primary', onclick: () => { store.mergeIn(restore.doc); ui.restore = null; toast('Backup merged in.'); } }, 'Merge with what is here'),
            h('button', { type: 'button', class: 'btn btn--danger', onclick: () => { if (win.confirm('Replace everything on this device with the backup file?')) { store.replaceAll(restore.doc); ui.restore = null; toast('Backup restored.'); } } }, 'Replace everything'),
            h('button', { type: 'button', class: 'btn btn--quiet', onclick: () => { ui.restore = null; render(); } }, 'Cancel')))),
      h('section', { class: 'panel stack' },
        h('h2', { class: 'label' }, 'Keyboard'),
        h('ul', { class: 'plain small' },
          h('li', null, h('kbd', null, 'n'), ' new task'),
          h('li', null, h('kbd', null, 't'), ' Today · ', h('kbd', null, 'k'), ' Tracks · ', h('kbd', null, 'c'), ' Close day · ', h('kbd', null, 'p'), ' Progress · ', h('kbd', null, 'm'), ' More'),
          h('li', null, h('kbd', null, 'Esc'), ' close a menu or cancel an edit'))),
      h('section', { class: 'panel stack' },
        h('h2', { class: 'label' }, 'Erase'),
        h('p', { class: 'muted small' }, 'Deletes everything in this browser. Copies already saved to the cloud stay there until you erase them from a signed-in device.'),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn btn--danger', onclick: () => {
          if (win.prompt('Type ERASE to delete everything in this browser.') === 'ERASE') { store.eraseAll(); toast('Erased from this browser.'); }
        } }, 'Erase this browser’s data'))));
  }

  function downloadBackup() {
    const text = JSON.stringify(store.snapshot(), null, 2);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = h('a', { href: url, download: `apex-backup-${store.today()}.json` });
    root.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Backup downloaded.');
  }

  async function readRestore(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const v = validateDoc(parsed);
      if (!v.ok) { toast(v.errors[0]); return; }
      const normalized = normalizeDoc(parsed, new Date(store.now()).toISOString());
      const tasks = normalized.tasks.filter((t) => !t.deletedAt).length;
      const topics = normalized.nodes.filter((n) => !n.deletedAt).length;
      ui.restore = { doc: normalized, summary: `The file holds ${plural(tasks, 'task')} and ${plural(topics, 'topic')}` };
      render();
    } catch {
      toast('That file is not a valid APEX backup.');
    }
  }

  // ---------- account, sync and calendar ----------
  // Sign-in and the database come from Firebase (loaded only when configured). The data itself is always kept on
  // this device first; sync only adds the cloud copy. The Calendar token lives in memory: Google does not give
  // one to a browser app that can be renewed silently, so after a reload the person taps "Connect" again.
  const acct = {
    backend: null, loading: false, user: null, engine: null, calendar: null, calendarToken: null,
    calendarOn: readLS('apex2:calendarOff') !== '1', calendarRunning: false,
    status: { state: 'off', message: '' }, calMessage: '',
  };
  let calendarTimer = null;

  function accountBody() {
    if (!isFirebaseConfigured()) {
      return h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Sign-in and sync are not set up yet. Everything works on this device without them. To turn sync on, follow docs/FIREBASE_SETUP.md and paste your Firebase settings into js/firebase-config.js.'));
    }
    const u = acct.user;
    return h('div', { class: 'stack' },
      u
        ? h('p', null, `Signed in as ${u.email || u.name || 'your Google account'}.`)
        : h('p', { class: 'muted' }, 'Sign in with Google to keep your data in step across your phone and laptop. Without signing in, data stays on this device.'),
      h('p', { class: 'small', id: 'sync-status', role: 'status' }, acct.status.message),
      h('div', { class: 'btn-row' },
        !u && h('button', { type: 'button', class: 'btn btn--primary', onclick: () => signIn() }, 'Sign in with Google'),
        u && h('button', { type: 'button', class: 'btn', onclick: () => signOutNow() }, 'Sign out')),
      h('label', { class: 'field field--inline' },
        h('input', { type: 'checkbox', checked: acct.calendarOn, onchange: (e) => setCalendarOn(e.target.checked) }),
        h('span', null, 'Put each topic’s review date in my Google Calendar as an all-day event with a reminder')),
      u && acct.calendarOn && h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn', onclick: () => signIn() }, acct.calendarToken ? 'Refresh calendar access' : 'Connect Google Calendar')),
      acct.calMessage && h('p', { class: 'small', role: 'status' }, acct.calMessage));
  }

  async function loadBackend() {
    if (acct.backend || acct.loading || !isFirebaseConfigured()) return acct.backend;
    acct.loading = true;
    try {
      const mod = await import('./backend.js');
      acct.backend = await mod.createFirebaseBackend(FIREBASE_CONFIG);
      acct.backend.onUser(onUserChanged);
    } catch {
      acct.status = { state: 'error', message: 'Could not load sign-in. Check your connection; data stays on this device.' };
      scheduleRender();
    } finally {
      acct.loading = false;
    }
    return acct.backend;
  }

  function onUserChanged(user) {
    if (!user) {
      acct.user = null;
      acct.calendarToken = null;
      acct.engine?.stop();
      acct.status = { state: 'off', message: 'Signed out. Data stays on this device.' };
      scheduleRender();
      return;
    }
    acct.user = user;
    if (!acct.engine) {
      acct.engine = createSyncEngine({
        backend: acct.backend,
        store,
        onStatus: (s) => { acct.status = s; scheduleRender(); },
      });
    }
    acct.engine.start(user.uid);
    acct.calendar = createCalendar({ getToken: () => acct.calendarToken });
    scheduleRender();
    scheduleCalendar(2000);
  }

  async function signIn() {
    const backend = await loadBackend();
    if (!backend) { toast('Sign-in is not available right now.'); return; }
    acct.calMessage = '';
    try {
      const res = await backend.signIn();
      acct.calendarToken = res.calendarToken || null;
      acct.calMessage = acct.calendarToken
        ? 'Calendar access granted. It lasts about an hour, then tap Refresh.'
        : 'Google did not grant calendar access, so review dates were not added. Tap Refresh and tick the calendar box on Google’s screen.';
      scheduleCalendar(500);
    } catch (e) {
      const cancelled = e?.code === 'auth/popup-closed-by-user' || e?.code === 'auth/cancelled-popup-request';
      acct.calMessage = cancelled ? 'Sign-in was cancelled.' : 'Sign-in failed. Try again. Data stays on this device.';
    }
    scheduleRender();
  }

  async function signOutNow() {
    try {
      await acct.backend?.signOut();
    } catch {
      acct.calMessage = 'Sign-out failed. Try again.';
      scheduleRender();
    }
  }

  function setCalendarOn(on) {
    acct.calendarOn = on;
    writeLS('apex2:calendarOff', on ? '' : '1');
    acct.calMessage = on
      ? ''
      : 'Review dates will no longer be added. Events already in your calendar stay until you delete them there.';
    if (on) scheduleCalendar(500);
    scheduleRender();
  }

  function scheduleCalendar(ms = 5000) {
    clearTimeout(calendarTimer);
    calendarTimer = setTimeout(reconcileCalendar, ms);
  }

  async function reconcileCalendar() {
    if (!acct.calendarOn || !acct.user || acct.calendarRunning) return;
    if (!acct.calendarToken) {
      acct.calMessage = 'Tap “Connect Google Calendar” to add review dates. Everything else works without it.';
      scheduleRender();
      return;
    }
    acct.calendarRunning = true;
    try {
      const s = await acct.calendar.reconcile(store.doc, store);
      const parts = [];
      if (s.created) parts.push(`${s.created} added`);
      if (s.moved) parts.push(`${s.moved} moved`);
      if (s.removed) parts.push(`${s.removed} removed`);
      if (s.failed) parts.push(`${s.failed} not updated yet`);
      acct.calMessage = parts.length ? `Google Calendar: ${parts.join(', ')}.` : 'Google Calendar is up to date.';
      if (s.failed) scheduleCalendar(60000);
    } catch (e) {
      if (e instanceof CalendarAuthError) {
        acct.calendarToken = null;
        acct.calMessage = 'Google Calendar needs reconnecting. Tap “Connect Google Calendar”.';
      } else {
        acct.calMessage = 'Google Calendar could not be updated. It will be retried.';
        scheduleCalendar(60000);
      }
    } finally {
      acct.calendarRunning = false;
      scheduleRender();
    }
  }

  // ---------- keyboard ----------
  root.addEventListener('keydown', (e) => {
    const typing = e.target.matches?.('input, textarea, select');
    if (e.key === 'Escape') {
      for (const d of root.querySelectorAll('details[open]')) d.open = false;
      if (ui.edit) { ui.edit = null; render(); }
      if (typing) e.target.blur();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const go = { t: 'today', k: 'tracks', c: 'close', p: 'progress', m: 'more' }[e.key.toLowerCase()];
    if (go) { e.preventDefault(); win.location.hash = `#/${go}`; return; }
    if (e.key.toLowerCase() === 'n') {
      e.preventDefault();
      if (route().name !== 'today') win.location.hash = '#/today';
      queueMicrotask(() => root.getElementById('quick')?.focus());
    }
  });

  // ---------- other tabs and devices ----------
  win.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      const parsed = JSON.parse(e.newValue);
      if (validateDoc(parsed).ok) store.mergeIn(parsed);
    } catch { /* a half-written value: ignore it */ }
  });
  win.addEventListener('hashchange', () => { ui.edit = null; scheduleRender(); });

  // ---------- boot ----------
  store.subscribe(() => {
    scheduleCalendar();
    scheduleRender();
  });

  let lastDay = store.today();
  store.rollToToday();
  setInterval(() => {
    const t = store.today();
    if (t !== lastDay) { lastDay = t; ui.close = null; store.rollToToday(); }
    scheduleRender();
  }, 30000);
  setInterval(() => {
    for (const el of root.querySelectorAll('[data-clock]')) {
      const task = store.doc.tasks.find((x) => x.id === el.dataset.clock);
      if (task && isRunning(task)) el.firstChild.textContent = formatClock(minutesOf(task, store.now()) * 60000);
    }
  }, 1000);
  // Changes from other devices arrive live. Coming back online or to the app re-sends anything that failed.
  win.addEventListener('online', () => { acct.engine?.pushPending(); scheduleCalendar(1000); });
  root.addEventListener('visibilitychange', () => { if (!root.hidden) acct.engine?.pushPending(); });

  loadBackend();
  win.navigator?.storage?.persist?.().catch(() => {});
  scheduleRender();

  return { store, render: scheduleRender };
}
