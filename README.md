# Manhunt

Real-world hide and seek for phones (iPhone and Android), played in the browser. No app store needed.

It plays like **Hide Tag**, with the same rules and defaults (see `docs/hide-tag-reference.md`). On top of that, the server checks catches and power-ups so nobody can cheat, and everything is announced out loud so the phone can stay in your pocket.

Hiders get a head start, then hunters chase them. Caught hiders join the hunters. Hunters win if they catch everyone before time runs out.

## The rules (Hide Tag defaults, all adjustable in the lobby)

- **Play area**: 500 m. After the head start it slowly shrinks to 70 %. Outside it for 60 s and the game asks if you're out.
- **Game**: 25 min hunt after a 4 min head start. During the head start hunters wait, and hiders can see them.
- **Reveal** (every 90 s, shared by all hunters): every hider shows up as a 100 m circle somewhere around them. Hiders within 40 m of each other share one circle. The hider is told only half the time, 10 s later.
- **Freeze** (120 s cooldown): every hider within 200 m of *any* hunter gets 20 s to find cover, then must hold still for 60 s. Moving more than 15 m restarts the hold, or eliminates you with strict holds.
- **Running** faster than 10 km/h leaves footprints for 3 minutes and uses up 60 s of stamina, which refills in about 90 s of walking. You get a warning 5 s before you run out. Keep running with none left and you're out.
- **Camping**: stay within 50 m of one spot for 10 min and it burns. Hunters see you, and you have 60 s to get out of the 60 m burned area.
- **Missions**: two yellow circles appear. A hider must step into one within 5 min and stay 3 min. Succeed and every hider gets 2 power-ups. Fail and every hider is shown to the hunters for a minute, and every hunter gets 2 power-ups.
- **Supplies**: 4 caches per side at the start, then a new one per side every minute. Walk within 20 m to collect. Everyone also gets one free power-up at the whistle.
- **"Was that fair?"** As in Hide Tag, the game never eliminates you on GPS alone. When it thinks you're out (outside the area, in a burned spot, out of breath, or moving while frozen), it asks you, and you decide.

### Power-ups

| Hiders | Hunters | Both |
| --- | --- | --- |
| 👻 **Ghost**: no footprints for 80 s | 📡 **Reveal boost**: halves the wait for the next reveal | 🎆 **Flare** (rare): everyone's spot is shown to everyone after 10 s |
| 🛡️ **Ward**: blocks one freeze | 🧊 **Freeze boost**: halves the wait for the next freeze | 🔍 **Scan**: counts the other side within 50, 100 or 200 m |
| 👁️ **Lookout**: see the hunters for 30 s | | |
| 👣 **Decoy**: a fake running trail 150 m away | | |
| 💨 **Smoke bomb**: reveals, scans and flares miss you for 60 s (hunters are told) | | |
| 🤫 **Silence**: reveals miss you for 2 min while you stay still | | |
| 📶 **Jamming**: the next reveal misses you | | |
| 🧭 **Misdirection**: the next reveal lands 50–200 m away | | |

The organiser can take any of them out of the game.

## Sound and voice

Every event has a sound effect and a spoken call-out, for example "You will be frozen! Find cover. 20 seconds", "Out of breath in five seconds. Stop running", "Reveal ready", "Ann was caught. 2 hiders left", "Mission complete" and countdown beeps. You can play with your phone in your pocket. On Android you also get vibrations; iPhones don't let websites vibrate.

- Sound starts after your first tap (phones require this).
- With "Play when the iPhone is on silent" on (the default), sounds play even with the silent switch on.
- Change it in ☰ → Sound and voice.

The effects are in `sounds/`. They're built by `tools/build-sounds.py` from [Kenney](https://kenney.nl) CC0 packs plus some synthesised sounds (whistle, siren, sonar, breathing). Call-outs use the phone's built-in voice.

## What stops cheating

The rules are enforced by the database server (`firebase/database.rules.json`), not by the app. A modified app or a mis-tap can't get around them.

