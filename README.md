# Deadline Buddy

Deadline Buddy is a standalone OpenPets SDK v3 plugin for manual deadlines and
selectively tracked Google Calendar or Outlook events. Its commands live under
**Plugins → Deadline Buddy**. The nearest active deadline stays in a
host-rendered pinned pet HUD.

## Features

- Add, list, rename, reschedule, complete, and delete manual deadlines.
- Integrate selective, read-only Google Calendar or Outlook tracking when the
  host connection is enabled; it is currently unavailable pending independent
  OAuth identity verification.
- Browse a calendar and select individual future events to track; it does not
  subscribe to every event by default.
- Reconcile selected events for time changes, cancellations, or deletion every
  30 minutes and after reconnect or screen unlock.
- Configure reminders at 1 day, 1 hour, 15 minutes, or the deadline; choose a
  snooze duration; optionally enable sound and operating-system notifications.
- Keep manual deadlines and the last known selected-event snapshots available
  while offline. All scheduled times are absolute instants.
- Recover schedules and overdue reminders after restart or sleep. Automatic
  notification attempts are bounded; uncertain delivery after a crash is not
  automatically repeated. The user can retry it explicitly.

Manual date and time fields use the computer's current IANA timezone and are
converted to an absolute UTC instant when saved. A nonexistent local time in a
daylight-saving transition is rejected. An ambiguous time during a fall-back
transition resolves to its earlier occurrence. Calendar all-day events use the
provider-normalized local end-of-day instant.

## Security and privacy

Calendar access requires the host's `calendar:connect` capability, provided by
the separate OpenPets host integration. Plugin code receives normalized
calendar and event fields only. It never receives provider access tokens,
Composio API keys, Composio connected-account IDs, or arbitrary HTTP access. No
OAuth data is stored in plugin storage or plugin-readable secrets.

The desktop host stores an opaque per-local-profile identity using asynchronous
OS safe storage. On Linux it fails closed if the selected keyring backend is
plaintext or unavailable. This identifies the local profile that initiated a
request; it is not an OpenPets account, does not authenticate the person who
completes OAuth, and does not provide cross-device recovery. Calendar Airmail's
existing OAuth flow and plugin-scoped credentials are not used or modified.

Calendar Connect, connection status, and calendar reads are deliberately
disabled by host PR #217. Composio's Connect Link/callback returns a
`session_uri`, and `complete_auth` accepts the application-supplied owner ID;
neither independently verifies the person who completed provider sign-in.
Matching a connected account to that owner proves only application-level
association, not the browser user's identity. The host therefore rejects
connection activation even if an account is ACTIVE or the one-time
local-profile handoff succeeds. Manual deadlines, their HUD, and reminders
remain available. No live broker deployment or Google/Outlook OAuth has been
tested.

The backend allowlists Google and Microsoft calendar reads, returns a minimized
event shape, and checks the provider, toolkit, auth configuration, and private
connection owner on each request. Event descriptions, attendees, and other raw
provider data are not retained. Disconnect revokes and removes only the
connection for the current local profile and provider.

## Required host/backend setup

The standalone plugin depends on the compatible OpenPets host connector; the
released desktop app cannot use this manifest permission until that host change
is released. The broker must be deployed at the first-party HTTPS origin
configured by the host. Its domain, Cloudflare account, and production status
must be confirmed by OpenPets maintainers before users can connect accounts.
Use a dedicated Composio project and set its project-wide callback to
`https://calendar-broker.openpets.dev/v1/calendar/connect/callback`. The
current broker origin and D1 database ID are placeholders; do not enable
connection verification or deploy until maintainers provision the real route,
database, read-only auth configs, and rate-limit namespaces.

The Worker will require these server-side secrets/variables after maintainers
provision a reviewed identity proof and authorize a staging rollout:

- `COMPOSIO_API_KEY` — scoped to the Composio proxy execution and managed
  connected-account operations used by this service.
- `COMPOSIO_IDENTITY_HMAC_KEY` — at least 32 random bytes, used to derive an
  opaque Composio user ID from the local-profile bearer.
- `COMPOSIO_CALLBACK_ENCRYPTION_KEY` — 32 random bytes encoded as unpadded
  base64url, used to encrypt the deferred callback URI in D1.
- `COMPOSIO_GOOGLE_AUTH_CONFIG_ID` and `COMPOSIO_OUTLOOK_AUTH_CONFIG_ID` —
  managed auth configs set up with the read-only scopes below.
