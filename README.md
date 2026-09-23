# Deadline Buddy

Deadline Buddy is a standalone OpenPets SDK v3 plugin for personal deadlines.
Its commands stay under **Plugins → Deadline Buddy**. The nearest active
deadline appears in a pinned pet HUD.

## Features

- Create, list, rename, reschedule, complete, and delete manual deadlines.
- Set reminders for 1 day, 1 hour, 15 minutes, or the deadline. Snooze or
  dismiss alerts, and optionally enable sound and desktop notifications.
- Recover absolute-time reminders after restart or sleep without automatically
  replaying alerts whose delivery was uncertain.
- Use the computer's local timezone. Nonexistent daylight-saving times are
  rejected; ambiguous fall-back times use the earlier occurrence.

Manual deadlines work offline and do not need a calendar connection.

## Google Calendar status

Google Calendar integration is not included in this simplified release. OpenPets
4.0.0's SDK supports host-managed Google OAuth through `ctx.auth.oauth`,
`ctx.auth.refresh`, and `ctx.auth.signOut`, with plugin-scoped encrypted token
storage and the read-only Calendar Events scope. Deadline Buddy has no approved
OAuth client configuration of its own. Calendar Airmail's credentials belong
to that plugin and are not copied or shared. Alvin must provision or approve a
separate Deadline Buddy OAuth client/configuration before Google event tracking
can be added. Outlook is out of scope.

## Test in OpenPets

Requires OpenPets Desktop 4.0.0 or newer with SDK v3 plugin support. Clone the
standalone repository and check out the simplified branch:

```sh
git clone --branch feat/deadline-buddy-simple https://github.com/OpenPetsHQ/openpets-plugin-deadline-buddy.git
```

In OpenPets, open **Plugins → Developer Mode → Load Folder** and select the
cloned repository root, the folder containing `openpets.plugin.json`. Enable
Deadline Buddy if prompted. Under **Plugins → Deadline Buddy**, choose
**Add deadline…**, enter a title such as `Design review`, and choose a date and
time a few minutes ahead. Verify the title and countdown in the pinned pet HUD.
For a quick reminder check, set **Deadline reminders** to **At the deadline**
before creating the sample. When it fires, try Snooze and Dismiss.

## Development

```sh
npm install
npm test
npm run validate
```
