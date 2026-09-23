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


const CALENDARS_RANGE_DAYS = 90;
const CALENDAR_SYNC_INTERVAL_MS = 30 * MINUTE_MS;
const HUD_REFRESH_INTERVAL_MS = MINUTE_MS;
const MAX_EVENT_CHOICES = 50;
const MAX_ALERT_TEXT_ITEMS = 4;
const RETRY_DELAYS_MS = [MINUTE_MS, 5 * MINUTE_MS];
const PROVIDERS = ["google", "outlook"];
const activeContexts = new Set();
const runtimeByContext = new WeakMap();

function runtimeFor(ctx) {
  let runtime = runtimeByContext.get(ctx);
  if (!runtime) {
    runtime = { queue: Promise.resolve(), commands: new Set(), subscriptions: [], hud: null, alerts: new Set(), selections: new Map() };
    runtimeByContext.set(ctx, runtime);
  }
  return runtime;
}

function exclusive(ctx, operation) {
  const runtime = runtimeFor(ctx);
  const task = runtime.queue.catch(() => undefined).then(operation);
  runtime.queue = task.catch(() => undefined);
  return task;
}

async function readState(ctx) {
  return normalizeState(await ctx.storage.get(STORAGE_KEY));
}

async function writeState(ctx, state) {
  await ctx.storage.set(STORAGE_KEY, state);
}

function eventDueAt(event) {
  return Date.parse(event.allDay ? event.dueAt : event.startAt);
}

function eventEndAt(event) {
  return Date.parse(event.allDay ? event.dueAt : event.endAt);
}

