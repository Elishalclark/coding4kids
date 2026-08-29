#!/usr/bin/env python3
"""Apply pending D1 migrations, then record them so they never run twice.

Used by .github/workflows/deploy.yml before every deploy, so the schema and the code
always ship together. Before this, every migration was a manual step someone had to
remember to run *first* — and merging without it meant endpoints 500ing in production
against a database that couldn't serve them.

Usage:
    python3 migrate.py [--database kidvibers] [--dry-run]

Requires wrangler on PATH and a Cloudflare API token with D1 edit permission
(CLOUDFLARE_API_TOKEN in the environment).

Migrations are plain .sql files in migrations/, applied in filename order, so name them
with a zero-padded numeric prefix. Applied filenames are recorded in schema_migrations.

On already-applied migrations: this project's migrations were originally run by hand, so
the tracking table starts out empty while the schema is already partly there. Re-running
a CREATE TABLE IF NOT EXISTS is harmless, but ALTER TABLE ADD COLUMN is not — SQLite has
no IF NOT EXISTS for it. So a failure whose message says the column or table already
exists is treated as "already applied" and recorded, rather than failing the deploy.
Any other failure stops everything before the code ships.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATIONS = os.path.join(HERE, "migrations")

# Errors that mean "this migration's effect is already in place".
ALREADY_APPLIED = re.compile(
    r"duplicate column name|already exists|table \w+ already exists", re.I
)


LOCAL = False   # set by --local; lets this be exercised against a throwaway database


def wrangler(args, database, capture=True):
    where = "--local" if LOCAL else "--remote"
    cmd = ["npx", "--yes", "wrangler", "d1", "execute", database, where, "--yes"] + args
    return subprocess.run(cmd, cwd=HERE, capture_output=capture, text=True)


def applied_set(database):
    """Filenames already recorded. Empty on the very first run."""
    r = wrangler(["--json", "--command", "SELECT filename FROM schema_migrations"], database)
    if r.returncode != 0:
        return set()
    try:
        # wrangler prints some banner text before the JSON on some versions.
        out = r.stdout[r.stdout.index("["):]
        return {row["filename"] for row in json.loads(out)[0]["results"]}
    except (ValueError, KeyError, IndexError):
        return set()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--database", default="kidvibers")
    ap.add_argument("--dry-run", action="store_true", help="list what would run, change nothing")
    ap.add_argument("--local", action="store_true", help="run against the local dev database")
    args = ap.parse_args()
    global LOCAL
    LOCAL = args.local

    if not os.path.isdir(MIGRATIONS):
        print("no migrations/ directory — nothing to do")
        return 0

    files = sorted(f for f in os.listdir(MIGRATIONS) if f.endswith(".sql"))
    if not files:
        print("no migration files — nothing to do")
        return 0

    if args.dry_run:
        print(f"would apply against {args.database}:")
        for f in files:
            print("  ", f)
        return 0

    # The tracking table has to exist before it can be read.
    r = wrangler([
        "--command",
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        "filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    ], args.database)
    if r.returncode != 0:
        print("::error::could not create schema_migrations — check the API token has D1 edit permission")
        print(r.stderr.strip()[:800])
        return 1

    done = applied_set(args.database)
    pending = [f for f in files if f not in done]
    print(f"{len(files)} migration(s) on disk, {len(done)} already applied, {len(pending)} pending")
    if not pending:
        print("nothing to do")
        return 0

    for f in pending:
        print(f"\n── applying {f}")
        r = wrangler(["--file", os.path.join("migrations", f)], args.database)
        if r.returncode != 0:
            blob = (r.stdout or "") + (r.stderr or "")
            if ALREADY_APPLIED.search(blob):
                print(f"   already in place — recording as applied")
            else:
                print(f"::error::migration {f} failed — not deploying")
                print(blob.strip()[:1500])
                return 1
        else:
            print("   ok")
        rec = wrangler([
            "--command",
            "INSERT OR IGNORE INTO schema_migrations (filename, applied_at) VALUES "
            f"('{f}', '{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}')",
        ], args.database)
        if rec.returncode != 0:
            print(f"::error::applied {f} but could not record it — stopping so it isn't re-applied blindly")
            print((rec.stderr or "").strip()[:800])
            return 1

    print(f"\napplied {len(pending)} migration(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
