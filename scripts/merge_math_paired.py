#!/usr/bin/env python3
"""One-off migration: fold data/math_paired.jsonl into data/DSPR_dataset.json.

The math_paired records are already fully-perturbed (populated simple/hard with a
match_score) and are what the DSPR/CoTSimilarity model codebase consumes, so their
schema is preferred. We import them verbatim, adding only the app metadata that
app.py needs to display a record (status/source/pulled_at/create_author), and then
delete the now-redundant source file so _collect_all_records() does not double-count.

Reuses app.py's I/O helpers (like llm_generate.py does) so the record shape and
output formatting stay identical to the app's own writes.

Run from the repo root: `python scripts/merge_math_paired.py`.
"""

import sys
from pathlib import Path

# app.py lives in ../backend relative to this script; add it to the import path
# so `from app import ...` resolves no matter where this is invoked from.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app import (
    DATA_DIR,
    DATASET_FILE,
    STATUS_VERIFIED,
    now_iso,
    read_json_array,
    read_jsonl,
    write_json_array,
)

PAIRED_FILE = DATA_DIR / "math_paired.jsonl"


def main() -> None:
    existing = read_json_array(DATASET_FILE)
    paired = read_jsonl(PAIRED_FILE)

    existing_ids = {r.get("problem_id") for r in existing}
    paired_ids = {r.get("problem_id") for r in paired}
    overlap = existing_ids & paired_ids
    if overlap:
        raise SystemExit(
            f"Aborting: {len(overlap)} problem_id(s) overlap between the two files "
            f"(e.g. {sorted(overlap)[:10]}). No changes made."
        )

    stamp = now_iso()
    imported = []
    for rec in paired:
        merged = dict(rec)  # preserve match_score and native answer types as-is
        merged["status"] = STATUS_VERIFIED
        merged["source"] = "MATH"
        merged["pulled_at"] = stamp
        merged["create_author"] = "MATH-Perturb"
        imported.append(merged)

    combined = existing + imported
    write_json_array(DATASET_FILE, combined)

    PAIRED_FILE.unlink()

    print(f"Merged {len(existing)} + {len(imported)} -> {len(combined)} records "
          f"into {DATASET_FILE.name}")
    print(f"Deleted {PAIRED_FILE.relative_to(DATA_DIR.parent)}")


if __name__ == "__main__":
    main()
