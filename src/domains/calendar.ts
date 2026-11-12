/**
 * Calendar over the gateway. Calendars come from the legacy `calendars.*` requests; events go
 * through the commands the calendar web app uses, which the cmd map lacks (it was extracted from
 * the messenger client only), so they are called by number with their `calendarweb` types:
 *
 * | Command | Number |
 * |---|---|
 * | WEB_LIST_CALENDAR_EVENTS | 1002001 |
 * | WEB_CREATE_EVENT | 1002003 |
 * | WEB_UPDATE_EVENT | 1002004 |
 * | WEB_DELETE_EVENT | 1002005 |
 * | WEB_MGET_EVENTS_WITH_IDS | 1002006 |
 *
 * Numbers are from the calendar web app's command table (its `sdk.*.js`); the `calendar.v1.*`
 * numbers in the same app (SaveEvent 3101 ...) answer "command not found". Tested on a Feishu
 * account on 2026-11-10 with events created for the test in the primary calendar and deleted
 * afterwards. A new event needs a numeric id chosen by the client; times are in seconds. Listing
 * over a range much longer than 90 days never ends (every page is empty and carries another page
 * token), so ranges are listed in 90-day windows. Listings leave out descriptions; fetching by id
 * returns the whole event, so updates (which send the whole event back) start from that.
 *
 * Search and free/busy (2026-11-13, both accounts, checked on events created for the test): event
 * search is the web app's SEARCH_CALENDAR_EVENT (1010036, `calendarevents.SearchCalendarEventRequest`;
 * the advanced scene takes a time range, the event key comes back as `uid`). Whether people are
 * busy over a range is `calendarevents.GetBusyUserRequest` on their primary calendars (an empty
 * answer means nobody is busy), which WEB_GET_USER_ATTENDEES_BY_USER_IDS (1002008) maps user ids
 * to. It answers busy or free for the whole range, not the busy intervals.
 */
import type { LarkClient } from '../client.js';
import { authorize, guardMethods, type Permission } from '../permissions.js';
import type { Dict } from '../proto/dict.js';

const CMD = {
  list: 1002001,
  create: 1002003,
  update: 1002004,
  delete: 1002005,
  mget: 1002006,
  userCalendars: 1002008,
  search: 1010036,
};
// calendarevents.SearchCalendarEventRequest.EventSearchScene.ADVANCED_SEARCH (takes a time range)
const SEARCH_ADVANCED = 2;
const WINDOW_MS = 90 * 86_400_000;
// entities.CalendarEvent: Source.WEB, SelfAttendeeStatus.ACCEPT (organizer),
// NotificationType.NO_NOTIFICATION
const SOURCE_WEB = 1;
const SELF_ACCEPTED = 2;
const NO_NOTIFICATION = 2;

export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
  timezone: string;
}

export interface CalendarEvent {
  /** What update and delete take (with originalTime for recurring instances). */
  key: string;
  id: string;
  calendarId: string;
  /** For an instance of a recurring event, its original start (s); 0 otherwise. */
  originalTime: number;
  summary: string;
  description: string;
  /** Start and end (ms). */
  start: number;
  end: number;
  allDay: boolean;
  timezone: string;
  location: string;
  /** Recurrence rule (RFC 5545 RRULE), empty for a single event. */
  rrule: string;
  organizerCalendarId: string;
}

export interface NewEvent {
  summary: string;
  /** Start and end (ms). */
  start: number;
  end: number;
  description?: string | undefined;
  location?: string | undefined;
  allDay?: boolean | undefined;
  timezone?: string | undefined;
  /** Calendar to create in; the primary calendar when omitted. */
  calendarId?: string | undefined;
}

/** An event found by search. */
export interface EventHit {
  /** What get, update and delete take (with originalTime for recurring instances). */
  key: string;
  calendarId: string;
  originalTime: number;
  summary: string;
  description: string;
  /** Start and end (ms) of this occurrence. */
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  /** Organizer's display name. */
  organizer: string;
}

/** Fields to change; the rest stay as they are. */
export interface EventUpdate {
  summary?: string | undefined;
  start?: number | undefined;
  end?: number | undefined;
  description?: string | undefined;
  location?: string | undefined;
  allDay?: boolean | undefined;
  timezone?: string | undefined;
}

