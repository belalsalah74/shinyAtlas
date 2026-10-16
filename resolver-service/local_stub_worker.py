#!/usr/bin/env python3
"""Local testing-only resolver worker.

It resolves pending trainer-code rows by writing a valid internal playerId back
into the same Poliswag tables that the bridge reads. This is intentionally not a
real resolver: it is only for local UI and queue testing.
"""

import os
import re
import time

import pymysql
from pymysql import cursors


def connect_db():
    required = ("DB_USER", "DB_PASSWORD", "DB_POLISWAG")
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        raise RuntimeError("Missing DB env vars: " + ", ".join(missing))
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
        "autocommit": False,
        "cursorclass": cursors.DictCursor,
        "connect_timeout": 5,
        "read_timeout": 15,
        "write_timeout": 15,
    }
    if unix_socket:
        connect_kwargs["host"] = "localhost"
        connect_kwargs["unix_socket"] = unix_socket
        connect_kwargs.pop("port", None)
    return pymysql.connect(**connect_kwargs)


def default_mapping():
    return {
        "035287579185": "1d3f7ac9e2684b01",
        "123456789012": "a4c7d2f1e6958b03",
    }


def load_mapping():
    raw = os.environ.get("LOCAL_STUB_PLAYER_IDS", "").strip()
    mapping = default_mapping()
    if not raw:
        return mapping
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        if "=" in item:
            code, player_id = item.split("=", 1)
        else:
            # fallback: code:player_id or code,player_id
            if ":" in item:
                code, player_id = item.split(":", 1)
            else:
                code, player_id = item.split("|", 1)
        code = re.sub(r"\D", "", code.strip())
        player_id = str(player_id).strip().lower()
        if len(code) == 12 and re.fullmatch(r"(?:[0-9a-f]{16,32}|[0-9]{15,24})", player_id):
            mapping[code] = player_id
    return mapping


def resolve_pending_jobs():
    conn = connect_db()
    try:
        mapping = load_mapping()
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT discord_id, friend_code FROM shiny_link WHERE status='pending' ORDER BY requested_at LIMIT 100"
            )
            rows = cursor.fetchall()
            for row in rows:
                code = re.sub(r"\D", "", str(row.get("friend_code") or ""))
                player_id = mapping.get(code)
                if not player_id:
                    continue
                cursor.execute(
                    "UPDATE shiny_link SET status='linked', trainer_name=%s, player_id=%s, fail_reason=NULL, resolved_at=UTC_TIMESTAMP() WHERE discord_id=%s AND status='pending'",
                    ("Local Stub", player_id, row["discord_id"]),
                )
                cursor.execute(
                    "UPDATE shinyatlas_resolver_jobs SET status='linked', player_id=%s, trainer_name=%s, error=NULL, updated_at=UTC_TIMESTAMP() WHERE synthetic_discord_id=%s AND status='pending'",
                    (player_id, "Local Stub", row["discord_id"]),
                )
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    print("Local test stub resolver started. Press Ctrl+C to stop.")
    while True:
        try:
            resolve_pending_jobs()
        except Exception as exc:
            print(f"stub worker error: {exc}")
        time.sleep(5)
