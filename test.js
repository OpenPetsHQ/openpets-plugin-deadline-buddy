import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ALLOWED_REMINDER_OFFSETS,
  CALENDAR_SYNC_SCHEDULE_ID,
  DAY_MS,
  DEFAULT_REMINDER_OFFSETS,
  HUD_REFRESH_SCHEDULE_ID,
  MAX_ALERT_ATTEMPTS,
  MINUTE_MS,
  REMINDER_SCHEDULE_ID,
  cleanTitle,
  compactHudRelative,
  deadlineSources,
  formatRemaining,
  localDateTimeToEpoch,
  makeReminderKey,
  normalizeCalendarEvent,
  normalizeState,
  planReminders,
  reminderOffsets,
} from "./index.js";
import { deliverDue, register, synchronizeTrackedEvents } from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(new URL("../openpets/packages/sdk/dist/testing.js", import.meta.url)));
}

const locales = { en: JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8")) };
const permissions = ["pet:speak", "pet:interact", "pet:pin", "commands", "schedule", "storage", "status", "calendar:connect", "events", "audio", "notify"];
const now = Date.now();

function makeHarness(config = {}) {
  return createTestHarness(register, { permissions, locales, config: { reminderOffsets: ["60", "15", "0"], ...config }, nowMs: now });
}

function futureForm(minutesAhead = 20) {
  const target = new Date(Date.now() + minutesAhead * 60_000);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(target).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

async function addDeadline(h, title, minutesAhead = 20) {
  await h.runCommand("add-deadline", { title, ...futureForm(minutesAhead) });
  return h.calls.storage.get("deadline-buddy-state");
}

function connectedStatus(provider) {
  return { provider, state: "connected", checkedAt: new Date().toISOString() };
}

// The boundary helpers keep absolute time, reject invalid wall times, and use
// one deterministic interpretation for DST overlaps.
assert.equal(cleanTitle("  plan\n  launch  "), "plan launch");
assert.equal(cleanTitle("\u0000\u0001"), "");
assert.deepEqual(reminderOffsets({}), DEFAULT_REMINDER_OFFSETS);
assert.deepEqual(reminderOffsets({ reminderOffsets: ["0", "15", "bogus", "15"] }), [15, 0]);
assert.deepEqual(ALLOWED_REMINDER_OFFSETS, [1440, 60, 15, 0]);
assert.equal(localDateTimeToEpoch("2026-03-08", "02:30", "America/New_York"), null, "a spring-forward gap is not a real local time");
assert.equal(localDateTimeToEpoch("2026-11-01", "01:30", "America/New_York"), Date.parse("2026-11-01T05:30:00.000Z"), "a fall-back overlap resolves to its earlier instant");
assert.equal(localDateTimeToEpoch("2026-02-30", "10:00", "UTC"), null);
assert.equal(localDateTimeToEpoch("2026-02-01", "24:00", "UTC"), null);
assert.equal(formatRemaining(now + 2 * MINUTE_MS, now), "2m");
assert.equal(formatRemaining(now - 61 * MINUTE_MS, now), "2h ago");
{
  const h = makeHarness();
  assert.equal(compactHudRelative(h.ctx, now - 1, now), "overdue");
  assert.equal(compactHudRelative(h.ctx, now + 45 * MINUTE_MS, now), "in 45m");
  assert.equal(compactHudRelative(h.ctx, now + 90 * MINUTE_MS, now), "in 2h");
  assert.equal(compactHudRelative(h.ctx, now + 2 * DAY_MS, now), "in 2d");
}

const allDay = normalizeCalendarEvent({
  id: "all-day-1", calendarId: "work", title: "Conference", status: "confirmed", allDay: true,
  startDate: "2026-10-25", endDateExclusive: "2026-10-26", dueAt: "2026-10-25T23:59:59.999Z", timeZone: "Europe/London",
});
assert.equal(allDay?.allDay, true);
assert.equal(allDay?.dueAt, "2026-10-25T23:59:59.999Z", "provider-normalized all-day deadline stays an absolute instant");
assert.equal(normalizeCalendarEvent({ ...allDay, status: "cancelled" }), null);

// Reminder plans are stable across restarts, reset only when a deadline moves,
// and retain just the nearest missed offset after a long sleep.
{
  const state = normalizeState({
    manual: [{ id: "manual-a", title: "Review", dueAt: now + 2 * DAY_MS, createdAt: now }],
  });
  planReminders(state, now, [60, 15, 0]);
  assert.deepEqual(state.reminders.map((item) => item.offsetMinutes), [60, 15, 0]);
  const planned = state.reminders.map((item) => item.key);
  planReminders(state, now, [60, 15, 0]);
  assert.deepEqual(state.reminders.map((item) => item.key), planned);
  planReminders(state, now + DAY_MS * 2, [60, 15, 0]);
  assert.deepEqual(state.reminders.map((item) => item.offsetMinutes), [0], "one missed alert is retained instead of replaying every old reminder");
  assert.equal(makeReminderKey("manual:manual-a", now, 0), makeReminderKey("manual:manual-a", now, 0));
  assert.ok(deadlineSources(state).length === 1);
}

// Manual create/update/delete, pinned nearest-deadline HUD, and submenu-only
// placement for every plugin action.
{
  const h = makeHarness({ reminderOffsets: ["0"] });
  await h.start();
  assert.equal([...h.calls.commands.values()].every((item) => item.meta.placement === "submenu"), true);
  assert.equal(h.calls.schedules.get(HUD_REFRESH_SCHEDULE_ID)?.type, "once", "the one-minute HUD refresh uses a one-shot SDK schedule");
  await h.clock.advance("1m");
  assert.equal(h.calls.schedules.get(HUD_REFRESH_SCHEDULE_ID)?.type, "once", "the HUD refresh rearms after each tick");
  const first = await addDeadline(h, "Design review");
  assert.equal(first.manual.length, 1);
  assert.equal(first.manual[0].title, "Design review");
  assert.equal(h.calls.schedules.get(REMINDER_SCHEDULE_ID)?.type, "at", "deadline alerts use an absolute schedule");
  const hud = h.calls.bubbles.find((bubble) => bubble.pinned);
  assert.ok(hud, "nearest deadline is rendered in a pinned host bubble");
  assert.equal(hud.spec.text, undefined, "HUD descriptors do not mix body text with host-rendered HUD rows");
  assert.match(hud.spec.hud.items[0].label, /^Design review · in \d+[mh]$/);
  assert.equal([...h.calls.commands.values()].some((item) => item.meta.placement === "top"), false);

  const manage = h.calls.commands.get("manage-deadline");
  assert.ok(manage, "manual CRUD command is registered when at least one deadline exists");
  await manage.handler({ deadlineId: first.manual[0].id, action: "reschedule", title: "Design review v2", ...futureForm(40) });
  assert.equal(h.calls.storage.get("deadline-buddy-state").manual[0].title, "Design review v2");
  await h.calls.commands.get("manage-deadline").handler({ deadlineId: first.manual[0].id, action: "complete" });
  assert.equal(h.calls.storage.get("deadline-buddy-state").manual.length, 0);
  assert.equal(h.calls.commands.has("manage-deadline"), false);
  assert.equal(h.calls.schedules.has(REMINDER_SCHEDULE_ID), false);
  h.expectNoErrors();
  await h.stop();
  assert.equal(h.calls.schedules.size, 0, "stop removes all plugin schedules");
}

// Alert delivery requests the configured optional sound and system
// notification, and its snooze action creates a new bounded absolute reminder.
{
  const h = makeHarness({ reminderOffsets: ["0"], soundEnabled: true, osNotification: true, customSound: "gong", snoozeMinutes: "10" });
  await h.start();
  const state = await addDeadline(h, "Submit report");
  const reminder = state.reminders[0];
  assert.ok(await deliverDue(h.ctx, reminder.dueAt), "the host alert is acknowledged when rendered");
  assert.equal(h.calls.alerts.length, 1);
  assert.equal(h.calls.alerts[0].spec.sound, "gong");
  assert.equal(h.calls.alerts[0].spec.notify.title, "Deadline Buddy");
  assert.match(h.calls.alerts[0].spec.notify.body, /Submit report/);
  const alert = h.calls.alerts[0];
  await h.fireBubbleAction(alert.bubble.handle.id, "snooze");
  const afterSnooze = h.calls.storage.get("deadline-buddy-state");
  assert.ok(afterSnooze.reminders.some((item) => item.state === "dismissed"));
  const snoozed = afterSnooze.reminders.find((item) => item.parentKey);
  assert.equal(snoozed.state, "pending");
  assert.ok(Math.abs(snoozed.dueAt - (Date.now() + 10 * 60_000)) < 100, "snooze uses the configured absolute duration");
  assert.equal(h.calls.alerts.length, 1, "snooze does not immediately create another alert");
  h.expectNoErrors();
  await h.stop();
}

// Dismissal acknowledges a surfaced batch and leaves no duplicate delivery
// after restart.
{
  const h = makeHarness({ reminderOffsets: ["0"], soundEnabled: false, osNotification: false });
  await h.start();
  const state = await addDeadline(h, "Pay invoice");
  await deliverDue(h.ctx, state.reminders[0].dueAt);
  const alert = h.calls.alerts[0];
  await h.fireBubbleAction(alert.bubble.handle.id, "dismiss");
  assert.equal(h.calls.storage.get("deadline-buddy-state").reminders[0].state, "dismissed");
  const alertCount = h.calls.alerts.length;
  await h.stop();
  await h.start();
  assert.equal(h.calls.alerts.length, alertCount, "dismissed reminders are not replayed after restart");
  h.expectNoErrors();
  await h.stop();
}

// If alert and fallback speech both fail, delivery remains pending with a
// bounded retry schedule and transitions to failed after the fixed attempt cap.
{
  const h = makeHarness({ reminderOffsets: ["0"] });
  await h.start();
  const state = await addDeadline(h, "Submit taxes");
  let uiAttempts = 0;
  h.ctx.ui.alert = async () => { uiAttempts += 1; throw new Error("alert host unavailable"); };
  h.ctx.pet.speak = async () => { throw new Error("pet host unavailable"); };
  const firstDue = state.reminders[0].dueAt;
  await deliverDue(h.ctx, firstDue);
  let reminder = h.calls.storage.get("deadline-buddy-state").reminders[0];
  assert.equal(reminder.state, "pending");
  assert.equal(reminder.attempts, 1);
  assert.equal(reminder.retryAt, firstDue + 60_000);
  await deliverDue(h.ctx, reminder.retryAt);
  reminder = h.calls.storage.get("deadline-buddy-state").reminders[0];
  assert.equal(reminder.state, "pending");
  assert.equal(reminder.attempts, 2);
  assert.equal(reminder.retryAt, firstDue + 60_000 + 5 * 60_000);
  await deliverDue(h.ctx, reminder.retryAt);
  reminder = h.calls.storage.get("deadline-buddy-state").reminders[0];
  assert.equal(reminder.state, "failed");
  assert.equal(reminder.attempts, MAX_ALERT_ATTEMPTS);
  assert.equal(h.calls.schedules.has(REMINDER_SCHEDULE_ID), false, "exhausted retries do not spin");
  assert.equal(uiAttempts, MAX_ALERT_ATTEMPTS);
  h.expectNoErrors();
  await h.stop();
}

// A crash between the durable in-flight marker and UI acknowledgement is
// surfaced as uncertain and not automatically repeated. Explicit retry is
// available from the plugin submenu.
{
  const h = makeHarness({ reminderOffsets: ["0"] });
  const dueAt = now + 5 * MINUTE_MS;
  const sourceKey = "manual:manual-restart";
  const key = makeReminderKey(sourceKey, dueAt, 0);
  await h.ctx.storage.set("deadline-buddy-state", {
    version: 1,
    manual: [{ id: "manual-restart", title: "Restart recovery", dueAt, createdAt: now }],
    reminders: [{ key, sourceKey, sourceKind: "manual", sourceId: "manual-restart", dueAt, offsetMinutes: 0, state: "delivering", attempts: 1, snoozeCount: 0 }],
    activeAlertKeys: [],
  });
  await h.start();
  assert.equal(h.calls.alerts.length, 0);
  assert.equal(h.calls.storage.get("deadline-buddy-state").reminders[0].state, "uncertain");
  assert.ok(h.calls.commands.has("retry-alerts"));
  await h.stop();
  await h.start();
  assert.equal(h.calls.alerts.length, 0, "restart must not automatically duplicate an uncertain alert");
  h.expectNoErrors();
  await h.stop();
}

// Calendar integration is selective, provider-mocked, reconciles edits and
// cancellation, and preserves the cached event through offline failures.
{
  const h = makeHarness({ reminderOffsets: ["0"] });
  await h.start();
  h.calendar.mockStatus("google", connectedStatus("google"));
  h.calendar.mockCalendars("google", { calendars: [{ id: "work", name: "Work", timeZone: "Europe/London", primary: true }], truncated: false });
  await h.runCommand("refresh-calendars");
  const browseId = [...h.calls.commands.keys()].find((id) => id.startsWith("browse-calendar-google-"));
  assert.ok(browseId, "connected calendars become commands inside the plugin submenu");
  const event = {
    id: "event-1", calendarId: "work", title: "Planning", status: "confirmed", allDay: false,
    startAt: new Date(Date.now() + 45 * 60_000).toISOString(), endAt: new Date(Date.now() + 60 * 60_000).toISOString(), timeZone: "Europe/London",
  };
  h.calendar.mockEvents("google", "work", { events: [event], truncated: false });
  await h.runCommand(browseId);
  const eventListCall = h.calls.calendarCalls.find((call) => call.operation === "listEvents");
  assert.equal(eventListCall?.range?.calendarTimeZone, "Europe/London", "calendar timezone accompanies event-list reads for all-day resolution");
  const trackId = [...h.calls.commands.keys()].find((id) => id.startsWith("track-events-google-"));
  assert.ok(trackId);
  assert.equal(h.calls.commands.get(trackId).meta.placement, "submenu");
  await h.runCommand(trackId, { eventIndex: "0" });
  assert.equal(h.calls.storage.get("deadline-buddy-state").events.length, 1);
  assert.equal(h.calls.storage.get("deadline-buddy-state").events[0].calendarTimeZone, "Europe/London");

  const moved = { ...event, title: "Planning moved", startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(), endAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString() };
  h.calendar.mockEvent("google", "work", "event-1", moved);
  await h.runCommand("sync-calendar-events");
  const eventReadCall = h.calls.calendarCalls.find((call) => call.operation === "getEvent");
  assert.equal(eventReadCall?.calendarTimeZone, "Europe/London", "restart reconciliation reuses the event's calendar timezone");
  let saved = h.calls.storage.get("deadline-buddy-state");
  assert.equal(saved.events[0].event.title, "Planning moved");
  assert.equal(saved.events[0].event.startAt, moved.startAt);
  assert.match(h.calls.bubbles.find((bubble) => bubble.pinned).spec.hud.items[0].label, /Planning moved/);

  const originalGetEvent = h.ctx.calendar.getEvent;
  h.ctx.calendar.getEvent = async () => { throw new Error("offline"); };
  await synchronizeTrackedEvents(h.ctx);
  saved = h.calls.storage.get("deadline-buddy-state");
  assert.equal(saved.events.length, 1, "offline sync keeps the last known event snapshot");
  assert.equal(saved.offline, true);
  h.ctx.calendar.getEvent = originalGetEvent;
  h.calendar.mockEvent("google", "work", "event-1", null);
  await h.runCommand("sync-calendar-events");
  saved = h.calls.storage.get("deadline-buddy-state");
  assert.equal(saved.events.length, 0, "cancellation/deletion removes the event and its reminders");
  assert.equal(h.calls.schedules.has(CALENDAR_SYNC_SCHEDULE_ID), false);
  assert.ok(h.calls.speak.some((text) => text.includes("cancelled or removed")));
  h.expectNoErrors();
  await h.stop();
}

// Project-wide callback serialization has a clear user message rather than
// claiming this profile already has a pending connection.
{
  const h = makeHarness();
  await h.start();
  h.ctx.calendar.connect = async () => ({ state: "busy" });
  await h.runCommand("connect-google");
  assert.ok(h.calls.speak.some((text) => text.includes("Another OpenPets calendar connection is being verified")));
  h.expectNoErrors();
  await h.stop();
}

{
  const h = makeHarness();
  await h.start();
  h.ctx.calendar.connect = async () => ({ state: "cancelled" });
  await h.runCommand("connect-google");
  assert.ok(h.calls.speak.some((text) => text.includes("The Google Calendar connection was cancelled")));
  h.expectNoErrors();
  await h.stop();
}

console.log("openpets.deadline-buddy: all checks passed.");
