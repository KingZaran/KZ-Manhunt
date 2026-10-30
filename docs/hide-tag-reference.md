# Hide Tag reference (researched 30 Oct 2026)

Sources: hidetag.app, hidetag.app/rules, the Google Play listing, and the in-game text and
default settings of Hide Tag's browser version (hidetag.app/app). Used only to match game
mechanics; no code or text is copied.

## Teams
Hiders ("runners") vs Hunters. Caught or eliminated Hiders become Hunters. If any Hider
is still free when time runs out, the Hiders win. If no Hiders or Hunters remain, the round
ends with no winner. Leaving mid-game marks you as out, and hosting passes to someone else.

## Defaults
| Setting | Default | Options |
| --- | --- | --- |
| Play area radius | 500 m | 250 / 500 / 1000 / 2000 / 5000 |
| Shrinking play area | on | after the head start, boundary moves towards the centre |
| Final radius | 70 % of start | 50 / 70 / 90 / 100 |
| Game length | 25 min | 15 / 30 / 45 / 60 / 90 |
| Head start | 4 min | 0 / 2 / 5 / 10 |
| Running speed | ≥ 10 km/h | 6 / 8 / 10 / 12 |
| Footsteps last | 180 s | 30 / 60 / 90 / 180 |
| Grace before a trail starts | 3 s | 0 / 2 / 4 / 8 |
| Running available (stamina) | 60 s | 0 (off) / 30 / 60 / 90 |
| Stamina refill (base) | 120 s, boosted 30 % (about 92 s) | 45 / 120 / 180 / 300 |
| Hiders share a reveal circle within | 40 m | 0 / 25 / 40 / 60 |
| Out-of-breath warning | 10 s (warning at 5 s left, can run 5 s below zero) | 0 / 10 / 20 / 45 |
| Freeze range (from ANY hunter) | 200 m | 25 / 50 / 100 / 200 |
| Freeze cooldown (after it ends) | 120 s | 60 / 120 / 180 / 300 |
| Freeze: time to find cover | 20 s | 10 / 20 / 30 |
| Freeze: hold still for | 60 s | 30 / 60 / 90 |
| Freeze: allowed drift | 15 m | 10 / 15 / 25 |
| Strict holds | off: breaking a hold restarts it; on: you're eliminated | |
| Camping: spot burns after | 10 min within 50 m | 5 / 10 / 15 / 30 min |
| Burned area radius | 60 m | 30 / 60 / 100 |
| Grace before elimination (out of area, burned spot) | 60 s | 30 / 60 / 120 |
| Violation must hold for | 2 s | 0 / 2 / 5 |
| Missions per wave | 2 circles | 0 (off) / 2 / 3 / 4 |
| Mission: stay for | 180 s | |
| Mission: start within | 300 s | 180 / 300 / 600 |
| Mission radius | 150 m | 50 / 100 / 150 / 250 |
| Mission reward | 2 power-ups | 1 / 2 / 3 |
| Free hand-out | 1 power-up at the start of the hunt | 0 / 1 / 2 |
| Smoke bomb | 60 s | |
| Silence | 120 s while completely still (50 m GPS tolerance) | |
| Scan | 50 / 100 / 200 m, player picks | |
| Revealed hider is told | 50 % chance, after 10 s | |
| Decoy trail offset | 150 m | |
| Reveal cooldown (shared) | 90 s | 60 / 120 / 300 / 600 |
| Reveal circle radius | 100 m | 25 / 50 / 100 / 200 |
| New supply cache | every 60 s per side | |
| Opening supplies | 4 | |
| Pick-up range | 20 m | 10 / 20 / 40 |
| Ghost | 80 s | |
| Lookout | 30 s | |

## Hunter abilities (buttons: Reveal, Freeze, Catch)
- **Reveal:** red circles for the hunter team. The hider was somewhere inside, and the centre isn't their position. Hiders standing within 40 m share one circle. The circle stays put after it appears. Cooldown is shared.
- **Freeze:** hiders within range of any hunter get a warning ("YOU WILL BE FROZEN — MOVE!", 20 s to find cover), then "YOU ARE FROZEN — HOLD STILL" (60 s, 15 m drift allowed), then they're free again. Hunters see "Froze Ann and Bob", "Blocked by a Ward" or "Nobody within 200 m".
- **Catch:** touch the hider, tap Catch, pick their name. The server checks you're close enough ("X is not close enough").

## Hider rules
- **Running** (at or above 10 km/h) uses stamina and leaves footprints for hunters, after a 3 s grace. Footprints fade from the oldest end. Walking refills stamina. Running out shows "Stop running. Walk to recover", then "out of breath", then elimination.
- **Camping:** staying within 50 m for 10 min burns that spot. Standing in a burned spot starts a 60 s countdown to elimination.
- **Outside the play area:** 60 s countdown to elimination ("Get back inside the play area").
- **Eliminations** ask the player: "Was that fair? The app is guessing from your phone's position…" with the answers "Nope, I played by the rules" (stay a hider) and "Fine, I got eliminated" (become a hunter).
- **Missions:** a wave of 2 yellow circles. Someone must start one within 5 min. Stay 3 min to complete it; others can join, and leaving resets only your own contribution. Completing pays 2 power-ups, and the next pair appears a minute later. Hunters see when a mission is being held. If nobody starts in time, or the last holder leaves after the deadline, hunters see every hider for 1 min and the hunters get power-ups.

## Power-ups
Each side has its own supply caches. Each player collects their own copy, so picking one up never takes it from anyone else. Players also get a free hand-out at the start of the hunt.

| Power-up | Side | Effect |
| --- | --- | --- |
| Reveal boost | Hunters | Removes 50 % of the full reveal cooldown from the remaining wait |
| Freeze boost | Hunters | Removes 50 % of the full freeze cooldown from the remaining wait |
| Ghost | Hiders | No footprints for 80 s |
| Ward | Hiders | Blocks one freeze aimed at you (stacks) |
| Lookout | Hiders | Shows every hunter for 30 s |
| Decoy | Hiders | Lays a fake trail somewhere else (about 150 m away) |
| Smoke bomb | Hiders | You can't be located for 60 s; hunters are told |
| Silence | Hiders | Reveals miss you for 120 s while you stay completely still; you're told when it ends |
| Jamming | Hiders | One protection that makes a reveal miss you (stacks; every reveal uses one) |
| Misdirection | Hiders | The next reveal finds a marker 50 / 100 / 200 m away instead of you; you're shown where it landed |
| Flare (rare) | Both | Captures everyone's location now and shows it to everyone after 10 s; fades over 1 min |
| Scan | Both | Counts the other side within 50 / 100 / 200 m. A count only, never a direction |

## Sounds in Hide Tag
Simple synth beeps plus vibration for: frozen, hold, released, caught/turned, warning,
pickup, revealed, effect, toast, toast-warn, countdown tick/tock, game over.
