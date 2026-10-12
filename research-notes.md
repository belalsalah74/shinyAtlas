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

## Shiny prediction formula status

Recent community discussion says the per-account shiny method uses a relationship involving trainer UUID, spawn ID and encounter ID, and that a trainer identifier can be obtained through a friend-related protocol flow. However, the actual formula, constants, canonical input encoding, and a test vector/reference implementation were not present in the public material located during this research. Therefore the webpage does not calculate or claim account-specific shiny outcomes.

Community discussion: https://www.reddit.com/r/TheSilphRoad/comments/1x15qsx/removed/
PogoCoordinates announcement: https://www.reddit.com/r/PoGoAndroidSpoofing/comments/1x0w54m/shiny_coords_our_pokemon_go_spawn_search_can_now/
Eevx announcement: https://www.reddit.com/r/PoGoAndroidSpoofing/comments/1x1ce1c/eevx_now_does-guaranteed-shiny-sniping-for-your/

## Data integrity and privacy

- Trainer Code is not sent to iFlowGo, Golbat, or any JSON feed. It is validated locally and currently reserved for a future, verified prediction module.
- The Golbat API secret is read by `server.mjs` from `GOLBAT_SECRET`; do not publish it in client-side files.
- The frontend intentionally labels all records “Prediction unavailable” unless a feed explicitly supplies an account-prediction field (`predicted_shiny`, `is_shiny_for_trainer`, `shiny_for_account`, or `account_shiny`). Generic `shiny` fields are displayed separately as source-provided metadata and are not treated as the new account-specific calculation.
