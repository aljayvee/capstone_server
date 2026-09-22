"""
Train both classifiers from the live database, then write them to disk.

Where the labels come from, in order of how much they are worth:

  1. `verified_places`   — an owner catalogued this shop AND chose its category.
                           The cleanest labels in the system.
  2. `errand_pinpoints`  — the category a dispatcher actually committed on a
                           real errand. These are gold: every one of them is a
                           human deciding this exact question, and the ones that
                           were CORRECTED away from a previous guess are the
                           model's only record of where it used to be wrong.
  3. `pabili_details_tbl`— the item side. `storeCategory` here is the composite
                           "Store 2 - Jollibee | Fast Food & Restaurant" that
                           the dispatcher console writes, so the category is
                           whatever follows " | ".

Run it after any meaningful batch of dispatcher corrections:

    python -m sugo_category.train --database-url "mysql+pymysql://user:pass@host/db"

DATABASE_URL from server/.env works directly if you swap the `mysql://` scheme
for `mysql+pymysql://`; --database-url overrides the environment.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .lexicon import CATEGORIES
from .model import CategoryModel

# SQLAlchemy is imported lazily, inside the functions that touch the database.
# `--offline` is the path the Docker build takes by default, and a first install
# should not need a MySQL driver present just to train from the seed lexicon.

DEFAULT_MODEL_DIR = Path(__file__).resolve().parent.parent / "models"


def _normalise_url(url: str) -> str:
    """Accept the server's own DATABASE_URL spelling without hand-editing."""
    if url.startswith("mysql://"):
        return "mysql+pymysql://" + url[len("mysql://") :]
    return url


def fetch_store_rows(engine) -> list[tuple[str, str]]:
    """Shop name -> category, from the catalogue and from committed pins."""
    from sqlalchemy import text

    rows: list[tuple[str, str]] = []

    with engine.connect() as conn:
        # The catalogue. `keywords` carries aliases and misspellings the owner
        # entered by hand ("jollibee, jolibee, chickenjoy") — each becomes its
        # own training row rather than being glued onto the name, so the model
        # learns the alias as a name in its own right.
        for name, keywords, category in conn.execute(
            text(
                """
                SELECT p.name, p.keywords, c.name AS category
                  FROM verified_places p
                  JOIN merchant_categories c ON c.id = p.categoryId
                 WHERE p.isActive = 1
                """
            )
        ):
            if category not in CATEGORIES:
                continue
            rows.append((name, category))
            for alias in (keywords or "").split(","):
                alias = alias.strip()
                if len(alias) >= 3:
                    rows.append((alias, category))

        # What dispatchers actually committed on live errands. Deliberately not
        # de-duplicated: a shop pinned and categorised forty times is forty
        # votes, and that repetition is exactly the signal that it is a common
        # local shop whose name the model should be sure about.
        for store_name, category in conn.execute(
            text(
                """
                SELECT pp.storeName, c.name AS category
                  FROM errand_pinpoints pp
                  JOIN merchant_categories c ON c.id = pp.categoryId
                 WHERE pp.categoryId IS NOT NULL
                   AND pp.storeName IS NOT NULL
                   AND pp.storeName <> ''
                """
            )
        ):
            if category in CATEGORIES:
                rows.append((store_name, category))

    return rows


def fetch_item_rows(engine) -> list[tuple[str, str]]:
    """Item name -> the kind of shop it was bought at."""
    from sqlalchemy import text

    rows: list[tuple[str, str]] = []

    with engine.connect() as conn:
        # Both the working list and the customer's original ask. The working
        # list is the dispatcher's corrected answer and the request list is the
        # customer's own guess; both are real evidence of where a thing is sold,
        # and disagreements between them are ordinary rather than contradictory.
        for table in ("pabili_details_tbl", "pabili_item_requests_tbl"):
            for item_name, raw_category in conn.execute(
                text(
                    f"""
                    SELECT itemName, storeCategory
                      FROM {table}
                     WHERE storeCategory IS NOT NULL
                       AND storeCategory <> ''
                       AND itemName IS NOT NULL
                       AND itemName <> ''
                    """
                )
            ):
                # "Store 2 - Jollibee | Fast Food & Restaurant" -> the half
                # after the pipe. Rows written before the console used the
                # composite form carry the bare category instead.
                category = raw_category.split(" | ")[-1].strip() if raw_category else ""
                if category in CATEGORIES:
                    rows.append((item_name, category))

    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Train the SUGO category models.")
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL", ""),
        help="SQLAlchemy URL. mysql:// is rewritten to mysql+pymysql:// for you.",
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Train from the seed lexicon alone, with no database. Produces a "
        "usable but unspecialised model — intended for a first install.",
    )
    args = parser.parse_args(argv)

    store_rows: list[tuple[str, str]] = []
    item_rows: list[tuple[str, str]] = []

    if not args.offline:
        if not args.database_url:
            parser.error("--database-url (or DATABASE_URL) is required without --offline")
        from sqlalchemy import create_engine

        engine = create_engine(_normalise_url(args.database_url), pool_pre_ping=True)
        store_rows = fetch_store_rows(engine)
        item_rows = fetch_item_rows(engine)

    print(f"store rows from database: {len(store_rows)}")
    print(f"item rows from database:  {len(item_rows)}")

    for kind, rows in (("store", store_rows), ("item", item_rows)):
        model = CategoryModel.train(kind, rows)
        model.save(args.out)
        report = model.report
        accuracy = (
            f"{report.holdout_accuracy:.1%}"
            if report.holdout_accuracy is not None
            # Said plainly rather than printed as 0%: too few real rows to hold
            # any out is not the same as a model that gets everything wrong.
            else "not measured (too few real rows to hold any out)"
        )
        print(
            f"[{kind}] trained on {report.rows} rows "
            f"({report.real_rows} real, {report.synthetic_rows} seed) "
            f"-> holdout accuracy {accuracy}"
        )

    print(f"models written to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