function formatLocal(ctx, timestamp) {
  return new Intl.DateTimeFormat(ctx.locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

function shortTitle(value, max = 90) {
  return cleanTitle(value, "").slice(0, max);
}

async function getConfig(ctx) {
  const value = await ctx.config.get();
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function rebuildReminders(ctx, state, now = Date.now()) {
  planReminders(state, now, reminderOffsets(await getConfig(ctx)));
  await writeState(ctx, state);
  await armNextReminder(ctx, state, now);
}

async function armNextReminder(ctx, state, now = Date.now()) {
  await ctx.schedule.cancel(REMINDER_SCHEDULE_ID);
  const next = state.reminders
    .filter((item) => item.state === "pending" && item.attempts < MAX_ALERT_ATTEMPTS)
    .reduce((earliest, item) => {
      const scheduledAt = Math.max(item.dueAt, item.retryAt ?? item.dueAt);
      return !earliest || scheduledAt < earliest.scheduledAt ? { item, scheduledAt } : earliest;
    }, null);
  if (!next) return;
  await ctx.schedule.at(REMINDER_SCHEDULE_ID, new Date(Math.max(now + 1, next.scheduledAt)).toISOString(), () => deliverDue(ctx));
}

function humanDeadlineSummary(ctx, state, now = Date.now()) {
  const sources = deadlineSources(state).sort((left, right) => left.dueAt - right.dueAt);
  if (!sources.length) return ctx.t("status.none");
  const next = sources[0];
  const relative = relativeDeadline(ctx, next.dueAt, now);
  return ctx.t(state.offline ? "status.offlineNext" : "status.next", { title: shortTitle(next.title, 55), relative });
}

function nearestDeadline(state, now = Date.now()) {
  return deadlineSources(state)
    .filter((item) => item.kind === "manual" || item.endAt > now)
    .sort((left, right) => left.dueAt - right.dueAt)[0] ?? null;
}

function hudProgress(source, now = Date.now()) {
  const span = source.dueAt - source.createdAt;
  if (span <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(((now - source.createdAt) / span) * 100)));
}

export function compactHudRelative(ctx, dueAt, now) {
  const delta = dueAt - now;
  if (delta <= 0) return ctx.t("hud.overdue");
  const minutes = Math.max(1, Math.ceil(delta / MINUTE_MS));
  if (minutes < 60) return ctx.t("hud.inMinutes", { count: minutes });
  if (minutes < 48 * 60) return ctx.t("hud.inHours", { count: Math.ceil(minutes / 60) });
  const days = Math.ceil(minutes / (24 * 60));
  return ctx.t("hud.inDays", { count: days });
}

async function renderHud(ctx, state = undefined, now = Date.now()) {
  const current = state ?? await readState(ctx);
  const next = nearestDeadline(current, now);
  const runtime = runtimeFor(ctx);
  if (!next) {
    if (runtime.hud) {
      try { await runtime.hud.dismiss(); } catch {}
      runtime.hud = null;
    }
    await updateStatus(ctx, current, now);
    return;
  }
  const relative = compactHudRelative(ctx, next.dueAt, now);
  const spec = {
    tone: current.offline ? "warning" : "info",
    pin: true,
    sticky: true,
    priority: "low",
    hud: { items: [{ icon: "timer", value: hudProgress(next, now), label: ctx.t("hud.next", { title: shortTitle(next.title, 30), relative }), tone: current.offline ? "amber" : "blue" }] },
  };
  if (runtime.hud) {
    try { await runtime.hud.update(spec); }
    catch { runtime.hud = null; }
  }
  if (!runtime.hud) {
    try {
      runtime.hud = await ctx.ui.bubble(spec);
    } catch {
      await updateStatus(ctx, current, now);
      return;
    }
  }
  await updateStatus(ctx, current, now);
}

async function updateStatus(ctx, state, now = Date.now()) {
  await ctx.status.set({ text: cleanTitle(humanDeadlineSummary(ctx, state, now), 118), tone: state.offline ? "warning" : "info" });
}

function sourceForKey(state, sourceKey) {
  return deadlineSources(state).find((source) => source.key === sourceKey) ?? null;
}

function alertDescription(ctx, state, keys, now) {
  const sources = keys.map((key) => state.reminders.find((row) => row.key === key)).filter(Boolean)
    .map((row) => sourceForKey(state, row.sourceKey)).filter(Boolean);
  const unique = [...new Map(sources.map((source) => [source.key, source])).values()];
  const names = unique.slice(0, MAX_ALERT_TEXT_ITEMS).map((source) => `${shortTitle(source.title, 80)} — ${formatLocal(ctx, source.dueAt)}`);
  if (unique.length > names.length) names.push(ctx.t("alert.more", { count: unique.length - names.length }));
  return { count: unique.length, names, body: names.join("\n") || ctx.t("alert.generic") };
}

function bindAlertActions(ctx, handle, keys) {
  const runtime = runtimeFor(ctx);
  runtime.alerts.add(handle);
  handle.onDismiss(() => runtime.alerts.delete(handle));
  handle.onAction((actionId) => {
    if (actionId === "snooze") return snoozeAlerts(ctx, keys);
    if (actionId === "dismiss") return dismissAlerts(ctx, keys);
  });
}

export async function deliverDue(ctx, now = Date.now()) {
  return exclusive(ctx, async () => {
    const state = await readState(ctx);
    const due = state.reminders
      .filter((item) => item.state === "pending" && item.attempts < MAX_ALERT_ATTEMPTS && Math.max(item.dueAt, item.retryAt ?? item.dueAt) <= now)
      .sort((left, right) => left.dueAt - right.dueAt);
    if (!due.length) {
      await armNextReminder(ctx, state, now);
      return false;
    }

    const keys = due.map((item) => item.key);
    for (const item of due) {
      item.state = "delivering";
      item.attempts += 1;
      item.retryAt = undefined;
    }
    // Durable in-flight marker means restart recovery will not duplicate an alert
    // whose host-side acknowledgement may have raced with shutdown.
    await writeState(ctx, state);

    const description = alertDescription(ctx, state, keys, now);
    const config = await getConfig(ctx);
    const soundEnabled = config.soundEnabled !== false;
    const osNotification = config.osNotification !== false;
    const text = ctx.t("alert.body", { details: description.body });
    let handle = null;
    try {
      handle = await ctx.ui.alert({
        text,
        indicator: { icon: "bell", label: ctx.t("alert.title"), tone: "warning" },
        tone: "warning",
        sound: soundEnabled ? config.customSound || "alert" : undefined,
        notify: osNotification ? { title: ctx.t("notify.title"), body: description.body, sound: soundEnabled } : undefined,
        dismissOn: ["action"],
        actions: [
          { id: "snooze", label: ctx.t("action.snooze"), style: "primary" },
          { id: "dismiss", label: ctx.t("action.dismiss") },
        ],
      });
    } catch {
      try {
        handle = await ctx.pet.speak({
          text,
          tone: "warning",
          sticky: true,
          priority: "high",
          dismissOn: ["action"],
          actions: [
            { id: "snooze", label: ctx.t("action.snooze"), style: "primary" },
            { id: "dismiss", label: ctx.t("action.dismiss") },
          ],
        });
      } catch {
        handle = null;
      }
    }

    const latest = await readState(ctx);
    const rows = new Map(latest.reminders.map((item) => [item.key, item]));
    if (handle) {
      for (const key of keys) {
        const item = rows.get(key);
        if (item?.state === "delivering") {
          item.state = "shown";
          item.shownAt = now;
        }
      }
      latest.activeAlertKeys = [...new Set([...latest.activeAlertKeys, ...keys])].slice(-MAX_REMINDER_ROWS);
      await writeState(ctx, latest);
      bindAlertActions(ctx, handle, keys);
    } else {
      for (const key of keys) {
        const item = rows.get(key);
        if (!item || item.state !== "delivering") continue;
        if (item.attempts >= MAX_ALERT_ATTEMPTS) {
          item.state = "failed";
          item.retryAt = undefined;
        } else {
          item.state = "pending";
          item.retryAt = now + (RETRY_DELAYS_MS[item.attempts - 1] ?? RETRY_DELAYS_MS.at(-1));
        }
      }
      await writeState(ctx, latest);
    }
    await armNextReminder(ctx, latest, now);
    await renderHud(ctx, latest, now);
    return Boolean(handle);
  });
}

async function applyAlertAction(ctx, keys, action) {
  return exclusive(ctx, async () => {
    const now = Date.now();
    const state = await readState(ctx);
    const selected = new Set(keys);
    const rows = new Map(state.reminders.map((item) => [item.key, item]));
    const config = await getConfig(ctx);
    const snoozeMinutes = [5, 10, 15].includes(Number(config.snoozeMinutes)) ? Number(config.snoozeMinutes) : 5;
    for (const key of selected) {
      const item = rows.get(key);
      if (!item || !["shown", "uncertain"].includes(item.state)) continue;
      item.state = "dismissed";
      if (action !== "snooze" || item.snoozeCount >= MAX_SNOOZES_PER_ALERT) continue;
      const count = item.snoozeCount + 1;
      const source = sourceForKey(state, item.sourceKey);
      if (!source) continue;
      state.reminders.push({
        key: `${item.key}-s${count}`,
        sourceKey: item.sourceKey,
        sourceKind: item.sourceKind,
        sourceId: item.sourceId,
        dueAt: now + snoozeMinutes * MINUTE_MS,
        offsetMinutes: item.offsetMinutes,
        state: "pending",
        attempts: 0,
        snoozeCount: count,
        parentKey: item.parentKey ?? item.key,
      });
    }
    state.activeAlertKeys = state.activeAlertKeys.filter((key) => !selected.has(key));
    state.reminders = state.reminders.slice(-MAX_REMINDER_ROWS);
    await writeState(ctx, state);
    await armNextReminder(ctx, state, now);
    await renderHud(ctx, state, now);
  });
}

async function snoozeAlerts(ctx, keys) { return applyAlertAction(ctx, keys, "snooze"); }
async function dismissAlerts(ctx, keys) { return applyAlertAction(ctx, keys, "dismiss"); }

async function actOnLatestAlert(ctx, action) {
  const state = await readState(ctx);
  const active = state.activeAlertKeys.filter((key) => state.reminders.some((item) => item.key === key && ["shown", "uncertain"].includes(item.state)));
  const keys = active.length ? active : state.reminders
    .filter((item) => item.state === "shown" || item.state === "uncertain")
    .sort((left, right) => (right.shownAt ?? 0) - (left.shownAt ?? 0))
    .slice(0, 1)
    .map((item) => item.key);
  if (!keys.length) {
    await ctx.pet.speak(ctx.t("speech.noAlert"));
    return;
  }
  await applyAlertAction(ctx, keys, action);
  await ctx.pet.speak(ctx.t(action === "snooze" ? "speech.snoozed" : "speech.dismissed"));
}

async function retryFailedAlerts(ctx) {
  await exclusive(ctx, async () => {
    const now = Date.now();
    const state = await readState(ctx);
    for (const item of state.reminders) {
      if (item.state === "failed" || item.state === "uncertain") {
        item.state = "pending";
        item.attempts = 0;
        item.retryAt = now;
      }
    }
    await writeState(ctx, state);
    await armNextReminder(ctx, state, now);
  });
  await deliverDue(ctx);
}

async function refreshHud(ctx) {
  return exclusive(ctx, async () => renderHud(ctx, await readState(ctx)));
}

async function armHudRefresh(ctx) {
  if (!activeContexts.has(ctx)) return;
  await ctx.schedule.cancel(HUD_REFRESH_SCHEDULE_ID);
  if (!activeContexts.has(ctx)) return;
  await ctx.schedule.once(HUD_REFRESH_SCHEDULE_ID, HUD_REFRESH_INTERVAL_MS, async () => {
    if (!activeContexts.has(ctx)) return;
    try {
      await refreshHud(ctx);
    } finally {
      await armHudRefresh(ctx);
    }
  });
}

async function reconcile(ctx) {
  return exclusive(ctx, async () => {
    const now = Date.now();
    const state = await readState(ctx);
    // A persisted in-flight row is marked uncertain rather than retried. This
    // avoids a duplicate if the host showed the alert just before a crash; the
    // user can explicitly retry it from the plugin menu if it was not visible.
    for (const item of state.reminders) {
      if (item.state === "delivering") {
        item.state = "uncertain";
        item.shownAt = item.shownAt ?? item.retryAt ?? now;
        state.activeAlertKeys.push(item.key);
      }
    }
    state.activeAlertKeys = [...new Set(state.activeAlertKeys)];
    planReminders(state, now, reminderOffsets(await getConfig(ctx)));
    await writeState(ctx, state);
    await armNextReminder(ctx, state, now);
    await renderHud(ctx, state, now);
    await registerManageDeadlineCommand(ctx, state);
    await armHudRefresh(ctx);
    await armCalendarSync(ctx, state);
  });
}

async function armCalendarSync(ctx, state) {
  await ctx.schedule.cancel(CALENDAR_SYNC_SCHEDULE_ID);
  if (!state.events.length) return;
  await ctx.schedule.every(CALENDAR_SYNC_SCHEDULE_ID, CALENDAR_SYNC_INTERVAL_MS, () => synchronizeTrackedEvents(ctx));
}

function commandIdForCalendar(prefix, provider, calendarId) {
  return `${prefix}-${provider}-${hashString(calendarId)}`;
}

async function registerCommand(ctx, meta, handler) {
  const runtime = runtimeFor(ctx);
  await ctx.commands.unregister(meta.id);
  await ctx.commands.register({ ...meta, placement: "submenu" }, handler);
  runtime.commands.add(meta.id);
}

async function unregisterCommand(ctx, id) {
  const runtime = runtimeFor(ctx);
  try { await ctx.commands.unregister(id); } catch {}
  runtime.commands.delete(id);
  runtime.selections.delete(id);
}

async function registerStaticCommands(ctx) {
  const icon = "timer";
  await registerCommand(ctx, {
    id: "add-deadline",
    title: "$t:command.add.title",
    description: "$t:command.add.description",
    icon,
    form: {
      submitLabel: "$t:command.add.submit",
      fields: [
        { id: "title", type: "text", label: "$t:form.title", required: true, maxLength: 120 },
        { id: "date", type: "date", label: "$t:form.date", required: true },
        { id: "time", type: "time", label: "$t:form.time", required: true },
      ],
    },
  }, (values) => createManualDeadline(ctx, values ?? {}));
  await registerCommand(ctx, { id: "list-deadlines", title: "$t:command.list.title", description: "$t:command.list.description", icon: "bell" }, () => speakDeadlines(ctx));
  await registerCommand(ctx, { id: "refresh-calendars", title: "$t:command.refreshCalendars.title", description: "$t:command.refreshCalendars.description", icon: "timer" }, () => refreshCalendarChoices(ctx));
  await registerCommand(ctx, { id: "check-connections", title: "$t:command.checkConnections.title", description: "$t:command.checkConnections.description", icon: "bell" }, () => checkConnectionStatus(ctx));
  await registerCommand(ctx, { id: "sync-calendar-events", title: "$t:command.sync.title", description: "$t:command.sync.description", icon: "timer" }, () => synchronizeTrackedEvents(ctx));
  await registerCommand(ctx, { id: "connect-google", title: "$t:command.connectGoogle.title", description: "$t:command.connectGoogle.description", icon: "bell" }, () => connectProvider(ctx, "google"));
  await registerCommand(ctx, { id: "connect-outlook", title: "$t:command.connectOutlook.title", description: "$t:command.connectOutlook.description", icon: "bell" }, () => connectProvider(ctx, "outlook"));
  await registerCommand(ctx, { id: "disconnect-google", title: "$t:command.disconnectGoogle.title", description: "$t:command.disconnectGoogle.description", icon: "bell" }, () => disconnectProvider(ctx, "google"));
  await registerCommand(ctx, { id: "disconnect-outlook", title: "$t:command.disconnectOutlook.title", description: "$t:command.disconnectOutlook.description", icon: "bell" }, () => disconnectProvider(ctx, "outlook"));
  await registerCommand(ctx, { id: "snooze-latest-alert", title: "$t:command.snooze.title", description: "$t:command.snooze.description", icon: "bell" }, () => actOnLatestAlert(ctx, "snooze"));
  await registerCommand(ctx, { id: "dismiss-latest-alert", title: "$t:command.dismiss.title", description: "$t:command.dismiss.description", icon: "bell" }, () => actOnLatestAlert(ctx, "dismiss"));
  await registerCommand(ctx, { id: "retry-alerts", title: "$t:command.retry.title", description: "$t:command.retry.description", icon: "bell" }, () => retryFailedAlerts(ctx));
}

async function registerManageDeadlineCommand(ctx, state) {
  const id = "manage-deadline";
  if (!state.manual.length) return unregisterCommand(ctx, id);
  await registerCommand(ctx, {
    id,
    title: "$t:command.manage.title",
    description: "$t:command.manage.description",
    icon: "timer",
    form: {
      submitLabel: "$t:command.manage.submit",
      fields: [
        { id: "deadlineId", type: "select", label: "$t:form.deadline", options: state.manual.map((item) => ({ value: item.id, label: `${item.title} — ${formatLocal(ctx, item.dueAt)}` })) },
        { id: "action", type: "select", label: "$t:form.action", default: "reschedule", options: ["reschedule", "complete", "delete"].map((value) => ({ value, label: ctx.t(`action.${value}`) })) },
        { id: "title", type: "text", label: "$t:form.newTitle", maxLength: 120 },
        { id: "date", type: "date", label: "$t:form.newDate" },
        { id: "time", type: "time", label: "$t:form.newTime" },
      ],
    },
  }, (values) => manageManualDeadline(ctx, values ?? {}));
}

async function createManualDeadline(ctx, values) {
  return exclusive(ctx, async () => {
    const now = Date.now();
    const title = cleanTitle(values.title);
    const dueAt = localDateTimeToEpoch(values.date, values.time, localTimeZone());
    if (!title || dueAt === null || dueAt <= now) {
      await ctx.pet.speak(ctx.t("speech.invalidDeadline"));
      return;
    }
    const state = await readState(ctx);
    if (state.manual.length >= MAX_MANUAL_DEADLINES) {
      await ctx.pet.speak(ctx.t("speech.tooMany", { count: MAX_MANUAL_DEADLINES }));
      return;
    }
    state.sequence += 1;
    const id = `manual-${now.toString(36)}-${state.sequence.toString(36)}`;
    state.manual.push({ id, title, dueAt, createdAt: now });
    planReminders(state, now, reminderOffsets(await getConfig(ctx)));
    await writeState(ctx, state);
    await registerManageDeadlineCommand(ctx, state);
    await armNextReminder(ctx, state, now);
    await renderHud(ctx, state, now);
    await ctx.pet.speak(ctx.t("speech.created", { title, relative: relativeDeadline(ctx, dueAt, now) }));
  });
}

async function manageManualDeadline(ctx, values) {
  return exclusive(ctx, async () => {
    const now = Date.now();
    const state = await readState(ctx);
    const item = state.manual.find((deadline) => deadline.id === values.deadlineId);
    if (!item) return;
    const action = values.action;
    if (action === "complete" || action === "delete") {
      state.manual = state.manual.filter((deadline) => deadline.id !== item.id);
      await ctx.pet.speak(ctx.t(action === "complete" ? "speech.completed" : "speech.deleted", { title: item.title }));
    } else if (action === "reschedule") {
      const dueAt = localDateTimeToEpoch(values.date, values.time, localTimeZone());
      const title = cleanTitle(values.title, item.title);
      if (!title || dueAt === null || dueAt <= now) {
        await ctx.pet.speak(ctx.t("speech.invalidDeadline"));
        return;
      }
      item.title = title;
      item.dueAt = dueAt;
      item.createdAt = now;
      await ctx.pet.speak(ctx.t("speech.updated", { title, relative: relativeDeadline(ctx, dueAt, now) }));
    } else return;
    planReminders(state, now, reminderOffsets(await getConfig(ctx)));
    await writeState(ctx, state);
    await registerManageDeadlineCommand(ctx, state);
    await armNextReminder(ctx, state, now);
    await renderHud(ctx, state, now);
    await armCalendarSync(ctx, state);
  });
}

async function speakDeadlines(ctx) {
  const state = await readState(ctx);
  const sources = deadlineSources(state).sort((left, right) => left.dueAt - right.dueAt).slice(0, 5);
  if (!sources.length) return ctx.pet.speak(ctx.t("speech.none"));
  const details = sources.map((item) => `${shortTitle(item.title, 70)} — ${formatLocal(ctx, item.dueAt)}`).join("; ");
  await ctx.pet.speak(ctx.t("speech.list", { details, count: sources.length }));
}

async function connectProvider(ctx, provider) {
  try {
    const result = await ctx.calendar.connect(provider);
    await ctx.pet.speak(ctx.t(`speech.connection.${result.state}`, { provider: ctx.t(`provider.${provider}`) }));
  } catch {
    const state = await readState(ctx);
    state.offline = true;
    state.connectionStates[provider] = "offline";
    await writeState(ctx, state);
    await renderHud(ctx, state);
    await ctx.pet.speak(ctx.t("speech.connection.error", { provider: ctx.t(`provider.${provider}`) }));
  }
}

async function checkConnectionStatus(ctx) {
  return exclusive(ctx, async () => {
    const state = await readState(ctx);
    for (const provider of PROVIDERS) {
      try {
        state.connectionStates[provider] = (await ctx.calendar.status(provider)).state;
      } catch {
        state.connectionStates[provider] = "offline";
      }
    }
    state.offline = Object.values(state.connectionStates).some((status) => status === "offline");
    await writeState(ctx, state);
    await renderHud(ctx, state);
    await ctx.pet.speak(ctx.t("speech.connectionStatus", {
      google: ctx.t(`connection.${state.connectionStates.google}`),
      outlook: ctx.t(`connection.${state.connectionStates.outlook}`),
    }));
  });
}

async function disconnectProvider(ctx, provider) {
  try {
    await ctx.calendar.disconnect(provider);
  } catch {
    await ctx.pet.speak(ctx.t("speech.disconnectFailed", { provider: ctx.t(`provider.${provider}`) }));
    return;
  }
  return exclusive(ctx, async () => {
    const state = await readState(ctx);
    state.events = state.events.filter((event) => event.provider !== provider);
    state.calendars = state.calendars.filter((calendar) => calendar.provider !== provider);
    state.connectionStates[provider] = "not_connected";
    state.offline = false;
    planReminders(state, Date.now(), reminderOffsets(await getConfig(ctx)));
    await writeState(ctx, state);
    await syncCalendarCommands(ctx, state.calendars);
    await armNextReminder(ctx, state);
    await armCalendarSync(ctx, state);
    await renderHud(ctx, state);
    await ctx.pet.speak(ctx.t("speech.disconnected", { provider: ctx.t(`provider.${provider}`) }));
  });
}

async function refreshCalendarChoices(ctx) {
  return exclusive(ctx, async () => {
    const state = await readState(ctx);
    let failed = false;
    for (const provider of PROVIDERS) {
      try {
        const status = await ctx.calendar.status(provider);
        state.connectionStates[provider] = status.state;
        if (status.state === "connected") {
          const result = await ctx.calendar.listCalendars(provider);
          state.calendars = state.calendars.filter((calendar) => calendar.provider !== provider);
          state.calendars.push(...result.calendars.map((calendar) => ({ ...calendar, provider })));
        } else if (status.state === "not_connected") {
          state.calendars = state.calendars.filter((calendar) => calendar.provider !== provider);
        }
      } catch {
        failed = true;
        state.connectionStates[provider] = "offline";
      }
    }
    state.offline = failed || Object.values(state.connectionStates).some((status) => status === "offline");
    await writeState(ctx, state);
    await syncCalendarCommands(ctx, state.calendars);
    await renderHud(ctx, state);
    await ctx.pet.speak(ctx.t(failed ? "speech.calendarOffline" : "speech.calendarsUpdated", { count: state.calendars.length }));
  });
}

async function syncCalendarCommands(ctx, calendars) {
  const runtime = runtimeFor(ctx);
  for (const id of [...runtime.commands]) {
    if (id.startsWith("browse-calendar-") || id.startsWith("track-events-")) await unregisterCommand(ctx, id);
  }
  for (const calendar of calendars) {
    const id = commandIdForCalendar("browse-calendar", calendar.provider, calendar.id);
    await registerCommand(ctx, {
      id,
      title: "$t:command.browseCalendar.title",
      description: "$t:command.browseCalendar.description",
      icon: "bell",
    }, () => browseCalendar(ctx, calendar));
  }
}

async function browseCalendar(ctx, calendar) {
  try {
    const now = Date.now();
    const result = await ctx.calendar.listEvents(calendar.provider, calendar.id, {
      from: new Date(now - 5 * MINUTE_MS).toISOString(),
      to: new Date(now + CALENDARS_RANGE_DAYS * DAY_MS).toISOString(),
      ...(calendar.timeZone ? { calendarTimeZone: calendar.timeZone } : {}),
    });
    const state = await readState(ctx);
    const tracked = new Set(state.events.map((item) => `${item.provider}\u0000${item.calendarId}\u0000${item.eventId}`));
    const choices = result.events
      .filter((event) => event.status === "confirmed" && eventDueAt(event) > now && eventEndAt(event) > now)
      .filter((event) => !tracked.has(`${calendar.provider}\u0000${calendar.id}\u0000${event.id}`))
      .slice(0, MAX_EVENT_CHOICES);
    if (!choices.length) {
      await ctx.pet.speak(ctx.t("speech.noEvents", { calendar: calendar.name }));
      return;
    }
    const commandId = commandIdForCalendar("track-events", calendar.provider, calendar.id);
    const options = choices.map((event, index) => ({
      value: String(index),
      label: `${shortTitle(event.title, 80)} — ${formatLocal(ctx, eventDueAt(event))}`.slice(0, 180),
    }));
    runtimeFor(ctx).selections.set(commandId, choices);
    await registerCommand(ctx, {
      id: commandId,
      title: "$t:command.trackEvents.title",
      description: "$t:command.trackEvents.description",
      icon: "bell",
      form: { submitLabel: "$t:command.trackEvents.submit", fields: [{ id: "eventIndex", type: "select", label: "$t:form.event", options }] },
    }, (values) => trackSelectedEvent(ctx, calendar, Number(values?.eventIndex)));
    await ctx.pet.speak(ctx.t("speech.eventsReady", { count: choices.length, calendar: calendar.name }));
  } catch {
    const state = await readState(ctx);
    state.offline = true;
    state.connectionStates[calendar.provider] = "offline";
    await writeState(ctx, state);
    await renderHud(ctx, state);
    await ctx.pet.speak(ctx.t("speech.calendarOffline"));
  }
}

async function trackSelectedEvent(ctx, calendar, index) {
  const commandId = commandIdForCalendar("track-events", calendar.provider, calendar.id);
  const choice = runtimeFor(ctx).selections.get(commandId)?.[index];
  if (!choice) return;
  return exclusive(ctx, async () => {
    const state = await readState(ctx);
    const event = normalizeCalendarEvent(choice);
    if (!event || state.events.length >= MAX_TRACKED_EVENTS) {
      await ctx.pet.speak(ctx.t("speech.tooManyEvents", { count: MAX_TRACKED_EVENTS }));
      return;
    }
    if (state.events.some((item) => item.provider === calendar.provider && item.calendarId === calendar.id && item.eventId === event.id)) return;
    const now = Date.now();
    state.events.push({ provider: calendar.provider, calendarId: calendar.id, eventId: event.id, ...(calendar.timeZone ? { calendarTimeZone: calendar.timeZone } : {}), trackedAt: now, event });
    state.offline = false;
    planReminders(state, now, reminderOffsets(await getConfig(ctx)));
    await writeState(ctx, state);
    await armNextReminder(ctx, state, now);
    await armCalendarSync(ctx, state);
    await renderHud(ctx, state, now);
    await ctx.pet.speak(ctx.t("speech.eventTracked", { title: event.title, relative: relativeDeadline(ctx, eventDueAt(event), now) }));
  });
}

async function synchronizeTrackedEvents(ctx) {
  return exclusive(ctx, async () => {
    const state = await readState(ctx);
    if (!state.events.length) {
      await ctx.pet.speak(ctx.t("speech.noTrackedEvents"));
      return false;
    }
    const nextEvents = [];
    let failed = false;
    for (const provider of PROVIDERS) {
      const providerEvents = state.events.filter((item) => item.provider === provider);
      if (!providerEvents.length) continue;
      let status;
      try { status = await ctx.calendar.status(provider); }
      catch { status = { provider, state: "offline" }; }
      state.connectionStates[provider] = status.state;
      if (status.state !== "connected") {
        if (status.state === "offline") failed = true;
        nextEvents.push(...providerEvents);
        continue;
      }
      for (const tracked of providerEvents) {
        try {
          const calendarTimeZone = provider === "google" ? tracked.calendarTimeZone : undefined;
          const fetched = await ctx.calendar.getEvent(provider, tracked.calendarId, tracked.eventId, calendarTimeZone);
          if (!fetched || fetched.status === "cancelled") {
            await ctx.pet.speak(ctx.t("speech.eventRemoved", { title: tracked.event.title }));
            continue;
          }
          const event = normalizeCalendarEvent(fetched, tracked.trackedAt);
          if (!event) continue;
          nextEvents.push({ ...tracked, event });
        } catch {
          failed = true;
          nextEvents.push(tracked);
        }
      }
    }
    state.events = nextEvents.slice(0, MAX_TRACKED_EVENTS);
    state.offline = failed || Object.values(state.connectionStates).some((status) => status === "offline");
    const now = Date.now();
    planReminders(state, now, reminderOffsets(await getConfig(ctx)));
    await writeState(ctx, state);
    await armNextReminder(ctx, state, now);
    await armCalendarSync(ctx, state);
    await renderHud(ctx, state, now);
    if (failed) await ctx.pet.speak(ctx.t("speech.calendarOffline"));
    else await ctx.pet.speak(ctx.t("speech.syncComplete", { count: state.events.length }));
    return !failed;
  });
}

async function handleConfigChange(ctx) {
  return exclusive(ctx, async () => {
    const now = Date.now();
    const state = await readState(ctx);
    planReminders(state, now, reminderOffsets(await getConfig(ctx)));
    await writeState(ctx, state);
    await armNextReminder(ctx, state, now);
  });
}

function addLifecycleSubscriptions(ctx) {
  const runtime = runtimeFor(ctx);
  runtime.subscriptions.push(ctx.events.on("online", () => { void refreshCalendarChoices(ctx); void synchronizeTrackedEvents(ctx); }));
  runtime.subscriptions.push(ctx.events.on("offline", () => {
    void exclusive(ctx, async () => {
      const state = await readState(ctx);
      state.offline = true;
      state.connectionStates.google = state.connectionStates.google === "connected" ? "offline" : state.connectionStates.google;
      state.connectionStates.outlook = state.connectionStates.outlook === "connected" ? "offline" : state.connectionStates.outlook;
      await writeState(ctx, state);
      await renderHud(ctx, state);
    });
  }));
  runtime.subscriptions.push(ctx.events.on("screen:unlocked", () => { void refreshCalendarChoices(ctx); void synchronizeTrackedEvents(ctx); }));
  runtime.subscriptions.push(ctx.config.onChange(() => handleConfigChange(ctx)));
}

export async function stopContext(ctx) {
  const runtime = runtimeByContext.get(ctx);
  if (!runtime) return;
  await runtime.queue.catch(() => undefined);
  for (const unsubscribe of runtime.subscriptions.splice(0)) {
    try { unsubscribe(); } catch {}
  }
  await Promise.all([REMINDER_SCHEDULE_ID, HUD_REFRESH_SCHEDULE_ID, CALENDAR_SYNC_SCHEDULE_ID].map(async (id) => {
    try { await ctx.schedule.cancel(id); } catch {}
  }));
  for (const id of [...runtime.commands]) await unregisterCommand(ctx, id);
  if (runtime.hud) {
    try { await runtime.hud.dismiss(); } catch {}
    runtime.hud = null;
  }
  for (const alert of runtime.alerts) {
    try { await alert.dismiss(); } catch {}
  }
  runtime.alerts.clear();
  try { await ctx.status.clear(); } catch {}
  activeContexts.delete(ctx);
  runtimeByContext.delete(ctx);
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      activeContexts.add(ctx);
      await registerStaticCommands(ctx);
      addLifecycleSubscriptions(ctx);
      await reconcile(ctx);
      const state = await readState(ctx);
      await syncCalendarCommands(ctx, state.calendars);
      if (state.events.length) void synchronizeTrackedEvents(ctx);
      await deliverDue(ctx);
    },
    async stop() {
      await Promise.all([...activeContexts].map((ctx) => stopContext(ctx)));
    },
  });
}

export {
  refreshCalendarChoices,
  synchronizeTrackedEvents,
};

function hashString(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
