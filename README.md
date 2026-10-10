# Remote — one-tap Vizio TV remote (Android)

Turns on your Vizio TV and opens the streaming app for the show you're
watching, with one tap. Also a full remote (d-pad, volume, playback).

**Download:** grab the latest APK from
[Releases](https://github.com/Mazika-1/remote-tv-android/releases/latest),
open it on your phone and tap to install.

## How it works

1. **Find your TV.** The first time you open the app, it searches your
   WiFi for the TV. Then you type the PIN that appears on the TV screen.
2. **Add a show.** Enter the name, pick the app (Paramount+, Max, Netflix…)
   and the season and episode you're on.
3. **Tap ▶.** The TV turns on and the app opens. The first time you use an
   app, you'll be asked to open it on the TV once so this app knows which
   one it is.

### What Play does (and doesn't) do

Vizio TVs have no command to open a particular *episode* inside a
streaming app. Play turns on the TV and opens the right app, and your show
is usually first in its "Continue Watching" row. The season/episode on
each card is a reminder for you.

### Automatic episode tracking

Each show can move to the next episode on its own:

- **Every night:** +1 episode each morning.
- **Only nights I watch:** +1 the morning after a night you tapped Play.
- **Off:** use the − / + buttons yourself.

**Next season** sets the episode back to 1 and adds 1 to the season. The
day changes over at 4 AM, so a late-night episode still counts as that
night. Every automatic change pops up a message with an **Undo** button.

## Troubleshooting

- **"Couldn't reach the TV" when it's off:** turn on *Quick Start* on the
  TV (Menu → System → Power Mode) so it can be woken over WiFi.
- **TV not found:** make sure the phone and TV are on the same WiFi. You
  can also type the TV's IP (Menu → Network → Network Connection).
- **Wrong app opens:** Settings → Streaming apps → Re-link, with the right
  app open on the TV.

## Building

GitHub Actions builds the APK and publishes a release on every push (see
`.github/workflows/release.yml`). The release tag comes from `versionName`
in `app/build.gradle`. To build locally, open the project in Android Studio.
