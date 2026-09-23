export const STORAGE_KEY = "deadline-buddy-state";
export const REMINDER_SCHEDULE_ID = "deadline-buddy-next-reminder";
export const HUD_REFRESH_SCHEDULE_ID = "deadline-buddy-hud-refresh";
export const CALENDAR_SYNC_SCHEDULE_ID = "deadline-buddy-calendar-sync";
export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
export const DEFAULT_REMINDER_OFFSETS = [60, 15, 0];
export const ALLOWED_REMINDER_OFFSETS = [1440, 60, 15, 0];
export const MAX_MANUAL_DEADLINES = 100;
export const MAX_TRACKED_EVENTS = 20;
export const MAX_ALERT_ATTEMPTS = 3;
export const MAX_SNOOZES_PER_ALERT = 3;
export const MAX_REMINDER_ROWS = 1_000;
export const MISSED_REMINDER_GRACE_MS = DAY_MS;

const REMINDER_STATES = new Set(["pending", "delivering", "shown", "uncertain", "dismissed", "failed"]);

export function cleanTitle(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\0-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || fallback;
}

export function localDateTimeToEpoch(date, time, timeZone) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)) return null;
  if (typeof timeZone !== "string" || !timeZone) return null;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const checkDate = new Date(wallAsUtc);
  if (checkDate.getUTCFullYear() !== year || checkDate.getUTCMonth() + 1 !== month || checkDate.getUTCDate() !== day || hour > 23 || minute > 59) return null;

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }

  const offsets = new Set();
  for (let delta = -36 * 60; delta <= 36 * 60; delta += 6 * 60) {
    const instant = wallAsUtc + delta * MINUTE_MS;
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const representedWall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    offsets.add(representedWall - instant);
  }

  const candidates = [...offsets]
    .map((offset) => wallAsUtc - offset)
    .filter((instant) => {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
      return Number(parts.year) === year && Number(parts.month) === month && Number(parts.day) === day && Number(parts.hour) === hour && Number(parts.minute) === minute;
    })
    .sort((left, right) => left - right);
  // During a fall-back overlap, consistently choose the earlier instant.
  return candidates[0] ?? null;
}

export function reminderOffsets(config = {}) {
  const configured = config.reminderOffsets;
  if (!Array.isArray(configured)) return [...DEFAULT_REMINDER_OFFSETS];
  return [...new Set(configured.map(Number).filter((value) => ALLOWED_REMINDER_OFFSETS.includes(value)))].sort((left, right) => right - left);
}

export function formatRemaining(dueAt, now = Date.now()) {
  const delta = dueAt - now;
  if (delta === 0) return "now";
  const overdue = delta < 0;
  const minutes = Math.max(1, Math.ceil(Math.abs(delta) / MINUTE_MS));
  if (minutes < 60) return `${minutes}m${overdue ? " ago" : ""}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours}h${overdue ? " ago" : ""}`;
  return `${Math.ceil(hours / 24)}d${overdue ? " ago" : ""}`;
}

export function validProvider(value) {
  return value === "google" || value === "outlook";
}

