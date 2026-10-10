# Remote — one-tap Vizio TV remote (Android)

Turns on your Vizio TV and opens the streaming app for the show you're
watching, with one tap. Also a full remote (d-pad, volume, playback).

**Download:** grab the latest APK from
[Releases](https://github.com/Mazika-1/remote-tv-android/releases/latest),
open it on your phone and tap to install.

## How it works

1. **Pick your TV.** The app searches your WiFi and lists the Vizio TVs it
   finds by name (e.g. "Living Room TV"). Tap one, then type the PIN shown
   on the TV. You can pair several TVs and switch between them by tapping
   the TV name at the top.
2. **Add a show.** Enter its name and pick the app (HBO Max, Paramount+,
   Netflix…). Popular apps work without any setup.
3. **Teach Play the way to the episode (once).** Tap *Make Play go to the
   episode*. The app opens the streaming app on the TV. Using the buttons
   on your phone, pick the show from **Continue Watching** and start it.
   Then tap Save.
4. **Tap ▶.** The TV turns on, the app reopens fresh, your recorded steps
   run, and the episode is paused at the start. Tap ▶ on the show card
   when you're ready to watch.

### Why steps and not a direct link?

Vizio TVs let other apps *open* a streaming app, but HBO Max and most
others don't take an "open this episode" command. Each show has an
experimental *Try a direct link* option where you paste the episode's
share link from the phone app and test whether the TV opens it. Netflix
links are known to work. The recorded steps work for any app.

To keep steps reliable, the app always reopens the streaming app fresh,
waits until the TV reports it has opened, and waits a bit longer than you
did between presses. If your TV is slow, turn on **Settings → My TV is
slow**.

### Automatic episode tracking

Each show can move to the next episode on its own: **every night**, **only
nights you watch**, or **off**. **Next season** sets the episode back to 1
and adds 1 to the season. The day changes over at 4 AM. Every automatic
change pops up a message with an **Undo** button.

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
