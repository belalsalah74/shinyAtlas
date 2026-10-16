#!/usr/bin/env python3
"""Private HTTP bridge to an existing Poliswag shiny-link worker."""
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

try:
    import pymysql
    from pymysql.cursors import DictCursor
except ImportError:
    pymysql = None
    DictCursor = None

LOG = logging.getLogger("shinyatlas-resolver")
RESULT_LOG_PATH = os.path.join(os.path.dirname(__file__), "resolved_jobs.json")
PLAYER_ID_RE = re.compile(r"(?:[0-9a-f]{16,32}|[0-9]{15,24})\Z")
JOB_PATH_RE = re.compile(r"/api/resolve-trainer/([0-9a-fA-F-]{36})\Z")
CODE_RE = re.compile(r"[0-9]{12}\Z")
MAX_BODY = 16 * 1024
RATE_LIMIT = 120
RATE_WINDOW_SECONDS = 60
_RATE_LOCK = threading.Lock()
_RATE_BUCKETS = {}


def persist_job_result(job_id, status, player_id=None, trainer_name=None, error=None):
    payload = {
        "jobId": job_id,
        "status": status,
        "playerId": player_id,
        "trainerName": trainer_name,
        "error": error,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    try:
        if os.path.exists(RESULT_LOG_PATH):
            with open(RESULT_LOG_PATH, "r", encoding="utf-8") as handle:
                try:
                    entries = json.load(handle)
                except json.JSONDecodeError:
                    entries = []
        else:
            entries = []
        if not isinstance(entries, list):
            entries = []
        entries.append(payload)
        with open(RESULT_LOG_PATH, "w", encoding="utf-8") as handle:
            json.dump(entries, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
    except Exception as exc:  # pragma: no cover - best effort logging
        LOG.warning("Could not persist resolver result to %s: %s", RESULT_LOG_PATH, exc)


def allowed_codes():
    raw = os.environ.get("RESOLVER_ALLOWED_TRAINER_CODES", "").strip()
    if not raw or raw.lower() in {"*", "any", "all"}:
        return set()
    return {re.sub(r"\D", "", part) for part in raw.split(",") if re.sub(r"\D", "", part)}


def allowlist_enabled():
    raw = os.environ.get("RESOLVER_ALLOWED_TRAINER_CODES", "").strip()
    return bool(raw) and raw.lower() not in {"*", "any", "all"}


def is_allowlisted(trainer_code):
    if not allowlist_enabled():
        return True
    return trainer_code in allowed_codes()


def connect_db():
    if pymysql is None:
        raise RuntimeError("PyMySQL is not installed. Run pip install -r requirements.txt.")
    required = ("DB_USER", "DB_PASSWORD", "DB_POLISWAG")
    missing = [key for key in required if key not in os.environ]
    if missing:
        raise RuntimeError("Missing Poliswag DB environment variables: " + ", ".join(missing))

    host = os.environ.get("SHINY_LINKER_DB_HOST", os.environ.get("DB_HOST", "127.0.0.1"))
    unix_socket = os.environ.get("DB_UNIX_SOCKET") or os.environ.get("MYSQL_UNIX_SOCKET")
    if not unix_socket and host in {"localhost", "127.0.0.1"}:
        for candidate in (
            "/run/user/1000/akonadi/mysql.socket",
            "/run/mysqld/mysqld.sock",
            "/var/run/mysqld/mysqld.sock",
        ):
            if os.path.exists(candidate):
                unix_socket = candidate
                break

    connect_kwargs = {
        "host": host,
        "port": int(os.environ.get("DB_PORT", "3306")),
        "user": os.environ["DB_USER"],
        "password": os.environ["DB_PASSWORD"],
        "database": os.environ["DB_POLISWAG"],
        "charset": "utf8mb4",
        "connect_timeout": 5,
        "read_timeout": 15,
        "write_timeout": 15,
        "autocommit": False,
        "cursorclass": DictCursor,
    }
    if unix_socket:
        connect_kwargs["host"] = "localhost"
        connect_kwargs["unix_socket"] = unix_socket
        connect_kwargs.pop("port", None)

    return pymysql.connect(**connect_kwargs)


def rate_allowed(client_key):
    now = time.monotonic()
    with _RATE_LOCK:
        entries = [(stamp, count) for stamp, count in _RATE_BUCKETS.get(client_key, [])
                   if now - stamp < RATE_WINDOW_SECONDS]
        total = sum(count for _, count in entries)
        if total >= RATE_LIMIT:
            _RATE_BUCKETS[client_key] = entries
            return False
        entries.append((now, 1))
        _RATE_BUCKETS[client_key] = entries
        return True


def resolve_db_status(job_id):
    """Copy one finished Poliswag queue item into the bridge's job table."""
    connection = connect_db()
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT job_id, synthetic_discord_id, status, player_id, trainer_name, error "
                "FROM shinyatlas_resolver_jobs WHERE job_id = %s",
                (job_id,),
            )
            job = cursor.fetchone()
            if not job:
                connection.rollback()
                return None
            if job["status"] != "pending":
                connection.commit()
                return job
            cursor.execute(
                "SELECT status, player_id, trainer_name, fail_reason "
                "FROM shiny_link WHERE discord_id = %s",
                (job["synthetic_discord_id"],),
            )
            source = cursor.fetchone()
            if not source:
                connection.commit()
                return job

            if source["status"] == "linked":
                player_id = str(source.get("player_id") or "").strip().lower()
                if not PLAYER_ID_RE.fullmatch(player_id):
                    cursor.execute(
                        "UPDATE shinyatlas_resolver_jobs SET status='failed', error=%s, "
                        "updated_at=UTC_TIMESTAMP() WHERE job_id=%s",
                        ("Worker returned an invalid internal Player ID.", job_id),
                    )
                    persist_job_result(job_id, "failed", error="Worker returned an invalid internal Player ID.")
                else:
                    cursor.execute(
                        "UPDATE shinyatlas_resolver_jobs SET status='linked', player_id=%s, "
                        "trainer_name=%s, error=NULL, updated_at=UTC_TIMESTAMP() WHERE job_id=%s",
                        (player_id, str(source.get("trainer_name") or "")[:32] or None, job_id),
                    )
                    persist_job_result(job_id, "linked", player_id=player_id, trainer_name=str(source.get("trainer_name") or "")[:32] or None)
                cursor.execute("DELETE FROM shiny_link WHERE discord_id=%s",
                               (job["synthetic_discord_id"],))
            elif source["status"] == "failed":
                reason = str(source.get("fail_reason") or "The Poliswag linker failed.")[:160]
                cursor.execute(
                    "UPDATE shinyatlas_resolver_jobs SET status='failed', error=%s, "
                    "updated_at=UTC_TIMESTAMP() WHERE job_id=%s",
                    (reason, job_id),
                )
                persist_job_result(job_id, "failed", error=reason)
                cursor.execute("DELETE FROM shiny_link WHERE discord_id=%s",
                               (job["synthetic_discord_id"],))

            cursor.execute(
                "SELECT job_id, synthetic_discord_id, status, player_id, trainer_name, error "
                "FROM shinyatlas_resolver_jobs WHERE job_id=%s",
                (job_id,),
            )
            job = cursor.fetchone()
            connection.commit()
            return job
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def sync_pending_jobs():
    """Persist worker completions even if the browser stops polling."""
    connection = None
    try:
        connection = connect_db()
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT job_id FROM shinyatlas_resolver_jobs "
                "WHERE status='pending' ORDER BY created_at LIMIT 100"
            )
            jobs = cursor.fetchall()
        connection.commit()
        for job in jobs:
            try:
                resolve_db_status(job["job_id"])
            except Exception as exc:
                LOG.warning("Could not sync one pending job: %s", type(exc).__name__)
        with connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM shinyatlas_resolver_jobs WHERE status IN ('linked','failed') "
                "AND updated_at < UTC_TIMESTAMP() - INTERVAL 7 DAY"
            )
        connection.commit()
    except Exception as exc:
        LOG.warning("Status sweep failed: %s", type(exc).__name__)
        if connection:
            connection.rollback()
    finally:
        if connection:
            connection.close()