const CALENDAR_PERMISSIONS: { [K in keyof Calendar]?: Permission } = {
  primary: 'cal.calendars',
  calendars: 'cal.calendars',
  events: 'cal.agenda',
  get: 'cal.agenda',
  search: 'cal.search',
  busy: 'cal.busy',
  create: 'cal.create',
  update: 'cal.update',
  delete: 'cal.delete',
};

const num = (v: unknown) => (v === undefined || v === null ? 0 : Number(v as number | bigint));
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** A client-chosen event id: the server takes a positive int64. */
const newEventId = () =>
  String(BigInt.asUintN(62, BigInt(`0x${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`)));

/** A decoded message back into JSON form (int64 as strings, bytes as base64) to send it again. */
function jsonable(v: unknown): unknown {
  if (typeof v === 'bigint') return String(v);
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (Array.isArray(v)) return v.map(jsonable);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonable(x)]));
  return v;
}

export function toEvent(e: Dict): CalendarEvent {
  const location = ((e.locations ?? []) as Dict[])[0];
  return {
    key: String(e.key ?? ''),
    id: String(e.id ?? ''),
    calendarId: String(e.calendarId ?? ''),
    originalTime: num(e.originalTime),
    summary: String(e.summary ?? ''),
    description: String(e.description ?? ''),
    start: num(e.startTime) * 1000,
    end: num(e.endTime) * 1000,
    allDay: e.isAllDay === true,
    timezone: String(e.startTimezone ?? ''),
    location: String(location?.name || location?.address || ''),
    rrule: String(e.rrule ?? ''),
    organizerCalendarId: String(e.organizerCalendarId ?? ''),
  };
}

/**
 * Calendars and events of the logged-in account. Permission checks follow the client's: with
 * `LarkClient.create(auth, { permissions })`, each method is checked as `cal.<action>`.
 */
export class Calendar {
  constructor(readonly client: LarkClient) {
    const source = client.permissionSource;
    if (source) guardMethods(this, CALENDAR_PERMISSIONS, (p) => authorize(client.auth, source, p));
  }

  async primary(): Promise<CalendarInfo> {
    const resp = await this.client.api('calendars.GetUserPrimaryCalendarRequest', {});
    const c = (resp.calendar ?? {}) as Dict;
    if (!c.id) throw new Error('拿不到主日历');
    return {
      id: String(c.id),
      name: String(c.summary ?? ''),
      primary: true,
      timezone: String(c.defaultTimezone ?? ''),
    };
  }

  /** Calendars I own or subscribe to. */
  async calendars(): Promise<CalendarInfo[]> {
    const resp = await this.client.api('calendars.ListCalendarListRequest', {});
    return ((resp.calendars ?? []) as Dict[]).map((c) => ({
      id: String(c.id),
      name: String(c.summary ?? ''),
      primary: c.isPrimary === true,
      timezone: String(c.defaultTimezone ?? ''),
    }));
  }

  /**
   * Events (recurring ones expanded into instances) overlapping [since, until) in ms, in start
   * order; the primary calendar unless calendarIds are given.
   */
  async events(o: {
    since: number;
    until: number;
    calendarIds?: string[] | undefined;
    limit?: number;
  }): Promise<CalendarEvent[]> {
    const ids = o.calendarIds?.length ? o.calendarIds : [(await this.primary()).id];
    const out: CalendarEvent[] = [];
    for (const id of ids)
      for (const e of await this.listRaw(id, o.since, o.until)) out.push(toEvent(e));
    return out.sort((a, b) => a.start - b.start).slice(0, o.limit ?? 500);
  }

  /** Raw events of one calendar in [since, until) ms, listed in 90-day windows. */
  private async listRaw(calendarId: string, since: number, until: number): Promise<Dict[]> {
    const out = new Map<string, Dict>();
    for (let from = since; from < until; from += WINDOW_MS)
      for (const e of await this.listWindow(calendarId, from, Math.min(until, from + WINDOW_MS)))
        out.set(`${String(e.key)}:${String(e.originalTime ?? 0)}:${String(e.startTime ?? 0)}`, e);
    return [...out.values()];
  }