- The deployed Worker currently has no enable flag: its Connect Link,
  callback, status, and read routes are hard-disabled. Do not remove that guard
  or enable OAuth until the independent identity blocker above is resolved and
  the callback route, D1 migration, secrets, rate limits, and query-string
  redaction have passed security review.

In the OpenPets host repository, apply
`apps/calendar-broker/migrations/0001_calendar_connect_attempts.sql` before
enabling the verifier. Redact `session_uri` from Worker, CDN, proxy, and error
logs; the callback necessarily carries it in the request query.

Do not put these values in this repository, the plugin manifest, the desktop
bundle, plugin logs, or user-accessible storage. Set up Composio spending
alerts/limits and monitor rate-limit usage before public rollout. Cloudflare's
Worker Rate Limiting API is approximate and local to a Cloudflare location, so
it is an abuse-control layer, not a strict billing cap.

Requested provider scopes:

- Google: `https://www.googleapis.com/auth/calendar.events.readonly` and
  `https://www.googleapis.com/auth/calendar.calendarlist.readonly`.
- Microsoft Graph: delegated `Calendars.ReadBasic` only.

The Google scopes are documented in [Google Calendar API authorization](https://developers.google.com/workspace/calendar/api/auth). Microsoft documents
`Calendars.ReadBasic` for calendar-view reads in [List calendarView](https://learn.microsoft.com/en-us/graph/api/user-list-calendarview?view=graph-rest-1.0). Composio's managed connection flow is described in its [Connect Link API](https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsLink), with the [Google Calendar](https://docs.composio.dev/toolkits/googlecalendar) and [Outlook](https://docs.composio.dev/toolkits/outlook) toolkits. Check current [Composio pricing](https://composio.dev/pricing) and project quotas before deployment; provider or Composio pricing may change.

Changing the HMAC secret changes every derived Composio user ID and makes
existing local connections unreachable. Plan a migration before rotating it.

## Test in OpenPets

Requires OpenPets Desktop 4.0.0 with SDK v3 plugin support and the
`calendar:connect` host capability from [OpenPets PR #217](https://github.com/OpenPetsHQ/openpets/pull/217),
or a later release containing that capability, with Developer Mode enabled.
Earlier builds and the currently published CLI do not recognize this manifest
permission, so they cannot load or validate this version. The Composio broker
is not needed to load the plugin or use manual deadlines, their HUD, and
reminders. Google/Outlook sign-in still shows unavailable until OpenPets can
independently verify the identity of the person completing OAuth; PR #217
intentionally keeps it disabled.

Clone the standalone repository and check out the feature branch:

```sh
git clone https://github.com/OpenPetsHQ/openpets-plugin-deadline-buddy.git
cd openpets-plugin-deadline-buddy
git fetch origin feat/deadline-buddy
git switch --track origin/feat/deadline-buddy
```

In OpenPets, open **Plugins → Developer Mode → Load Folder** (shown in some
builds as **Load unpacked plugin folder**) and select the cloned repository
root, the folder containing `openpets.plugin.json`. Approve and enable Deadline
Buddy if prompted. Under **Plugins → Deadline Buddy**, select **Add deadline…**,
enter a title such as `Design review`, choose a date and time a few minutes in
the future, and submit. Verify that the nearest deadline appears in the pinned
pet HUD and that its reminder appears at the configured offset. For a quick
reminder check, set the plugin's reminder offsets to **At the deadline** before
creating the sample deadline.

Calendar testing is separate and cannot currently proceed: Google or Outlook
sign-in needs the compatible host, a maintainer-configured first-party Composio
broker, and a security-reviewed identity-verification mechanism that Composio's
current owner-ID callback does not provide. Never enter a shared Composio API
key in the plugin, its settings, or plugin storage.

## Development and tests

```sh
npm install
npm test
npm run validate
```

The tests use the published OpenPets SDK v3 deterministic harness and mocked provider
operations. They cover manual deadline lifecycle, DST conversion, reminder
recovery/retry bounds, snooze/dismiss, selected-event changes/cancellation,
offline behavior, notification options, schedule cleanup, and menu placement.
Until the host permission is released in the public CLI, run manifest validation
with the CLI built from a compatible OpenPets checkout; the current published
CLI intentionally rejects `calendar:connect`.

Manual deadline testing does not require a local OpenPets source checkout.
Real Google/Outlook OAuth and operating-system notification behavior still need
manual validation on a configured host and supported operating system.