def sweep_forever():
    while True:
        time.sleep(15)
        sync_pending_jobs()


class ResolverHandler(BaseHTTPRequestHandler):
    server_version = "ShinyAtlasResolver/1.0"

    def log_message(self, format_string, *args):
        # Avoid logging Trainer Codes or resolver job IDs.
        return

    def send_json(self, status, payload):
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorize(self):
        expected = os.environ.get("RESOLVER_API_TOKEN", "")
        if not expected:
            self.send_json(503, {"error": "Resolver API token is not configured."})
            return False
        supplied = self.headers.get("Authorization", "")
        if not supplied.startswith("Bearer ") or not hmac.compare_digest(supplied[7:], expected):
            self.send_json(401, {"error": "Unauthorized."})
            return False
        if not rate_allowed(self.client_address[0]):
            self.send_json(429, {"error": "Rate limit exceeded."})
            return False
        return True

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Invalid Content-Length.")
        if length < 1 or length > MAX_BODY:
            raise ValueError("Request body size is invalid.")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("Expected a JSON request body.")
        if not isinstance(payload, dict):
            raise ValueError("Expected a JSON object.")
        return payload

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/health":
            try:
                connection = connect_db()
                connection.close()
                allowlist_configured = allowlist_enabled()
                ready = bool(os.environ.get("RESOLVER_API_TOKEN")) and (not allowlist_configured or bool(allowed_codes()))
                self.send_json(200 if ready else 503, {
                    "status": "ok" if ready else "not_configured",
                    "databaseConnected": True,
                    "allowlistConfigured": allowlist_configured,
                    "apiTokenConfigured": bool(os.environ.get("RESOLVER_API_TOKEN")),
                })
            except Exception:
                self.send_json(503, {
                    "status": "not_ready",
                    "databaseConnected": False,
                    "allowlistConfigured": allowlist_enabled(),
                    "apiTokenConfigured": bool(os.environ.get("RESOLVER_API_TOKEN")),
                })
            return

        match = JOB_PATH_RE.fullmatch(path)
        if not match:
            self.send_json(404, {"error": "Not found."})
            return
        if not self.authorize():
            return
        try:
            job_id = str(uuid.UUID(match.group(1)))
            job = resolve_db_status(job_id)
        except Exception as exc:
            LOG.warning("Job status lookup failed: %s", type(exc).__name__)
            self.send_json(503, {"error": "Could not check resolver job status."})
            return
        if not job:
            self.send_json(404, {"error": "Resolver job not found."})
        elif job["status"] == "linked":
            self.send_json(200, {
                "jobId": job_id,
                "status": "linked",
                "playerId": job["player_id"],
                "trainerName": job.get("trainer_name"),
            })
        elif job["status"] == "failed":
            self.send_json(422, {
                "jobId": job_id,
                "status": "failed",
                "error": job.get("error") or "The Poliswag linker failed this job.",
            })
        else:
            self.send_json(202, {
                "jobId": job_id,
                "status": "pending",
                "pollAfterMs": 3000,
                "message": "Queued; waiting for the Poliswag scanner/linker worker.",
            })

    def do_POST(self):
        if urlsplit(self.path).path != "/api/resolve-trainer":
            self.send_json(404, {"error": "Not found."})
            return
        if not self.authorize():
            return
        try:
            payload = self.read_json()
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
            return

        trainer_code = re.sub(r"\D", "", str(payload.get("trainerCode") or ""))
        if not CODE_RE.fullmatch(trainer_code):
            self.send_json(400, {"error": "Trainer Code must contain exactly 12 digits."})
            return
        if allowlist_enabled() and not is_allowlisted(trainer_code):
            self.send_json(403, {
                "error": "Trainer Code is not allowlisted for this resolver service.",
                "status": "forbidden",
            })
            return

        connection = None
        try:
            connection = connect_db()
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT j.job_id FROM shinyatlas_resolver_jobs j "
                    "JOIN shiny_link l ON l.discord_id=j.synthetic_discord_id "
                    "WHERE j.status='pending' AND l.status='pending' AND l.friend_code=%s "
                    "ORDER BY j.created_at LIMIT 1",
                    (trainer_code,),
                )
                existing = cursor.fetchone()
                if existing:
                    connection.commit()
                    self.send_json(202, {
                        "jobId": existing["job_id"],
                        "status": "pending",
                        "pollAfterMs": 3000,
                    })
                    return

                for _ in range(8):
                    job_id = str(uuid.uuid4())
                    # Reserved upper-half uint64 values separate bridge jobs from real Discord IDs.
                    synthetic_id = secrets.randbelow((1 << 64) - (1 << 63)) + (1 << 63)
                    try:
                        cursor.execute(
                            "INSERT INTO shinyatlas_resolver_jobs "
                            "(job_id, synthetic_discord_id, status, created_at, updated_at) "
                            "VALUES (%s,%s,'pending',UTC_TIMESTAMP(),UTC_TIMESTAMP())",
                            (job_id, synthetic_id),
                        )
                        cursor.execute(
                            "INSERT INTO shiny_link "
                            "(discord_id, discord_name, friend_code, trainer_name, player_id, status, "
                            "fail_reason, attempts, requested_at, resolved_at, announced_at) "
                            "VALUES (%s,%s,%s,NULL,NULL,'pending',NULL,0,UTC_TIMESTAMP(),NULL,UTC_TIMESTAMP())",
                            (synthetic_id, "ShinyAtlas Resolver", trainer_code),
                        )
                        connection.commit()
                        self.send_json(202, {
                            "jobId": job_id,
                            "status": "pending",
                            "pollAfterMs": 3000,
                        })
                        return
                    except Exception as exc:
                        connection.rollback()
                        error_code = exc.args[0] if getattr(exc, "args", None) else None
                        if error_code == 1062:
                            continue
                        raise
                self.send_json(503, {"error": "Could not allocate a resolver job. Try again."})
        except Exception as exc:
            if connection:
                connection.rollback()
            LOG.warning("Could not queue resolver job: %s", type(exc).__name__)
            self.send_json(503, {
                "error": "Could not queue the Trainer Code. Check DB permissions, schema, and scanner worker.",
            })
        finally:
            if connection:
                connection.close()


def main():
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    host = os.environ.get("RESOLVER_HOST", "127.0.0.1")
    port = int(os.environ.get("RESOLVER_PORT", "8790"))
    server = ThreadingHTTPServer((host, port), ResolverHandler)
    threading.Thread(target=sweep_forever, daemon=True, name="resolver-status-sweep").start()
    LOG.info("Resolver bridge listening on %s:%s", host, port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