export function normalizeState(value) {
  const source = isRecord(value) ? value : {};
  const manual = arrayOrEmpty(source.manual).flatMap((item) => {
    if (!isRecord(item) || !validId(item.id) || !Number.isFinite(item.dueAt) || !Number.isFinite(item.createdAt)) return [];
    const title = cleanTitle(item.title);
    return title ? [{ id: item.id, title, dueAt: item.dueAt, createdAt: item.createdAt }] : [];
  }).slice(0, MAX_MANUAL_DEADLINES);
  const calendars = arrayOrEmpty(source.calendars).flatMap((item) => {
    if (!isRecord(item) || !validProvider(item.provider) || !validId(item.id) || typeof item.name !== "string") return [];
    return [{ provider: item.provider, id: item.id, name: cleanTitle(item.name, "Calendar"), ...(validZone(item.timeZone) ? { timeZone: item.timeZone } : {}), ...(typeof item.primary === "boolean" ? { primary: item.primary } : {}) }];
  }).slice(0, 600);
  const events = arrayOrEmpty(source.events).flatMap((item) => {
    if (!isRecord(item) || !validProvider(item.provider) || !validId(item.calendarId) || !validId(item.eventId) || !Number.isFinite(item.trackedAt)) return [];
    const event = normalizeCalendarEvent(item.event, item.trackedAt);
    return event ? [{ provider: item.provider, calendarId: item.calendarId, eventId: item.eventId, trackedAt: item.trackedAt, ...(validZone(item.calendarTimeZone) ? { calendarTimeZone: item.calendarTimeZone } : {}), event }] : [];
  }).slice(0, MAX_TRACKED_EVENTS);
  const reminders = arrayOrEmpty(source.reminders).flatMap((item) => {
    if (!isRecord(item) || !validId(item.key) || !validId(item.sourceKey) || !Number.isFinite(item.dueAt) || !REMINDER_STATES.has(item.state)) return [];
    const attempts = boundedInteger(item.attempts, 0, MAX_ALERT_ATTEMPTS);
    const snoozeCount = boundedInteger(item.snoozeCount, 0, MAX_SNOOZES_PER_ALERT);
    return [{
      key: item.key,
      sourceKey: item.sourceKey,
      sourceKind: item.sourceKind === "calendar" ? "calendar" : "manual",
      sourceId: validId(item.sourceId) ? item.sourceId : item.sourceKey,
      dueAt: item.dueAt,
      offsetMinutes: Number.isInteger(item.offsetMinutes) ? item.offsetMinutes : 0,
      state: item.state,
      attempts,
      snoozeCount,
      ...(Number.isFinite(item.retryAt) ? { retryAt: item.retryAt } : {}),
      ...(Number.isFinite(item.shownAt) ? { shownAt: item.shownAt } : {}),
      ...(validId(item.parentKey) ? { parentKey: item.parentKey } : {}),
    }];
  }).slice(-MAX_REMINDER_ROWS);
  const reminderKeys = new Set(reminders.filter((item) => item.state === "shown" || item.state === "uncertain" || item.state === "delivering").map((item) => item.key));
  const activeAlertKeys = arrayOrEmpty(source.activeAlertKeys).filter((key) => typeof key === "string" && reminderKeys.has(key)).slice(-MAX_REMINDER_ROWS);
  const connectionStates = {};
  for (const provider of ["google", "outlook"]) {
    const status = isRecord(source.connectionStates) ? source.connectionStates[provider] : undefined;
    connectionStates[provider] = ["not_connected", "pending", "connected", "reauth_required", "offline"].includes(status) ? status : "not_connected";
  }
  return {
    version: 1,
    sequence: boundedInteger(source.sequence, 0, Number.MAX_SAFE_INTEGER),
    manual,
    calendars,
    events,
    reminders,
    activeAlertKeys,
    connectionStates,
    offline: source.offline === true,
  };
}

export function planReminders(state, now = Date.now(), offsets = DEFAULT_REMINDER_OFFSETS) {
  const sources = deadlineSources(state).filter((source) => source.kind !== "calendar" || source.endAt > now);
  const existing = new Map(state.reminders.map((item) => [item.key, item]));
  const expected = [];
  for (const source of sources) {
    const sourceOffsets = offsets.length ? [...offsets] : [];
    if (!sourceOffsets.length) continue;
    const candidates = sourceOffsets.map((offsetMinutes) => ({
      key: makeReminderKey(source.key, source.dueAt, offsetMinutes),
      sourceKey: source.key,
      sourceKind: source.kind,
      sourceId: source.id,
      dueAt: source.dueAt - offsetMinutes * MINUTE_MS,
      offsetMinutes,
    }));
    const upcoming = candidates.filter((item) => item.dueAt > now);
    const selected = upcoming.length ? upcoming : candidates.filter((item) => item.offsetMinutes === Math.min(...sourceOffsets));
    for (const candidate of selected) {
      if (candidate.dueAt <= now - MISSED_REMINDER_GRACE_MS) continue;
      const previous = existing.get(candidate.key);
      expected.push(previous ? { ...candidate, ...previous } : { ...candidate, state: "pending", attempts: 0, snoozeCount: 0 });
    }
  }

  const expectedKeys = new Set(expected.map((item) => item.key));
  const activeSourceKeys = new Set(sources.map((source) => source.key));
  const snoozes = state.reminders.filter((item) => item.parentKey && activeSourceKeys.has(item.sourceKey) && !expectedKeys.has(item.key));
  state.reminders = [...expected, ...snoozes]
    .filter((item) => item.dueAt >= now - 90 * DAY_MS)
    .sort((left, right) => left.dueAt - right.dueAt)
    .slice(-MAX_REMINDER_ROWS);
  state.activeAlertKeys = state.activeAlertKeys.filter((key) => state.reminders.some((item) => item.key === key && ["shown", "uncertain", "delivering"].includes(item.state)));
  return state.reminders;
}

