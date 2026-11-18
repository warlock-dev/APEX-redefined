// Puts one all-day event per topic on the day its next review falls due, in the person's primary Google Calendar.
// Each event carries a small reminder. The event id is stored on the topic (calendarEventId) so the event is
// updated or removed rather than duplicated. Two devices that create an event before syncing can still
// produce a duplicate; the event title says "APEX review", so it is easy to delete by hand.

import { addDays } from './model.js';

export const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const REMINDER_MIN = 8 * 60; // the morning before, as a popup at 08:00 is not reliable for all-day events

export class CalendarAuthError extends Error {
  constructor(message = 'Google Calendar needs to be reconnected.') { super(message); this.name = 'CalendarAuthError'; }
}

function eventBody(node, track, date) {
  return {
    summary: `APEX review: ${node.title}${track ? ` (${track.name})` : ''}`,
    description: 'Created by APEX. Change the date in APEX, not here, or the next sync will move it back.',
    start: { date },
    end: { date: addDays(date, 1) },
    transparency: 'transparent',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: REMINDER_MIN }] },
    extendedProperties: { private: { apexNodeId: node.id } },
  };
}

/**
 * createCalendar({ getToken, fetchImpl })
 *  getToken(): returns the current OAuth access token for the calendar scope, or null if none is held.
 *  fetchImpl: fetch-compatible function (injected for tests).
 */
export function createCalendar({ getToken, fetchImpl = globalThis.fetch, base = CALENDAR_BASE }) {
  async function call(method, url, body) {
    const token = getToken();
    if (!token) throw new CalendarAuthError();
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 || res.status === 403) throw new CalendarAuthError();
    return res;
  }

  /** The date each topic should be on the calendar, or null if it should not be there. */
  function wanted(doc) {
    const tracks = new Map(doc.tracks.filter((t) => !t.deletedAt).map((t) => [t.id, t]));
    const out = new Map();
    for (const n of doc.nodes) {
      if (n.deletedAt || !n.learnedOn || !n.nextReviewOn) continue;
      const track = tracks.get(n.trackId);
      if (!track) continue;
      out.set(n.id, { node: n, track, date: n.nextReviewOn });
    }
    return out;
  }

  /**
   * Bring the calendar in line with the document. Returns a summary. Never throws for a single failed event;
   * throws CalendarAuthError when the token is missing or expired, so the caller can ask the person to reconnect.
   */
  async function reconcile(doc, store) {
    const summary = { created: 0, moved: 0, removed: 0, failed: 0 };
    const want = wanted(doc);

    for (const n of doc.nodes) {
      const w = want.get(n.id);
      if (w) continue;
      if (!n.calendarEventId) continue;
      try {
        const res = await call('DELETE', `${base}/${encodeURIComponent(n.calendarEventId)}`);
        if (res.ok || res.status === 404 || res.status === 410) {
          store.setCalendar(n.id, { calendarEventId: null, calendarOn: null });
          summary.removed += 1;
        } else summary.failed += 1;
      } catch (e) {
        if (e instanceof CalendarAuthError) throw e;
        summary.failed += 1;
      }
    }

    for (const [id, { node, track, date }] of want) {
      if (node.calendarEventId && node.calendarOn === date) continue;
      try {
        if (node.calendarEventId) {
          const res = await call('PATCH', `${base}/${encodeURIComponent(node.calendarEventId)}`, eventBody(node, track, date));
          if (res.ok) { store.setCalendar(id, { calendarEventId: node.calendarEventId, calendarOn: date }); summary.moved += 1; continue; }
          if (res.status !== 404 && res.status !== 410) { summary.failed += 1; continue; }
          // The event was deleted in Google Calendar: create it again below.
        }
        const res = await call('POST', base, eventBody(node, track, date));
        if (!res.ok) { summary.failed += 1; continue; }
        const created = await res.json();
        store.setCalendar(id, { calendarEventId: created.id, calendarOn: date });
        summary.created += 1;
      } catch (e) {
        if (e instanceof CalendarAuthError) throw e;
        summary.failed += 1;
      }
    }
    return summary;
  }

  return { reconcile, wanted };
}