  private async listWindow(calendarId: string, since: number, until: number): Promise<Dict[]> {
    const out: Dict[] = [];
    let pageToken = '';
    for (let page = 0; page < 20; page++) {
      const resp = await this.client.command(
        CMD.list,
        'calendarweb.ListCalendarEventsRequest',
        {
          params: [
            {
              calendarId,
              timeMin: String(Math.floor(since / 1000)),
              timeMax: String(Math.floor(until / 1000)),
              pageSize: 100,
              ...(pageToken ? { pageToken } : {}),
            },
          ],
        },
        'calendarweb.ListCalendarEventsResponse',
      );
      const result = ((resp.results ?? {}) as Record<string, Dict>)[calendarId] ?? {};
      for (const e of (result.calendarEvents ?? []) as Dict[])
        if (e.isDeleted !== true) out.push(e);
      pageToken = String(result.nextPageToken ?? '');
      if (!pageToken) break;
    }
    return out;
  }

  /** One event by key, with its description; searched within a year of now. */
  async get(key: string, o: { calendarId?: string } = {}): Promise<CalendarEvent | null> {
    try {
      return toEvent(await this.raw(key, o.calendarId));
    } catch {
      return null;
    }
  }

  /** Create an event (without attendees, so nobody is notified); returns it as listed. */
  async create(e: NewEvent): Promise<CalendarEvent> {
    const calendarId = e.calendarId ?? (await this.primary()).id;
    const tz = e.timezone ?? localZone();
    await this.client.command(CMD.create, 'calendarweb.CreateEventRequest', {
      event: {
        id: newEventId(),
        calendarId,
        creatorCalendarId: calendarId,
        organizerCalendarId: calendarId,
        summary: e.summary,
        description: e.description ?? '',
        startTime: String(Math.floor(e.start / 1000)),
        endTime: String(Math.floor(e.end / 1000)),
        startTimezone: tz,
        endTimezone: tz,
        isAllDay: e.allDay === true,
        ...(e.location ? { locations: [{ name: e.location }] } : {}),
        source: SOURCE_WEB,
        selfAttendeeStatus: SELF_ACCEPTED,
      },
      notificationType: NO_NOTIFICATION,
    });
    // The reply carries no event: find it by its fields in its time range
    const found = (
      await this.events({ since: e.start, until: e.end + 1000, calendarIds: [calendarId] })
    ).find((x) => x.summary === e.summary && x.start === Math.floor(e.start / 1000) * 1000);
    if (!found) throw new Error('日程已提交,但没有在日历里找到它');
    return found;
  }

  /** Change an event (a single event, or this instance of a recurring one). */
  async update(key: string, u: EventUpdate, o: { calendarId?: string } = {}): Promise<void> {
    const current = await this.raw(key, o.calendarId);
    const tz = u.timezone ?? String(current.startTimezone ?? localZone());
    const event: Dict = {
      ...(jsonable(current) as Dict),
      ...(u.summary !== undefined ? { summary: u.summary } : {}),
      ...(u.description !== undefined ? { description: u.description } : {}),
      ...(u.start !== undefined ? { startTime: String(Math.floor(u.start / 1000)) } : {}),
      ...(u.end !== undefined ? { endTime: String(Math.floor(u.end / 1000)) } : {}),
      ...(u.allDay !== undefined ? { isAllDay: u.allDay } : {}),
      ...(u.location !== undefined ? { locations: u.location ? [{ name: u.location }] : [] } : {}),
      startTimezone: tz,
      endTimezone: tz,
    };
    await this.client.command(CMD.update, 'calendarweb.UpdateEventRequest', {
      event,
      // SaveSpan.THIS_EVENT
      span: 1,
      notificationType: NO_NOTIFICATION,
    });
  }

  /** Delete an event (or this instance of a recurring one). */
  async delete(key: string, o: { calendarId?: string; originalTime?: number } = {}): Promise<void> {
    const calendarId = o.calendarId ?? (await this.primary()).id;
    await this.client.command(CMD.delete, 'calendarweb.DeleteEventRequest', {
      calendarId,
      key,
      originalTime: String(o.originalTime ?? 0),
      // SaveSpan.NONE_SPAN: the whole event
      span: 0,
      notificationType: NO_NOTIFICATION,
    });
  }

