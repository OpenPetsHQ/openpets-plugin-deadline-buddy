import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ALLOWED_REMINDER_OFFSETS,
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
  normalizeState,
  planReminders,
  reminderOffsets,
} from "./index.js";
import { deliverDue, register } from "./index.js";

const { createTestHarness } = await import("@open-pets/plugin-sdk/testing");

const locales = { en: JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8")) };
const permissions = ["pet:speak", "pet:interact", "pet:pin", "commands", "schedule", "storage", "status", "audio", "notify"];
const manifest = JSON.parse(await readFile(new URL("./openpets.plugin.json", import.meta.url), "utf8"));
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

assert.equal(manifest.permissions.includes("calendar:connect"), false);
assert.equal(manifest.permissions.includes("events"), false);
assert.equal(manifest.permissions.includes("auth"), false);
assert.equal(manifest.permissions.includes("network"), false);
assert.equal(manifest.network, undefined);

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
// placement for every plugin action without a calendar host capability.
{
  const h = makeHarness({ reminderOffsets: ["0"] });
  await h.start();
  assert.equal([...h.calls.commands.keys()].some((id) => /calendar|connect-google|outlook/i.test(id)), false);
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

// Old calendar snapshots and reminders are discarded without losing manual
// deadlines when users upgrade from the connector-based preview.
{
  const h = makeHarness({ reminderOffsets: ["0"] });
  const dueAt = now + 30 * MINUTE_MS;
  const calendarReminder = {
    key: makeReminderKey("event:google:planning", dueAt, 0),
    sourceKey: "event:google:planning",
    sourceKind: "calendar",
    sourceId: "planning",
    dueAt,
    offsetMinutes: 0,
    state: "pending",
    attempts: 0,
    snoozeCount: 0,
  };
  await h.ctx.storage.set("deadline-buddy-state", {
    version: 1,
    sequence: 2,
    manual: [{ id: "keep-me", title: "Manual task", dueAt: now + DAY_MS, createdAt: now }],
    calendars: [{ provider: "google", id: "primary", name: "Calendar" }],
    events: [{ provider: "google", calendarId: "primary", eventId: "planning", trackedAt: now, event: { id: "planning" } }],
    reminders: [calendarReminder],
    activeAlertKeys: [],
    connectionStates: { google: "connected", outlook: "connected" },
    offline: true,
  });
  await h.start();
  const saved = h.calls.storage.get("deadline-buddy-state");
  assert.deepEqual(saved.manual.map((item) => item.id), ["keep-me"]);
  assert.equal(Object.hasOwn(saved, "calendars"), false);
  assert.equal(Object.hasOwn(saved, "events"), false);
  assert.equal(Object.hasOwn(saved, "connectionStates"), false);
  assert.equal(Object.hasOwn(saved, "offline"), false);
  assert.equal(saved.reminders.some((item) => item.sourceKey.startsWith("event:")), false);
  assert.ok(saved.reminders.some((item) => item.sourceKey === "manual:keep-me"));
  assert.ok(h.calls.bubbles.some((bubble) => bubble.pinned && bubble.spec.hud.items[0].label.includes("Manual task")));
  h.expectNoErrors();
  await h.stop();
}

console.log("openpets.deadline-buddy: all checks passed.");
