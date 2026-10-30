# Manhunt

Real-world hide and seek for phones (iPhone and Android), played in the browser. No app store needed.

Hiders get a head start, seekers hunt them down, and anyone caught joins the seekers. Seekers win if they catch everyone before the time runs out.

## What stops cheating

The rules are enforced by the database server (`firebase/database.rules.json`), not by the app. A modified app or a mis-tap can't get around them.

- **A catch only counts within reach.** When a seeker taps Catch, the server checks that both phones sent a GPS fix in the last 12 seconds, both fixes are accurate to ±30 m or better, and the phones are within the game's catch distance (5–15 m, default 10 m).
- **Seekers can't see hiders**, apart from through Reveals.
- **Reveals are honest.** Each hider's phone publishes a circle around itself, and the server rejects any circle that doesn't contain the hider's real position. All seekers share one cooldown, timed by the server clock.
- **Hiding your phone doesn't help.** A hider is exposed (their exact position is shown to seekers) if they:
  - stop sending their location for longer than the "Exposed when offline for" setting,
  - go outside the play area, or
  - don't answer a Reveal within 20 seconds.
- **Seekers can't sneak off early.** During the head start, hiders can watch the seekers on their map.
- **Timers use the server clock**, so changing a phone's time does nothing.
- **Overrides are visible.** The organiser can mark someone caught without the GPS check if GPS is being awkward, but it's shown to everyone as an override. Hiders can also own up with "I was caught".

## Power-ups

The organiser chooses how many supply drops (purple diamonds) appear on the map. To pick one up, walk within about 12 m of it; the server checks you're really there. You get the power-up for the team you're on, and you can carry up to 3. Tap one in your bar to use it.

| Hiders | Seekers |
| --- | --- |
| **Lookout**: see every seeker for 20 s | **Extra reveal**: reveal now, ignoring the cooldown |
| **Shield**: can't be caught for 30 s | **Tracker**: see one chosen hider exactly for 15 s |
| **Cloak**: left out of reveals for 3 min | **Freeze**: hiders within 75 m must freeze for 20 s, and seekers can see them |

Every effect is enforced by the database rules, the same way catches are. A power-up only switches on by using up a drop you collected, and only for the team you collected it on. Used drops are replaced every couple of minutes by the organiser's phone.

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
- The organiser creates a game, sets the play area and rules, and picks the seekers. Everyone else joins with the 5-letter code.
- **Keep the game open on screen while you play.** Websites can't track location in the background, so the game keeps the screen awake.
- On older iPhones (iOS below 18.4), play in a **Safari tab**, not from a Home Screen icon. Those iOS versions can't keep a Home Screen web app awake.
- GPS is roughly ±5–15 m outdoors. The game smooths it, so people standing still don't drift around the map. For catches and pick-ups it uses your latest reading. If a catch is refused even though you're touching, stand together for a few seconds and try again.
- Tap your name (in the lobby, or bottom-left in a game) to change your name or colour. Each player has their own colour.
- In the lobby, tap **Invite** to show a QR code. Friends scan it with their phone camera to open the game with the code filled in.
- **Organiser handover:** if the organiser leaves, they hand over to the next player. If their phone goes quiet for 45 s, the longest-standing player whose phone is online takes over automatically. That works on any screen, including results, so someone can always take everyone back to the lobby. The organiser can also hand over manually from a player's ⋯ menu.
- The ☰ menu in a game has the player list, how to play, and Leave. Anyone can leave at any time.
- Use the layers button to switch the map between Light, Dark and Satellite. The 3D button tilts the map.

## Development

There's no build step: it's static HTML, CSS and JavaScript. Maps use MapLibre GL with free OpenFreeMap vector tiles (3D buildings) and Esri satellite imagery, with no API key. If MapLibre can't load, the game falls back to the vendored Leaflet with OpenStreetMap tiles (also `?map=leaflet`). The Firebase SDK loads from Google's CDN.

- After changing anything in `js/` or `css/`, run `node tools/bump-version.mjs` so phones load the new files instead of a cached copy.
- Rules source: `tools/build-rules.mjs`. Run `node tools/build-rules.mjs` to regenerate the JSON.
- Rules tests: `node test/rules.test.mjs`. These run against `test/mock-server.mjs`, a small stand-in for Firebase that evaluates the same rules file.
- End-to-end test: `node test/e2e.mjs`. This plays a full game with three simulated phones and fake GPS, and needs Playwright.
