"""
Train both classifiers from the live database, then write them to disk.

Where the labels come from, in order of how much they are worth:

  1. `verified_places`   — an owner catalogued this shop AND chose its category.
                           The cleanest labels in the system.
  2. `errand_pinpoints_tbl` — the category a dispatcher actually committed on a
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

The store model also learns from data/osm_store_names.csv, the OpenStreetMap
shop names (crawler.build_training_data), unless --no-osm.

A Docker build cannot reach the database, and should not hold its password, so
a deploy exports the rows first and trains from the file:

    python -m sugo_category.train --database-url ... --export data/production.json
    python -m sugo_category.train --from-export data/production.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import numpy as np

from .catalogue import Catalogue
from .cleansing import cleanse_real_rows, load_label_issues
from .evaluation import OSM_NAMES, PRODUCTION_CATEGORIES, load_item_benchmark, load_osm_rows, measure
from .model import CategoryModel, _deep_member, normalize

# SQLAlchemy is imported lazily, inside the functions that touch the database.
# `--offline` is the path the Docker build takes by default, and a first install
# should not need a MySQL driver present just to train from the seed lexicon.

DEFAULT_MODEL_DIR = Path(__file__).resolve().parent.parent / "models"

# Not shop names. "Unnamed Road" is what a reverse geocode gives for a pin with
# no shop under it, and production has it labelled as both Fast Food and
# Grocery: one string, two answers, teaching the model nothing true.
_NOT_A_NAME = re.compile(r"^\s*(?:unnamed(?:\s+road)?|no name|n/?a|none|test)\s*$", re.IGNORECASE)


def is_shop_name(name: str | None) -> bool:
    return bool(name and name.strip() and not _NOT_A_NAME.match(name))


def _normalise_url(url: str) -> str:
    """
    Accept the server's own DATABASE_URL spelling without hand-editing.

    Two things have to happen. The scheme becomes `mysql+pymysql://` so
    SQLAlchemy picks a driver that is actually installed, and the query string
    is dropped: production's URL carries Prisma-only parameters such as
    `?connection_limit=...`, which SQLAlchemy forwards verbatim to the driver
    and PyMySQL rejects with

        TypeError: Connection.__init__() got an unexpected keyword argument
        'connection_limit'

    Nothing in that query string means anything to this trainer - it opens one
    short-lived connection, reads a few thousand rows and exits - so discarding
    it is safe rather than merely convenient.
    """
    if url.startswith("mysql://"):
        url = "mysql+pymysql://" + url[len("mysql://") :]
    return url.split("?", 1)[0]


def fetch_category_descriptions(engine) -> dict[str, str]:
    """Each active category's description, which teaches a category the owner created (catalogue.py)."""
    from sqlalchemy import text

    with engine.connect() as conn:
        return {
            name: description or ""
            for name, description in conn.execute(
                text("SELECT name, description FROM merchant_categories WHERE status = 'Active'")
            )
            if name and name.strip()
        }


def fetch_active_categories(engine) -> list[str]:
    """
    The category names this environment actually has.

    Read from the database rather than taken from the lexicon, because
    `merchant_categories` is owner-editable: production carries a "Bakery" the
    lexicon has never heard of, and the first version of this trainer silently
    DROPPED every row labelled with it. A category the owner created is exactly
    the kind the model most needs to learn, since no seed phrase covers it.
    """
    from sqlalchemy import text

    with engine.connect() as conn:
        return [
            name
            for (name,) in conn.execute(
                text("SELECT name FROM merchant_categories WHERE status = 'Active'")
            )
            if name and name.strip()
        ]


