# Shiny Atlas resolver bridge

This private HTTP bridge connects Shiny Atlas to an already-running Poliswag shiny-link worker. It does not implement the Pokémon GO protocol and is not a public lookup API. It places an allowed code into Poliswag's existing shiny_link queue, then returns the worker's result.

Upstream reference:
- https://github.com/rubendgpedrosa/Poliswag/tree/main/scripts/shiny_linker
- https://github.com/rubendgpedrosa/Poliswag/blob/main/docs/context/shiny.md

## Requirements

- A Poliswag installation with migration 017 or later and a functioning scripts.shiny_linker timer.
- The scanner account, supported game version, hook/worker, database, and runtime guards must already be configured. This bridge cannot make a disconnected or incompatible worker run.
- Python 3.10+ and database access to the Poliswag database.
- Apply schema.sql.
- A long random API token and explicit Trainer Code allowlist.

No live lookup is bundled or claimed. We do not copy Poliswag source files; this service calls its existing database queue. Without the existing scanner/linker stack, this service alone cannot resolve codes.

## Install

~~~sh
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
~~~

Apply schema.sql to the DB_POLISWAG database. Use a database administrator to create the table and then grant the service account limited permissions.

~~~sh
mysql -h 127.0.0.1 -u "$DB_USER" -p "$DB_POLISWAG" < schema.sql
~~~

The upstream linker documentation uses SHINY_LINKER_DB_HOST=127.0.0.1 on the host because a Docker-only database hostname may not resolve outside Docker.

## Environment

Reuse database values from Poliswag's .env or configure them with a systemd EnvironmentFile. Do not commit secrets.

~~~sh
export DB_USER='poliswag_service_user'
export DB_PASSWORD='REPLACE_WITH_DB_PASSWORD'
export DB_POLISWAG='poliswag'
export DB_PORT='3306'
export SHINY_LINKER_DB_HOST='127.0.0.1'
export RESOLVER_API_TOKEN='REPLACE_WITH_A_LONG_RANDOM_SECRET'
export RESOLVER_ALLOWED_TRAINER_CODES='123456789012'
export RESOLVER_HOST='127.0.0.1'
export RESOLVER_PORT='8790'
python app.py
~~~

The sample Trainer Code is a placeholder. The bridge rejects every lookup if the allowlist is empty and returns HTTP 403 for any code not explicitly listed. Add only your own code or codes whose owners gave permission. The service also requires a bearer token and rate-limits the client.

Configure Shiny Atlas with the same token:

~~~sh
PLAYER_LINKER_URL='http://127.0.0.1:8790/api/resolve-trainer'
PLAYER_LINKER_TOKEN='THE_SAME_LONG_RANDOM_SECRET'
node server.mjs
~~~

This loopback URL works only when Shiny Atlas and the bridge share a host. For separate hosts, put the bridge behind a private HTTPS reverse proxy/firewall and use that HTTPS URL; do not expose plain HTTP to the internet.

## API

POST /api/resolve-trainer with Authorization: Bearer RESOLVER_API_TOKEN and JSON body:

~~~json
{"trainerCode":"123456789012"}
~~~

Returns HTTP 202 with a job ID. Poll GET /api/resolve-trainer/<jobId> with the same bearer token. HTTP 202 means pending; HTTP 200 includes playerId and optional trainerName; HTTP 422 means the worker failed; 401/403/429/503 indicate authorization, allowlist, rate-limit, configuration or database errors.

The bridge generates a service job ID and a synthetic numeric ID to place a temporary row in Poliswag's shiny_link table. The row's announced_at is set immediately so it cannot trigger a bot alert. When the worker resolves or fails the row, the bridge copies the result and deletes the synthetic row. A background sweeper checks pending jobs every 15 seconds and prunes finished service records older than seven days.

## Database grants

After applying schema.sql as an administrator, grant SELECT, INSERT, UPDATE, DELETE on both the existing queue and the service table to the service account. Adapt the database and username for your deployment.

~~~sql
GRANT SELECT, INSERT, UPDATE, DELETE ON poliswag.shiny_link
  TO 'poliswag_service_user'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON poliswag.shinyatlas_resolver_jobs
  TO 'poliswag_service_user'@'localhost';
~~~

The bridge does not need scanner-database or Dragonite-account access. The existing Poliswag linker retains those permissions.

## Health and troubleshooting

GET /health reports DB connectivity, token configuration, and allowlist configuration without returning secrets. Jobs can remain pending if the existing linker's timer, worker/account/game version checks, or raid requirements are not satisfied. The 20-minute browser timeout does not cancel a queued job; check the worker before retrying.

## Safety and privacy

Trainer Codes and internal Player IDs are account identifiers. Keep this service private, use HTTPS if it leaves loopback, and resolve only your own code or accounts whose owners consented. Modified-client approaches can violate game terms and put accounts at risk; game updates may also break the upstream hook.
