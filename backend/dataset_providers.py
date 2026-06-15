#!/usr/bin/env python3
"""Dataset providers for the DSPR_Training_Data Pull workflow.

Each provider wraps one HuggingFace source behind a common interface so the
frontend can browse / filter / sort / preview / pull problems from any of them
without knowing the underlying schema. Responsibilities are split deliberately:

    * loading           -> DatasetProvider.load_sample (HF streaming)
    * schema normalize  -> DatasetProvider.normalize (per-source)
    * facet/sort meta   -> facet_defs / sorts + compute_facets
    * persistence       -> app.py turns a normalized record into a raw_problems
                           record (this module never touches the filesystem)

The normalized record shape returned by `normalize` is dataset-agnostic:

    {
        "problem":  str,     # always present (non-empty rows only)
        "solution": str,     # worked solution / explanation, may be ""
        "answer":   str|None,# final answer, may be None
        "type":     str,     # primary category -> raw record "type"
        "level":    str,     # MATH difficulty; "" for sources without levels
        <facet keys...>: str # one per entry in facet_defs (for filter/sort)
    }

Adding another HuggingFace dataset is a single new DatasetProvider subclass plus
one line in PROVIDERS — no changes to the Flask routes or the frontend.

This module intentionally imports nothing from app.py: app.py imports it at
module load, so a back-import here would be circular.
"""

from collections import OrderedDict


class DatasetProvider:
    """Base class. Subclasses set the class attributes and implement normalize."""

    id = ""               # url-safe identifier used by the API + frontend tabs
    label = ""            # human label shown on the dataset tab
    description = ""       # one-line blurb shown under the tab
    repo = ""             # HuggingFace repo id
    config = None         # HuggingFace config name (None for most)
    split = "train"       # split to stream from
    source = ""           # value stored in the raw record's "source" field
    abbrev = ""           # short source label shown next to the ID (e.g. "NM")
    facet_defs = []       # [{"key": <normalized key>, "label": <display>}]
    sorts = []            # [{"key": <normalized key>, "label": <display>}]

    # ------------------------------------------------------------------ #
    def describe(self):
        """Metadata for /api/datasets (no record data, no facet values)."""
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "source": self.source,
            "abbrev": self.abbrev,
            "repo": self.repo,
            "facets": self.facet_defs,
            "sorts": self.sorts,
        }

    def normalize(self, row: dict) -> dict:
        """Map one raw HuggingFace row to the normalized record shape."""
        raise NotImplementedError

    def load_sample(self, limit: int) -> list:
        """Stream up to `limit` non-empty normalized records from the source.

        Streaming avoids downloading datasets that are hundreds of thousands to
        millions of rows; we only ever materialize the first `limit` usable rows.
        """
        from datasets import load_dataset

        ds = load_dataset(self.repo, self.config, split=self.split, streaming=True)
        out = []
        # `pos` is the 1-based position in the source stream — the record's id
        # stays true to its dataset (the 4521st row -> id 4521). It counts every
        # streamed row, including ones we skip below, so positions never shift.
        for pos, row in enumerate(ds, start=1):
            try:
                norm = self.normalize(row)
            except Exception:  # noqa: BLE001 - skip a malformed row, keep going
                continue
            if not (norm.get("problem") or "").strip():
                continue
            norm["id"] = pos
            out.append(norm)
            if len(out) >= limit:
                break
        return out

    def compute_facets(self, records: list) -> list:
        """Distinct non-empty values per facet, derived from the loaded sample.

        Filters are generated from the data rather than hardcoded, so a source
        with new categories surfaces them automatically.
        """
        out = []
        for f in self.facet_defs:
            key = f["key"]
            values = sorted(
                {str(r.get(key)).strip() for r in records
                 if r.get(key) not in (None, "")}
            )
            out.append({"key": key, "label": f["label"], "values": values})
        return out


def _norm_level(v):
    """Normalise a level value (5, '5', 'Level 5') to 'Level 5'."""
    if v is None:
        return ""
    s = str(v).strip()
    if not s:
        return ""
    if s.lower().startswith("level"):
        return s
    if s.isdigit():
        return f"Level {s}"
    return s


