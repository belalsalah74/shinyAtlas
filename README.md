# Shiny Atlas

A split-file frontend for inspecting Pokémon GO spawn records from a mapper. Files: `index.html`, `styles.css`, `app.js`. `server.mjs` is a no-dependency local server and API proxy.

**The page retrieves spawn data and includes a local account-specific shiny-roll predictor.** The predictor follows a public reverse-engineered SHA-1 + Java `Random` implementation and is tested against published reference vectors. It still requires an internal game Player ID and a verified numeric encounter ID; a 12-digit Friend Code cannot be used directly.

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

The UI's **Resolve ID** button is an adapter, not a built-in account resolver. The 12-digit Trainer Code is not the identifier used by the shiny-roll calculation and cannot be converted to the internal Player ID with a local formula. A resolver must use an authorized, authenticated account-linking/scanner flow and verify that the returned ID belongs to the intended trainer.

Configure a resolver you control before using the button:

```sh
PLAYER_LINKER_URL="https://your-resolver.example/api/resolve-trainer" \
PLAYER_LINKER_TOKEN="your-resolver-bearer-token" \
node server.mjs
```

When clicked, the browser sends `POST /api/link-trainer` to the local Node server. That route forwards `{"trainerCode":"123456789012"}` only to the explicitly configured `PLAYER_LINKER_URL`, optionally with an Authorization Bearer token. The linker must return JSON containing `playerId` or `player_id`, optionally with `trainerName`/ `trainer_name`. The server validates the returned ID format before the browser fills the internal-ID field. Without a configured URL, the route returns HTTP 503 and sends the Trainer Code nowhere. The app does not bundle a real account resolver, and no live account lookup has been verified.

Detailed flow, code pointers, trust boundaries, and failure cases: [Trainer ID resolution notes](TRAINER-ID-RESOLUTION.md).

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
