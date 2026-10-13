# Shiny Atlas — source research and implementation status

Research date: 2026-10-11

## Public third-party feed integrated: iFlowGo

The lowest-friction source found is the iFlowGo nearby feed:

`https://pokecoords.iflowgo.com/iflowgopokecoords/api/v1/nearby`

A recent public GitHub project, Lucario / Moonani Discord Pokemon GO Coordinates Bot, queries this endpoint with `lat`, `lon`, `radius_km`, `layers=spawns`, `limit`, and optional Pokémon/IV filters. Its parser expects a JSON object with a `spawns` array. It reads each record's `id` as a source spawn identifier, plus `pokemon_id`, `lat`, `lon`, `expires_at`, CP, level, and IV-related fields. This does **not** prove that this source's `id` is the game's encounter ID; the public integration labels it as `spawn_id`.

Public implementation reference:
https://github.com/KernelX-debug/Discord-Bot_Lucario_Moonaniphp/blob/main/iflowgo_client.py
The endpoint is accessed through a local server proxy to avoid requiring browser CORS support. The proxy only performs a modest, user-triggered nearby query; it limits radius to 25 km, caps result limit at 800, and rate-limits requests. I could not live-test the external endpoint from this execution environment because outbound DNS/network access is unavailable. Therefore the connection is implemented based on a current public integration, but provider availability is not claimed as verified here.

## Self-hosted mapper integration: Golbat

Golbat is an open-source Pokémon GO raw-data processor with a documented REST API. Its `POST /api/pokemon/v3/scan` endpoint queries stored Pokémon records over a geographic bounding box and supports filters and a result limit. Its documented result structure includes encounter ID (`id`), spawn ID (`spawn_id`), coordinates (`lat`, `lon`), species (`pokemon_id`), expiry (`expire_timestamp`), and other map attributes.

API documentation: https://github.com/UnownHash/Golbat/blob/main/api.md
Repository: https://github.com/UnownHash/Golbat

Golbat is software, not a shared public live-spawn service. Its API requires a running instance that is ingesting data from a scanner. The API is authenticated with `X-Golbat-Secret` when configured. This project includes a local Node.js proxy so the API secret remains in an environment variable rather than client-side code. The user must supply their own instance and data feed; no anonymous public Golbat endpoint is bundled.

## Other potential feed

PokeXperience advertises “Mapper data + shiny-possible JSON/webhook feed” as a paid tier feature and a separate “100% Shiny” add-on. Its public pages do not document an anonymous URL for the raw feed. If the user has a provider-issued feed URL, the website's generic JSON feed adapter can attempt to read it if the provider permits browser CORS requests.

Website: https://pokexperience.com/
Changelog: https://pokexperience.pages.dev/changelog/

## What was rejected

The `ashokvarmamatta/pkmspawn` GitHub repository claims to scrape multiple map sites, but has very little public project history and does not establish a stable public API the webpage can rely on. Scraping assorted third-party map pages is brittle and depends on each source's access rules, layout and availability, so it has not been wired in as a default source.

Repository: https://github.com/ashokvarmamatta/pkmspawn

## Shiny prediction formula — implemented

A public implementation was found in Poliswag's `modules/shiny_roll.py`, with test vectors in `tests/modules/test_shiny_roll.py`. The documented algorithm is SHA-1 over the encounter ID serialized as eight little-endian bytes followed by the game's internal Player ID as UTF-8; the first eight digest bytes seed Java's 48-bit `java.util.Random` LCG. Its first 24-bit draw is compared with the shiny odds threshold. The code includes Java/OpenJDK reference vectors and links the draw logic to Golbat PR #423.

Implementation reference:
https://github.com/rubendgpedrosa/Poliswag/blob/main/modules/shiny_roll.py
Test vectors:
https://github.com/rubendgpedrosa/Poliswag/blob/main/tests/modules/test_shiny_roll.py
Golbat reference project:
https://github.com/UnownHash/Golbat

The local browser module `shiny-roll.js` implements the exact byte encoding, unsigned 64-bit encounter IDs (including values larger than JavaScript's safe integer range), SHA-1, Java LCG update, and 24-bit cutoff. `node test-shiny-roll.mjs` passes reference vectors in the downloaded build.

**Critical identifier distinction:** a 12-digit Friend Code is not the internal Player ID used in the calculation. Public reverse-engineering notes describe resolving the internal ID through an authenticated friend/raid-related linking flow, including player IDs observed in raid-lobby invitation data. Shiny Atlas now provides a configurable adapter at `POST /api/link-trainer`; it does not implement or bundle that authenticated resolver. Similarly, arbitrary map `id` fields are not assumed to be encounter IDs: Golbat's documented record `id` is accepted, and other providers need an explicit `encounter_id` field.

The UI's default odds are 1/512 and the denominator is user-configurable. Event rate detection is not implemented. Shiny release eligibility by species, form, and costume is also not yet enforced, so formula positives are candidate RNG outcomes and must be checked against the current release rules.

Community announcement and discussion of account-specific shiny predictions:
https://www.reddit.com/r/PoGoAndroidSpoofing/comments/1x0w54m/shiny_coords_our_pokemon_go_spawn_search_can_now/

## Data integrity and privacy

- The internal Player ID is only read in browser JavaScript and is not sent to iFlowGo, Golbat, or a JSON feed. Trainer-Code linking is only an adapter to an explicitly configured resolver; the 12-digit Friend Code cannot be substituted for the internal ID.
- The Golbat API secret is read by `server.mjs` from `GOLBAT_SECRET`; do not publish it in client-side files.
- The frontend only calculates when an internal Player ID is provided and the encounter ID is verified by source contract or an explicit `encounter_id` field. Generic `shiny` fields are displayed separately as source-provided metadata.