  /**
   * Events I can see whose summary, description, location or attendees match query, optionally
   * only those overlapping [since, until) (ms); in the server's order (by start time).
   */
  async search(query: string, o: { since?: number; until?: number } = {}): Promise<EventHit[]> {
    const sec = (ms: number | undefined) =>
      ms === undefined ? undefined : String(Math.floor(ms / 1000));
    const resp = await this.client.command(
      CMD.search,
      'calendarevents.SearchCalendarEventRequest',
      {
        query,
        eventSearchScene: SEARCH_ADVANCED,
        eventFilter: {
          ...(o.since !== undefined ? { startTime: sec(o.since) } : {}),
          ...(o.until !== undefined ? { endTime: sec(o.until) } : {}),
        },
        localeIdentifier: 'zh_CN',
      },
      'calendarevents.SearchCalendarEventResponse',
    );
    const contents = (resp.contents ?? {}) as Record<string, Dict>;
    return ((resp.instances ?? []) as Dict[]).flatMap((i) => {
      const c = contents[String(i.eventRefId)];
      if (!c) return [];
      return [
        {
          key: String(c.uid ?? ''),
          calendarId: String(c.calendarId ?? ''),
          originalTime: num(c.originalTime),
          summary: String(c.summary ?? ''),
          description: String(c.description ?? ''),
          start: num(i.startTime) * 1000,
          end: num(i.endTime) * 1000,
          allDay: c.isAllDay === true,
          location: String(c.location ?? ''),
          organizer: String(c.organizer ?? ''),
        },
      ];
    });
  }

  /**
   * Whether each user (by user id) has something on their primary calendar during [since, until)
   * (ms): true when busy at any point of it. Reads free/busy only, as the web app's scheduling
   * view does; users whose calendar cannot be found are left out.
   */
  async busy(userIds: string[], since: number, until: number): Promise<Record<string, boolean>> {
    if (!userIds.length) return {};
    const resp = await this.client.command(
      CMD.userCalendars,
      'calendarweb.GetUserAttendeesByUserIdsRequest',
      { userIds },
      'calendarweb.GetUserAttendeesByUserIdsResponse',
    );
    const calendarOf = new Map<string, string>();
    for (const [userId, a] of Object.entries((resp.userAttendees ?? {}) as Record<string, Dict>))
      if (a.attendeeCalendarId) calendarOf.set(userId, String(a.attendeeCalendarId));
    if (!calendarOf.size) return {};
    const busy = await this.client.api('calendarevents.GetBusyUserRequest', {
      calendarIds: [...calendarOf.values()],
      startTime: String(Math.floor(since / 1000)),
      endTime: String(Math.ceil(until / 1000)),
    });
    const map = (busy.calendarBusyMap ?? {}) as Record<string, boolean>;
    return Object.fromEntries(
      userIds
        .filter((u) => calendarOf.has(u))
        .map((u) => [u, map[calendarOf.get(u) as string] === true]),
    );
  }

  /** The whole event (with description) by its id; the listed form when that fails. */
  private async full(listed: Dict): Promise<Dict> {
    const resp = await this.client.command(
      CMD.mget,
      'calendarweb.MGetEventsWithIdsRequest',
      { ids: [String(listed.id)] },
      'calendarweb.MGetEventsWithIdsResponse',
    );
    return ((resp.events ?? {}) as Record<string, Dict>)[String(listed.id)] ?? listed;
  }

  /** The event as the server returns it, for updates that send the whole event back. */
  private async raw(key: string, calendarId?: string): Promise<Dict> {
    const id = calendarId ?? (await this.primary()).id;
    // Look outward from a window centred on now, a window at a time, up to a year either way
    const centre = Date.now() - WINDOW_MS / 2;
    const starts = [centre];
    for (let k = 1; k <= 4; k++) starts.push(centre + k * WINDOW_MS, centre - k * WINDOW_MS);
    for (const from of starts) {
      const e = (await this.listWindow(id, from, from + WINDOW_MS)).find(
        (x) => String(x.key) === key,
      );
      if (e) return this.full(e);
    }
    throw new Error(`找不到日程(只在前后一年内找): ${key}`);
  }
}
