# Shiny Atlas

A split-file frontend for inspecting Pokémon GO spawn records from a mapper. Files: `index.html`, `styles.css`, `app.js`. `server.mjs` is a no-dependency local server and API proxy.

**The page retrieves spawn data and includes a local account-specific shiny-roll predictor.** The predictor follows a public reverse-engineered SHA-1 + Java `Random` implementation and is tested against published reference vectors. It still requires an internal game Player ID and a verified numeric encounter ID; a 12-digit Friend Code cannot be used directly.

## Location and deployment

Search area defaults to the device's current location when the coordinates field is left blank. You can override it using one field in `latitude,longitude` format, for example `25.038252,121.566607`. Browser location permission is required when the field is blank.

**Important:** GitHub Pages only serves static files; it cannot run the `/api/iflowgo-nearby` Node endpoint. Deploy the full app as a Node web service using the included [render.yaml](render.yaml), then open the deployed service URL (not the GitHub Pages URL). The service calls iFlowGo from the server. If the provider itself returns HTTP 504, Shiny Atlas now reports that as an upstream timeout rather than implying the search succeeded; provider availability cannot be guaranteed by this repository.


## Data sources

### 1. iFlowGo nearby feed — available to try without your own mapper

The default connector calls this third-party endpoint through the local server:

`https://pokecoords.iflowgo.com/iflowgopokecoords/api/v1/nearby`

It is documented in recent public integration code from the [Lucario/Moonani coordinates bot](https://github.com/KernelX-debug/Discord-Bot_Lucario_Moonaniphp/blob/main/iflowgo_client.py). That code queries the endpoint using a center location, radius, and `layers=spawns`, then reads a JSON `spawns` array. It treats each record's `id` as a source spawn ID and reads species, coordinates, expiry, IV/CP fields. The endpoint's current availability has not been verified from this environment because outbound network access was unavailable. Its `id` is **not** assumed to be the actual encounter ID.

The app queries only when you press Search; radius is capped at 25 km, result limit at 800 and requests are throttled. Feed availability and third-party rules may change.

### 2. Golbat — if you already run a mapper

Golbat has a documented [`POST /api/pokemon/v3/scan` API](https://github.com/UnownHash/Golbat/blob/main/api.md). Its results include `id` (encounter ID), `spawn_id`, coordinates, Pokémon ID and expiry. It is not a public anonymous service; it needs a running instance populated by a scanner and an API secret.

**Windows PowerShell**

```powershell
$env:GOLBAT_URL = "http://127.0.0.1:8080"
$env:GOLBAT_SECRET = "YOUR_GOLBAT_API_SECRET"
node server.mjs
```

**Linux/macOS**

```sh
GOLBAT_URL="http://127.0.0.1:8080" GOLBAT_SECRET="YOUR_GOLBAT_API_SECRET" node server.mjs
```

Replace the example URL with your actual Golbat base URL and port, then open `http://127.0.0.1:8787`. The secret stays in the Node process environment, not in browser JavaScript. The server binds to loopback by default and should not be exposed publicly as-is.

### 3. Provider JSON URL

Paste a provider-issued JSON URL. It must permit browser CORS and you must have permission to use it. The optional bearer token is sent from the browser but not saved to storage. This can be used for a provider-issued feed URL; PokeXperience advertises mapper JSON/webhook feed access with a paid tier, but its raw feed URL is not publicly documented.

### 4. Local JSON or CSV

Upload a file exported from a mapper. Supported JSON envelopes include an array or an array under `pokemon`, `spawns`, `results`, `records`, `data`, or `items`.

## Run locally

Requires Node.js 18+ (uses native `fetch`). From this directory, run `node server.mjs`; the page will be served at `http://127.0.0.1:8787`.

## Trainer Code → internal Player ID linking

The resolver path is now wired to the **in-house local service** in [shiny-atlas-scanner](https://github.com/belalsalah74/shiny-atlas-scanner). This build intentionally refuses remote linker URLs. Trainer Codes are sent only when you press **Resolve ID** and check the consent confirmation.

The Python service is expected at `http://127.0.0.1:8788/api/resolve`. Run Shiny Atlas and the resolver on the same machine:

```sh
# Generate one secret. Put the exact same value in both terminals.
python -c 'import secrets; print(secrets.token_urlsafe(32))'

# Terminal 1: run Shiny Atlas with the shared secret in its environment
export PLAYER_LINKER_TOKEN='PASTE_THE_GENERATED_SECRET'
node server.mjs

# Terminal 2: run the resolver with the same secret and explicit allowlist
export SHINY_ATLAS_API_TOKEN='PASTE_THE_GENERATED_SECRET'
export SHINY_ATLAS_ALLOWED_CODES="REPLACE_WITH_12_DIGIT_CODE"
export SHINY_ATLAS_SESSION_FACTORY="your_local_adapter:create_session"
python -m scanner_service.server
```

Run the Python service from the `shiny-atlas-scanner` repository's root, with its Python dependencies installed. The allowlist should contain only your own Trainer Code or codes whose owners have given explicit permission. Never commit tokens or session credentials.

**Live status:** the protobuf parsing, game-map raid selection, friend-search → lobby-invite ID correlation, loopback API, and mock tests are implemented. The actual authenticated game-session transport adapter referenced by `SHINY_ATLAS_SESSION_FACTORY` is still missing and must be implemented and tested on the target Pokémon GO version. Until then the service deliberately returns `not_configured`; no fake Player ID is returned. The service has no CEA/Poliswag resolver dependency and does not query a mapper to discover the Player ID.

## Account-specific prediction

`shiny-roll.js` implements the following documented reverse-engineered flow entirely in the browser:

1. Convert the encounter ID to an unsigned 64-bit integer and serialize it as eight little-endian bytes.
2. Append the internal Player ID as UTF-8.
3. SHA-1 the concatenated bytes; read the first eight digest bytes as a little-endian integer, XOR with Java's `Random` multiplier and mask to 48 bits.
4. Perform the first Java LCG update and compare the resulting 24-bit draw against `ceil(2^24 / odds)`.

Reference implementation: https://github.com/rubendgpedrosa/Poliswag/blob/main/modules/shiny_roll.py
Reference vectors / cross-checks: https://github.com/rubendgpedrosa/Poliswag/blob/main/tests/modules/test_shiny_roll.py
Golbat project: https://github.com/UnownHash/Golbat

Run `node test-shiny-roll.mjs` to test the browser implementation against the reference vectors. It requires Node.js 18+.

## Limitations

1. The iFlowGo integration is based on a recent public client but its live availability could not be tested from this environment.
2. Golbat only returns what its own configured scanner has already collected.
3. iFlowGo's plain `id` is treated as a source spawn key rather than an encounter ID, so those rows are not formula-scored unless an explicit `encounter_id` is also present.
4. **Trainer Code linking requires configuration.** The adapter forwards the code only to the resolver you explicitly configure and only when you press Resolve ID. No resolver is bundled. The internal Player ID is not sent to the spawn mapper.
5. The default shiny odds are 1/512. Set the denominator to the applicable odds for the species/encounter source/event; the app does not discover event rates automatically.
6. The roll predicts the random shiny check; it does not yet gate predictions by the current shiny-release status of each species/form/costume. Treat results as candidate predictions until eligibility is checked.
7. Pokémon GO and its services are third-party products. Use only data sources and tools you are authorized to access.
