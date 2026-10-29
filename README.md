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
- GPS is roughly ±5–15 m outdoors. If a catch is refused even though you're touching, stand together for a few seconds and try again.

## Development

There's no build step: it's static HTML, CSS and JavaScript. Leaflet is vendored in `vendor/leaflet`, and the Firebase SDK loads from Google's CDN.

- After changing anything in `js/` or `css/`, run `node tools/bump-version.mjs` so phones load the new files instead of a cached copy.
- Rules source: `tools/build-rules.mjs`. Run `node tools/build-rules.mjs` to regenerate the JSON.
- Rules tests: `node test/rules.test.mjs`. These run against `test/mock-server.mjs`, a small stand-in for Firebase that evaluates the same rules file.
- End-to-end test: `node test/e2e.mjs`. This plays a full game with three simulated phones and fake GPS, and needs Playwright.
