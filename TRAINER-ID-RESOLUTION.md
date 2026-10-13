# Trainer Code → internal Player ID resolution

## Summary

Shiny Atlas needs the game's **internal Player ID** for its local shiny-roll calculation. The 12-digit Trainer Code shown in the game is a separate public-facing identifier. It is not an encoding of the internal ID, and there is no reliable mathematical conversion from one to the other.

The code committed here implements the **safe integration boundary** for a resolver you control. It does **not** contain a working Pokémon GO account resolver, credentials, a game login, or a live service that maps codes to internal IDs. Without `PLAYER_LINKER_URL`, clicking **Resolve ID** returns a configuration error and does not transmit the code.

## End-to-end flow

1. **User input — browser.** The Trainer Code field accepts 12 digits. The UI formats digits for readability; before sending, it strips spaces and validates exactly 12 digits.
2. **Explicit action.** Nothing is sent merely because a code is typed. The user must tap **Resolve ID**.
3. **Same-origin API.** `app.js` sends JSON to the local Node endpoint `POST /api/link-trainer`. The browser does not call a third-party resolver directly.
4. **Configuration gate.** `server.mjs` validates the code again. If `PLAYER_LINKER_URL` is empty, it returns HTTP 503 before making any outbound request.
5. **Configured resolver request.** If configured, the server sends `POST` JSON `{ "trainerCode": "123456789012" }` to that exact URL. If `PLAYER_LINKER_TOKEN` is set, it is sent as an Authorization Bearer token. The request has a 30-second timeout and disables fetch caching.
6. **Actual account lookup — external responsibility.** The configured resolver must use an authorized, authenticated method available to its operator. Public reverse-engineering discussions describe a friend/raid-related linking flow in which internal player identifiers can be observed in raid-lobby invitation data (often described as `invited_player_ids`). The precise API, authentication requirements, and current availability are not guaranteed by this repository. The resolver must correlate the returned ID with the intended trainer and verify the identity before returning it; merely finding an ID in a lobby is not sufficient proof that it belongs to the submitted code.
7. **Response validation.** The resolver returns JSON with `playerId` or `player_id`; an optional `trainerName`/ `trainer_name` may be included. The Node adapter accepts only the ID shapes already supported by `ShinyRoll.normalizePlayerId` (16–32 hex characters or 15–24 decimal digits), normalizes the ID to lowercase, and rejects malformed values.
8. **Local calculation.** The browser puts the validated ID in the input field. `shiny-roll.js` uses it locally with a numeric encounter ID. The internal ID is not sent to iFlowGo, Golbat, or the spawn-data feed.

## Code locations

- [Trainer Code field and button — `index.html`](index.html)
- [Input formatting and click handler — `app.js`](app.js): search for `linkTrainerButton.addEventListener('click'`. This validates the 12 digits, posts to `/api/link-trainer`, validates the response through `ShinyRoll.normalizePlayerId`, and fills the Player ID field.
- [Configuration — `server.mjs`](server.mjs): search for `PLAYER_LINKER_URL` and `PLAYER_LINKER_TOKEN`.
- [Proxy and validation handler — `server.mjs`](server.mjs): search for `async function handleLinkTrainer`. It enforces the no-configuration fail-closed behavior, checks the URL protocol, optionally adds the bearer token, uses a timeout, parses JSON, and validates the returned identifier.
- [API route — `server.mjs`](server.mjs): search for `/api/link-trainer` in the request router.
- [Internal ID validation and shiny calculation — `shiny-roll.js`](shiny-roll.js): `normalizePlayerId()` rejects Friend Codes and `predict()` consumes only the normalized internal ID.

## Configure it

Run the server with an endpoint you operate and trust:

```sh
PLAYER_LINKER_URL="https://your-resolver.example/api/resolve-trainer" \
PLAYER_LINKER_TOKEN="replace-with-your-secret" \
node server.mjs
```

The resolver's contract is:

**Request**

```http
POST /api/resolve-trainer
Content-Type: application/json
Authorization: Bearer <configured token>
```

```json
{ "trainerCode": "123456789012" }
```

**Successful response**

```json
{
  "playerId": "0123456789abcdef01234567",
  "trainerName": "Verified trainer"
}
```

The example identifier and trainer name are placeholders, not a real account. The resolver may use `player_id` and `trainer_name` instead. Do not configure a service you do not trust with a Trainer Code.

## Failure behavior

- Invalid or missing 12-digit code: HTTP 400; no upstream request.
- No `PLAYER_LINKER_URL`: HTTP 503; no upstream request.
- Invalid URL/protocol: HTTP 500.
- Upstream timeout/network failure or malformed response: HTTP 502.
- Upstream error: propagated as an error response.
- Missing/invalid internal ID in a successful response: HTTP 502; the browser does not accept it.

## Security and privacy boundary

- A Trainer Code is sent only after the user presses Resolve ID.
- With no configured URL, the code is not sent anywhere.
- When configured, the server necessarily sends the code to that endpoint. Use HTTPS for remote endpoints and a resolver you control.
- The optional bearer token is read from the server environment, not embedded in browser code.
- The code does not log the Trainer Code or persist it to disk.
- The internal Player ID is returned to the browser and used for local prediction; it is not forwarded to the spawn provider.
- The resolver must independently implement authentication, identity matching, rate limiting, and secure handling of any game credentials or session data it uses.

## What remains unfinished

A live Trainer Code lookup is **not** implemented in this repository. This commit adds the UI, server-side adapter, validation, and documented request/response contract only. A working end-to-end result still depends on a lawful, authorized resolver and a verified account-matching flow. The adapter was not tested against a real Pokémon GO account; only its request/response behavior can be validated independently with a mock resolver.
