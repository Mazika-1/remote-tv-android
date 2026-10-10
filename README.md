# Remote — Vizio one-button remote (Android app)

This is a real, complete Android Studio project — all the code is already
written. The only thing left is building it once in Android Studio, because
I don't have a way to compile Android apps from where I'm running.

## Why this had to be an app, not a website

Browsers deliberately block **websites** from sending commands to devices
on your home WiFi (to stop random sites from attacking your router, TV,
cameras, etc). Installed apps aren't under that rule — which is why the
real Vizio app can talk to your TV with no extra setup, and why this has to
be a real app too. The one file that matters for this is
`app/src/main/java/dev/mazzen/remote/VizioBridge.kt` — it's the part that
makes the actual network call to your TV from native code, bypassing the
restriction a website would hit.

## Step 1 — Build it (one time, a few minutes)

1. Open **Android Studio** on your computer.
2. **File → Open** → select the `remotetv-android` folder (this folder).
3. Let it "Gradle Sync" (progress bar at the bottom). First time, it may ask
   to install a missing SDK component/build tools version — click **OK** /
   **Install and sync**, accept the license if asked. This is automatic,
   you don't need to pick anything.
4. Plug your Android phone into the computer by USB (or set up wireless
   debugging) and enable **Developer options → USB debugging** on the phone
   if you haven't already (Settings → About phone → tap "Build number" 7
   times → Developer options appears → turn on USB debugging).
5. In Android Studio, pick your phone from the device dropdown at the top,
   then click the green **▶ Run** button. It builds the app and installs it
   on your phone directly — no manual file transfer needed.

(If you'd rather not plug in your phone: **Build → Build App Bundle(s) /
APK(s) → Build APK(s)**, then grab the file from
`app/build/outputs/apk/debug/app-debug.apk`, send it to your phone any way
you like, and tap it to install — Android will ask you to allow installs
from that source once.)

## Step 2 — Set up in the app

Open the app, go to the **Setup** tab:

1. **TV address** — on the Vizio remote: Menu → Network → Network
   Connection → (your WiFi) → look for the IP address (something like
   `192.168.1.xx`). Type it in and tap **Save IP**, then **Test
   connection** to confirm the phone can reach the TV.
2. **Pair with the TV** — tap **Start pairing**, a PIN appears on the TV
   screen, type it in and tap **Submit PIN**.
3. **App launch configs** — there's no universal "resume my show" command
   for streaming apps (I was upfront about this earlier). The workaround
   built in here: open Paramount+ (or Max) on the TV to wherever you want
   Quick Launch to return to, then in the app tap **Capture app currently
   open on TV** for that service. Quick Launch will reopen the app to
   that captured state. Re-capture any time you want to update it.

## Step 3 — Use it

- **Quick Launch** tab — one button per show: turns the TV on (if it's off)
  and opens that show's app. "+1 Ep" just bumps the episode counter you see
  on the card, so you remember where you left off.
- **Shows** tab — add/remove shows, each with a name, streaming service,
  and season/episode counter you update yourself.
- **Remote** tab — normal remote: power, volume, mute, d-pad/OK, back,
  home, menu, input, play/pause, exit.

## Being upfront about what's untested

I don't have your TV, so I couldn't test this against the real device —
everything here is built from Vizio's own published local API behavior and
the well-established `pyvizio` library (used by Home Assistant's Vizio
integration), but a couple of specific things might need a small tweak
once you actually try them:

- **Power-state check** assumes a non-zero value means "on" — if "Quick
  Launch" tries to turn on a TV that's already on, that's the likely cause.
- **App launch** sends the exact config captured from "what's currently
  open" — this is the part most likely to need a retry/re-capture per app,
  since how well each streaming app responds to being reopened this way
  varies.
- Everything on the **Remote** tab (power/volume/dpad/etc.) uses Vizio's
  documented button codes directly and should just work.

If something doesn't work, the **Test connection** button and the error
text shown in the app are meant to tell you exactly what failed (timeout vs.
wrong IP vs. not paired, etc.) rather than failing silently — tell me what
it says and I can adjust the code.
