# Shiny Atlas

A split-file frontend for inspecting Pokémon GO spawn records from a mapper. Files: `index.html`, `styles.css`, `app.js`. `server.mjs` is a no-dependency local server and API proxy.

**The page retrieves spawn data; it is not yet an account-specific shiny predictor.** The complete formula was not found in a publicly verifiable implementation, so the page does not invent shiny results.

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

## Limitations

1. The iFlowGo integration is based on a recent public client but its live availability could not be tested here.
2. Golbat only returns what its own configured scanner has already collected.
3. The current iFlowGo integration yields a source `id` but does not establish that it is an encounter ID. This matters for the proposed prediction formula.
4. A verified account-specific shiny formula/reference implementation is still missing from the public evidence located during research. The page does not mark spawns shiny based on ordinary map `shiny` flags.
5. Pokémon GO and its services are third-party products. Use only data sources and tools you are authorized to access.