export function deadlineSources(state) {
  const manual = state.manual.map((item) => ({
    kind: "manual",
    id: item.id,
    key: `manual:${item.id}`,
    title: item.title,
    dueAt: item.dueAt,
    endAt: item.dueAt,
    createdAt: item.createdAt,
  }));
  const calendar = state.events.map((item) => {
    const event = item.event;
    const stableKey = `event:${item.provider}:${hash(`${item.calendarId}\u0000${item.eventId}`, 0x811c9dc5)}`;
    return {
      kind: "calendar",
      id: stableKey,
      key: stableKey,
      title: event.title,
      dueAt: Date.parse(event.allDay ? event.dueAt : event.startAt),
      endAt: Date.parse(event.allDay ? event.dueAt : event.endAt),
      createdAt: item.trackedAt,
    };
  });
  return [...manual, ...calendar].filter((item) => Number.isFinite(item.dueAt) && Number.isFinite(item.endAt));
}

export function normalizeCalendarEvent(value, trackedAt = Date.now()) {
  if (!isRecord(value) || !validId(value.id) || !validId(value.calendarId) || value.status !== "confirmed") return null;
  const title = cleanTitle(value.title, "Untitled event");
  const base = {
    id: value.id,
    calendarId: value.calendarId,
    title,
    status: "confirmed",
    trackedAt,
    ...(validZone(value.timeZone) ? { timeZone: value.timeZone } : {}),
    ...(validIso(value.updatedAt) ? { updatedAt: value.updatedAt } : {}),
  };
  if (value.allDay === true) {
    if (!validDate(value.startDate) || !validDate(value.endDateExclusive) || !validIso(value.dueAt)) return null;
    return { ...base, allDay: true, startDate: value.startDate, endDateExclusive: value.endDateExclusive, dueAt: value.dueAt };
  }
  if (value.allDay !== false || !validIso(value.startAt) || !validIso(value.endAt) || Date.parse(value.endAt) < Date.parse(value.startAt)) return null;
  return { ...base, allDay: false, startAt: value.startAt, endAt: value.endAt };
}

export function makeReminderKey(sourceKey, dueAt, offsetMinutes) {
  const input = `${sourceKey}\u0000${dueAt}\u0000${offsetMinutes}`;
  return `deadline-${hash(input, 0x811c9dc5)}-${hash(input, 0x9e3779b9)}`;
}

export function relativeDeadline(ctx, dueAt, now = Date.now()) {
  const delta = dueAt - now;
  if (delta <= 0) return ctx.t("time.overdue", { duration: formatRemaining(dueAt, now) });
  if (delta < 60 * MINUTE_MS) return ctx.t("time.minutes", { count: Math.max(1, Math.ceil(delta / MINUTE_MS)) });
  if (delta < 48 * 60 * MINUTE_MS) return ctx.t("time.hours", { count: Math.ceil(delta / (60 * MINUTE_MS)) });
  const days = Math.ceil(delta / DAY_MS);
  return ctx.t(days === 1 ? "time.day" : "time.days", { count: days });
}

export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function validId(value) { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0-\x1f\x7f]/.test(value); }
function validZone(value) { if (typeof value !== "string" || value.length > 100) return false; try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }
function validIso(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function validDate(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)); }
function arrayOrEmpty(value) { return Array.isArray(value) ? value : []; }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function boundedInteger(value, min, max) { return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : 0; }
function hash(value, seed) { let result = seed >>> 0; for (let index = 0; index < value.length; index += 1) { result ^= value.charCodeAt(index); result = Math.imul(result, 0x01000193) >>> 0; } return result.toString(36); }