- **A catch only counts within reach.** When a hunter taps Catch, the server checks that both phones sent a GPS fix in the last 12 seconds, both are accurate to ±30 m or better, and the phones are within the catch distance (default 10 m). In Hide Tag, you can mark anyone as caught from anywhere.
- **Hunters can't see hiders**, except when the server says a hider is exposed: missed a reveal, outside the area too long, camping, phone offline, a failed mission or a flare.
- **Reveals are honest.** Each hider's phone publishes its circle, and the server rejects any circle that doesn't contain the hider's real position (except Misdirection, which must land the chosen distance away).
- **Freezes are honest.** A hider can only be frozen if a hunter really is in range, and a Ward is used up when it blocks one.
- **Power-ups must be earned.** The server checks you were within range of the cache, or that the mission really was completed or failed, and each one can only be used once.
- **Hunters can't sneak off early.** During the head start, hiders can watch them on their map.
- **Timers use the server clock**, so changing a phone's time does nothing.
- **Overrides are visible.** The organiser can mark someone caught without the GPS check, but everyone sees it was an override.

## Setup (free, about 10 minutes)

### 1. Firebase (the live database)

1. Go to <https://console.firebase.google.com> and create a project. Google Analytics isn't needed.
2. Go to **Build → Authentication → Get started → Sign-in method** and enable **Anonymous**.
3. Go to **Build → Realtime Database → Create database**. Choose **Belgium (europe-west1)** and **Locked mode**.
4. In the Realtime Database **Rules** tab, replace everything with the contents of `firebase/database.rules.json`, then click **Publish**.
5. Go to **Project settings → Your apps → Web (`</>`)** and register an app. Copy the config values into `js/config.js`.

The free Spark plan is far more than a group of friends needs.

### 2. GitHub Pages (the website)

1. Push this folder to a **public** GitHub repo.
2. Go to **Settings → Pages**. Under **Source**, choose **Deploy from a branch**, then select **main** and **/ (root)**.
3. After a minute or so the game is live at `https://<username>.github.io/<repo>/`.

## Playing

- Everyone opens the link and allows location.
- The organiser creates a game, sets the play area and rules, and picks the hunters. Everyone else joins with the 5-letter code.
- **Keep the game open on screen while you play.** Websites can't track location in the background, so the game keeps the screen awake.
- On older iPhones (iOS below 18.4), play in a **Safari tab**, not from a Home Screen icon. Those iOS versions can't keep a Home Screen web app awake.
- GPS is roughly ±5–15 m outdoors. The game smooths it, so people standing still don't drift around the map. For catches and pick-ups it uses your latest reading. If a catch is refused even though you're touching, stand together for a few seconds and try again.
- Tap your name (in the lobby, or bottom-left in a game) to change your name or colour. Each player has their own colour.
- In the lobby, tap **Invite** to show a QR code. Friends scan it with their phone camera to open the game with the code filled in.
- **Organiser handover:** if the organiser leaves, they hand over to the next player. If their phone goes quiet for 45 s, the longest-standing player whose phone is online takes over automatically. That works on any screen, including results, so someone can always take everyone back to the lobby. The organiser can also hand over manually from a player's ⋯ menu.
- The ☰ menu in a game has the player list, invite, sound settings, how to play, and Leave. Friends can join a game that's already running; they join the hunters. Anyone can leave at any time.
- Use the layers button to switch the map between Light, Dark and Satellite. The 3D button tilts the map.

## Development

There's no build step: it's static HTML, CSS and JavaScript. Maps use MapLibre GL with free OpenFreeMap vector tiles (3D buildings) and Esri satellite imagery, with no API key. If MapLibre can't load, the game falls back to the vendored Leaflet with OpenStreetMap tiles (also `?map=leaflet`). The Firebase SDK loads from Google's CDN.

- After changing anything in `js/` or `css/`, run `node tools/bump-version.mjs` so phones load the new files instead of a cached copy.
- Rules source: `tools/build-rules.mjs`. Run `node tools/build-rules.mjs` to regenerate the JSON.
- Movement tests (stamina, footprints, camping, freeze holds): `node test/movement.test.mjs`.
- Rules tests: `node test/rules.test.mjs`. These run against `test/mock-server.mjs`, a small stand-in for Firebase that evaluates the same rules file.
- End-to-end test: `node test/e2e.mjs`. This plays a full game with three simulated phones and fake GPS, and needs Playwright.