def _clean(v):
    """Trim a value to a string, or '' for missing."""
    if v is None:
        return ""
    return str(v).strip()


def _answer(v):
    """Final-answer field -> trimmed string or None."""
    if v in (None, ""):
        return None
    s = str(v).strip()
    return s or None


# --------------------------------------------------------------------------- #
# Concrete providers
# --------------------------------------------------------------------------- #
class MathProvider(DatasetProvider):
    """Hendrycks MATH-500 — the existing source, now browsable per-record.

    Uses the same Parquet mirror the legacy bulk pull used (no loading script).
    Level becomes a filter facet (replacing the old level checkboxes).
    """

    id = "math"
    label = "MATH"
    description = "Hendrycks MATH-500 — competition problems with difficulty levels and subjects."
    repo = "HuggingFaceH4/MATH-500"
    config = None
    split = "test"
    source = "MATH"
    abbrev = "MATH"
    facet_defs = [
        {"key": "level", "label": "Level"},
        {"key": "type", "label": "Subject"},
    ]
    sorts = [
        {"key": "level", "label": "Level"},
        {"key": "type", "label": "Subject"},
    ]

    def normalize(self, row):
        return {
            "problem": _clean(row.get("problem") or row.get("question")),
            "solution": _clean(row.get("solution") or row.get("output")),
            "answer": _answer(row.get("answer")),
            "type": _clean(row.get("subject") or row.get("type")),
            "level": _norm_level(row.get("level")),
        }


class NuminaMathProvider(DatasetProvider):
    """AI-MO/NuminaMath-1.5 — olympiad/competition problems.

    Filterable by problem_type (topic), question_type (format), and source.
    """

    id = "numina"
    label = "NuminaMath"
    description = "AI-MO/NuminaMath-1.5 — competition & olympiad problems with topic, format, and source labels."
    repo = "AI-MO/NuminaMath-1.5"
    config = None
    split = "train"
    source = "NuminaMath-1.5"
    abbrev = "NM"
    facet_defs = [
        {"key": "problem_type", "label": "Problem Type"},
        {"key": "question_type", "label": "Question Type"},
        {"key": "source", "label": "Source"},
    ]
    sorts = [
        {"key": "problem_type", "label": "Problem Type"},
        {"key": "source", "label": "Source"},
    ]

    def normalize(self, row):
        problem_type = _clean(row.get("problem_type"))
        return {
            "problem": _clean(row.get("problem")),
            "solution": _clean(row.get("solution")),
            "answer": _answer(row.get("answer")),
            "type": problem_type,
            "level": "",
            "problem_type": problem_type,
            "question_type": _clean(row.get("question_type")),
            "source": _clean(row.get("source")),
        }


class OpenMathInstructProvider(DatasetProvider):
    """nvidia/OpenMathInstruct-2 — problems with generated solutions.

    Filterable by problem_source (the upstream dataset each row came from).
    """

    id = "openmath"
    label = "OpenMathInstruct-2"
    description = "nvidia/OpenMathInstruct-2 — math problems with generated solutions, grouped by problem source."
    repo = "nvidia/OpenMathInstruct-2"
    config = None
    split = "train"
    source = "OpenMathInstruct-2"
    abbrev = "OMI2"
    facet_defs = [
        {"key": "problem_source", "label": "Problem Source"},
    ]
    sorts = [
        {"key": "problem_source", "label": "Problem Source"},
    ]

    def normalize(self, row):
        problem_source = _clean(row.get("problem_source"))
        return {
            "problem": _clean(row.get("problem")),
            "solution": _clean(row.get("generated_solution") or row.get("solution")),
            "answer": _answer(row.get("expected_answer") or row.get("answer")),
            "type": problem_source,
            "level": "",
            "problem_source": problem_source,
        }


# Registry — order here is the order the dataset tabs appear in the UI.
PROVIDERS = OrderedDict(
    (p.id, p)
    for p in (MathProvider(), NuminaMathProvider(), OpenMathInstructProvider())
)


def get_provider(ds_id):
    """Return the provider for `ds_id`, or None if unknown."""
    return PROVIDERS.get(ds_id)