def fetch_store_rows(engine, allowed: set[str]) -> list[tuple[str, str]]:
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
            if category not in allowed or not is_shop_name(name):
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
                  FROM errand_pinpoints_tbl pp
                  JOIN merchant_categories c ON c.id = pp.categoryId
                 WHERE pp.categoryId IS NOT NULL
                   AND pp.storeName IS NOT NULL
                   AND pp.storeName <> ''
                """
            )
        ):
            if category in allowed and is_shop_name(store_name):
                rows.append((store_name, category))

    return rows


def fetch_item_rows(engine, allowed: set[str]) -> list[tuple[str, str]]:
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
                # Not filtered against the catalogue here: a row filed under a
                # name since renamed is resolved to its new category in main().
                if category:
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
        help="Train without the database: the seed lexicon and the OpenStreetMap "
        "names, in production's catalogue (evaluation.PRODUCTION_CATEGORIES) unless "
        "--categories says otherwise.",
    )
    parser.add_argument(
        "--categories",
        help="Comma-separated catalogue for --offline. The default is production's six: "
        "an image built offline used to know only the lexicon's four, so it had no Bakery "
        "and filed every bread under Fast Food.",
    )
    parser.add_argument(
        "--export",
        type=Path,
        help="Read the database, write its categories and labelled rows to this "
        "JSON file, and stop without training.",
    )
    parser.add_argument(
        "--from-export",
        type=Path,
        help="Train from a file written by --export instead of the database.",
    )
    parser.add_argument("--osm", type=Path, default=OSM_NAMES, help="OpenStreetMap training names.")
    parser.add_argument("--no-osm", action="store_true", help="Leave the OpenStreetMap names out.")
    args = parser.parse_args(argv)

    store_rows: list[tuple[str, str]] = []
    item_rows: list[tuple[str, str]] = []
    # None means "fall back to the lexicon's own categories" - the offline path.
    allowed: set[str] | None = None
    descriptions: dict[str, str] = {}
    # Gemma's surest cached answers, sent by the service's own retrain (app.py).
    teacher: dict[str, list] = {}
    quality: dict = {}

    if args.from_export:
        data = json.loads(args.from_export.read_text(encoding="utf-8"))
        active = data["categories"]
        descriptions = data.get("descriptions") or {}
        allowed = set(active)
        store_rows = [(name, cat) for name, cat in data["stores"] if is_shop_name(name)]
        item_rows = list(data["items"])
        teacher = data.get("teacher") or {}
        quality = data.get("training_quality") or {}
        print(f"trained from {args.from_export} (exported {data.get('exported_at', 'unknown')})")
        print(f"active categories in this environment: {', '.join(sorted(active))}")
    elif not args.offline:
        if not args.database_url:
            parser.error("--database-url (or DATABASE_URL) is required without --offline")
        from sqlalchemy import create_engine

        engine = create_engine(_normalise_url(args.database_url), pool_pre_ping=True)
        active = fetch_active_categories(engine)
        descriptions = fetch_category_descriptions(engine)
        allowed = set(active)
        print(f"active categories in this environment: {', '.join(sorted(active))}")
        unseeded = Catalogue.of(active, descriptions).custom()
        if unseeded:
            # Worth saying out loud: these have no hand-written seed phrases,
            # only generate_dynamic_seeds' guesses, so the model knows them
            # mostly from real rows. Few real rows means weak predictions for
            # them, which is a data problem, not a bug.
            print(f"categories no built-in vocabulary covers (taught by name, description and rows): {', '.join(unseeded)}")
        store_rows = fetch_store_rows(engine, allowed)
        item_rows = fetch_item_rows(engine, allowed)
        if args.export:
            args.export.parent.mkdir(parents=True, exist_ok=True)
            args.export.write_text(
                json.dumps(
                    {
                        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        "categories": sorted(active),
                        "descriptions": descriptions,
                        "stores": store_rows,
                        "items": item_rows,
                    },
                    ensure_ascii=False,
                    indent=1,
                ),
                encoding="utf-8",
            )
            print(f"exported {len(store_rows)} store and {len(item_rows)} item rows to {args.export}")
            return 0
    elif args.export:
        parser.error("--export reads the database; it cannot be combined with --offline")
    else:
        active = [c.strip() for c in args.categories.split(",") if c.strip()] if args.categories else PRODUCTION_CATEGORIES
        allowed = set(active)
        print(f"offline, catalogue: {', '.join(sorted(allowed))}")

    # The live catalogue, and which built-in vocabulary each category carries
    # (catalogue.py). Only live names are ever trained: the lexicon's own four
    # used to be added unconditionally, so a renamed category's old name stayed
    # a class the model kept answering and the API could not use.
    catalogue = Catalogue.of(allowed, descriptions)
    print(f"catalogue {catalogue.describe()}")
    # Rows filed under a name this catalogue no longer has (renamed since) go
    # to the category carrying that name's role; the rest are dropped.
    store_rows = [(n, catalogue.resolve(c)) for n, c in store_rows if catalogue.resolve(c)]
    item_rows = [(n, catalogue.resolve(c)) for n, c in item_rows if catalogue.resolve(c)]
    allowed = catalogue

    # Cleansing (sugo_category.cleansing): repaired names, quantities off
    # items, kind-word rules, and items still filed under a concept's old
    # parent moved to the concept's own category.
    store_rows, store_clean = cleanse_real_rows(store_rows, "store", catalogue)
    item_rows, item_clean = cleanse_real_rows(item_rows, "item", catalogue)
    for report in (store_clean, item_clean):
        changed = {k: v for k, v in report.as_dict().items() if isinstance(v, int) and v and k not in ("rows_in", "rows_out")}
        print(f"cleansed {report.source}: {report.rows_in} -> {report.rows_out} {changed or ''}")

    print(f"production store rows: {len(store_rows)}")
    print(f"production item rows:  {len(item_rows)}")

    osm_rows = [] if args.no_osm else load_osm_rows(catalogue, args.osm)
    label_issues = load_label_issues()
    print(f"OpenStreetMap store names: {len(osm_rows)} after cleansing, {len(label_issues)} flagged as mislabelled")
    # The unseen-item benchmark stays unseen: Gemma may have been asked about
    # one of its names on a live errand, and teaching that answer would grade
    # the model on its own homework.
    benchmark_names = {normalize(name) for name, _ in load_item_benchmark()}
    teacher_rows = {
        kind: [(name, cat) for name, cat in (teacher.get(kind) or []) if normalize(name) not in benchmark_names]
        for kind in ("store", "item")
    }
    if any(teacher_rows.values()):
        print(f"Gemma answers to learn from: {len(teacher_rows['store'])} store, {len(teacher_rows['item'])} item")
    trained: dict[str, CategoryModel] = {}
    for kind, rows in (("store", store_rows), ("item", item_rows)):
        model = CategoryModel.train(
            kind,
            rows,
            allowed=allowed,
            extra_rows=osm_rows if kind == "store" else None,
            exclude_from_training=label_issues if kind == "store" else None,
            # The item network starts from the store network (transfer learning).
            pretrained=trained.get("store"),
            teacher_rows=teacher_rows[kind],
            excluded_training_names=(quality.get("excluded_training_names") or {}).get(kind, []),
            training_quality=quality.get("summary"),
        )
        # Only the store model's network is needed for the transfer; holding
        # its linear pipeline too would add hundreds of megabytes to a retrain
        # that runs inside the container's 1.5 GB limit.
        trained[kind] = CategoryModel(kind, _deep_member(model.pipeline), model.report) if _deep_member(model.pipeline) is not None else None
        if kind == "item":
            benchmark = load_item_benchmark(model.report.classes)
            if benchmark:
                proba = np.vstack([model.probabilities(name) for name, _ in benchmark])
                result = measure(proba, list(model.pipeline.classes_), [c for _, c in benchmark])
                model.report.evaluation = {**(model.report.evaluation or {}), "benchmark": result}
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
            f"({report.real_rows} real, {report.osm_rows} OpenStreetMap, {report.synthetic_rows} seed) "
            f"in {report.train_seconds} s -> holdout accuracy {accuracy}"
        )
        if report.deep:
            print(
                f"        deep model: {report.deep['parameters']:,} parameters, "
                f"{report.deep['epochs_run']} epochs (best {report.deep['best_epoch']}), "
                f"ensemble weight on the linear model {report.ensemble_weight}"
            )
        if report.evaluation and "benchmark" in report.evaluation:
            bench = report.evaluation["benchmark"]
            print(f"        unseen-item benchmark: {bench['accuracy']:.1%} of {bench['rows']} right")
        if report.evaluation and "test" in report.evaluation:
            test = report.evaluation["test"]
            print(
                f"        {test['rows']} held-out names: {test['coverage']:.1%} get a category, "
                f"{test['accuracy_when_answered']:.1%} of those right; "
                f"{test['auto_accepted']:.1%} auto-accepted at 0.75, {test['accuracy_when_auto']:.1%} right; "
                f"temperature {report.temperature}"
            )

    print(f"models written to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
