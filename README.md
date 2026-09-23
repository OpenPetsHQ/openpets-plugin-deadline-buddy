# Deadline Buddy

Deadline Buddy is a standalone OpenPets SDK v3 plugin for manual deadlines and
selectively tracked Google Calendar or Outlook events. Its commands live under
**Plugins → Deadline Buddy**. The nearest active deadline stays in a
host-rendered pinned pet HUD.

## Features

- Add, list, rename, reschedule, complete, and delete manual deadlines.
- Connect Google Calendar or Outlook through Composio-managed authorization.
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
plaintext or unavailable. This is a local identity, not an OpenPets account;
it does not provide cross-device recovery. The Composio API key and HMAC secret
exist only as server-side Worker secrets. Calendar Airmail's existing OAuth
flow and plugin-scoped credentials are not used or modified.

Composio's optional callback identity verifier is not enabled by this broker.
Because a local profile has no browser sign-in identity, maintainers must
approve a host-mediated profile handoff before public rollout. Until then,
keep authorization links private to the local machine and do not share them.

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

The Worker requires these server-side secrets/variables:

- `COMPOSIO_API_KEY` — scoped to the Composio proxy execution and managed
  connected-account operations used by this service.
- `COMPOSIO_IDENTITY_HMAC_KEY` — at least 32 random bytes, used to derive an
  opaque Composio user ID from the local-profile bearer.
- `COMPOSIO_GOOGLE_AUTH_CONFIG_ID` and `COMPOSIO_OUTLOOK_AUTH_CONFIG_ID` —
  managed auth configs set up with the read-only scopes below.

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

## Development and tests

```sh
npm install
npm test
npm run validate
```

The tests use the OpenPets SDK v3 deterministic harness and mocked provider
operations. They cover manual deadline lifecycle, DST conversion, reminder
recovery/retry bounds, snooze/dismiss, selected-event changes/cancellation,
offline behavior, notification options, schedule cleanup, and menu placement.

To try the plugin from an OpenPets source checkout with the host connector:

```sh
OPENPETS_DEV_PLUGIN_PATHS=/absolute/path/to/openpets-plugin-deadline-buddy pnpm dev:desktop
```

Then enable Deadline Buddy in Developer Mode and use its submenu under
**Plugins**. Composio OAuth and actual OS notifications still require a
maintainer-configured broker, auth-config IDs, provider apps/consent setup, and
manual testing on supported operating systems.
