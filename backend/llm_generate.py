#!/usr/bin/env python3
"""Ollama-backed perturbation generator for the DSPR pipeline.

Reads "Original (unperturbed)" records from data/DSPR_dataset.json, asks a
local/remote Ollama model for a simple and a hard perturbation of each,
validates the output, and appends variant records to DSPR_dataset.json with
status "Unverified" (or "Verified" when --auto-verify is set).

Connection: OLLAMA_HOST env var, default http://localhost:11434. For a remote
model, open an SSH tunnel first, e.g.:
    ssh -N -L 11434:localhost:11434 USER@REMOTE_HOST
so localhost:11434 forwards to the remote `ollama serve`. No API key needed.

Model: OLLAMA_MODEL env var, default qwen2.5:7b.

CLI
---
    python llm_generate.py --id 1234        # one problem by problem_id
    python llm_generate.py --count 10       # first N raw problems
    python llm_generate.py --all            # every raw problem
    python llm_generate.py --all --auto-verify --model qwen2.5:7b
"""

import argparse
import json
import logging
import os
import sys

# Reuse the pipeline's file-I/O + record helpers and path constants so the
# record shape stays identical to the web flow (no duplication). Importing
# `app` only constructs the Flask object; it does not start a server.
from app import (
    DATASET_FILE,
    STATUS_ORIGINAL,
    _read_dataset,
    _update_record,
    apply_perturbations,
)

logger = logging.getLogger("llm_generate")

OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
DEFAULT_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:7b")


def _ollama_author(model: str) -> str:
    return f"ollama:{model}"


# --------------------------------------------------------------------------- #
# Prompt + structured-output schema
# --------------------------------------------------------------------------- #
SYSTEM_PROMPT = """You are an expert mathematics problem author creating \
perturbations of competition-style problems for a training dataset.

Given an ORIGINAL problem and its worked solution, produce two new problems:

- "simple": same topic and the SAME core solution method as the original, but \
EASIER — use friendlier numbers, fewer steps, or a more direct structure. A \
student who can solve the original should find this clearly easier.
- "hard": same topic, but HARDER — alter a condition, add a constraint, or \
generalize so that the naive/original approach no longer suffices and more \
insight or work is required.

Rules:
- Preserve the original's mathematical topic and educational intent.
- Each perturbation MUST be a genuinely different problem from the original \
(different wording AND different numbers/structure) — never copy it verbatim.
- Work out each new problem yourself and provide its final answer.
- Answers must be just the final result (a number or expression), formatted in \
LaTeX where appropriate (e.g. \\frac{1}{2}), with no surrounding prose.
- Return ONLY the structured JSON object requested; no commentary."""

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "simple": {
            "type": "object",
            "properties": {
                "problem": {"type": "string"},
                "answer": {"type": "string"},
            },
            "required": ["problem", "answer"],
            "additionalProperties": False,
        },
        "hard": {
            "type": "object",
            "properties": {
                "problem": {"type": "string"},
                "answer": {"type": "string"},
            },
            "required": ["problem", "answer"],
            "additionalProperties": False,
        },
    },
    "required": ["simple", "hard"],
    "additionalProperties": False,
}


# --------------------------------------------------------------------------- #
# Ollama client + generation
# --------------------------------------------------------------------------- #
def _make_client():
    """Construct an Ollama client and verify it is reachable.

    Raises RuntimeError with an actionable message if the package is missing or
    the host (e.g. the SSH tunnel) is not answering.
    """
    try:
        import ollama
    except ImportError as e:  # pragma: no cover - dependency guard
        raise RuntimeError(
            "The 'ollama' package is not installed. "
            "Run: pip install -r requirements.txt"
        ) from e
    client = ollama.Client(host=OLLAMA_HOST)
    try:
        client.list()  # cheap connectivity probe
    except Exception as e:  # noqa: BLE001 - any failure means unreachable
        raise RuntimeError(
            f"Cannot reach Ollama at {OLLAMA_HOST} — is the SSH tunnel open "
            f"(ssh -N -L 11434:localhost:11434 USER@REMOTE_HOST) and "
            f"`ollama serve` running on the remote? ({e})"
        ) from e
    return client


def _build_user_prompt(record: dict) -> str:
    orig = record.get("original") or {}
    problem = (orig.get("problem") or record.get("problem") or "").strip()
    solution = (orig.get("solution") or record.get("solution") or "").strip()
    ptype = record.get("type") or "(unknown)"
    level = record.get("level") or "(unknown)"
    return (
        f"Topic: {ptype}\n"
        f"Difficulty level: {level}\n\n"
        f"ORIGINAL PROBLEM:\n{problem}\n\n"
        f"ORIGINAL WORKED SOLUTION:\n{solution}\n\n"
        "Now produce the 'simple' and 'hard' perturbations."
    )


def generate_variants(client, record: dict, model: str) -> dict:
    """Call Ollama once and return {'simple': {...}, 'hard': {...}}.

    Raises RuntimeError on API or parse failures.
    """
    import ollama  # local: only needed when actually generating

    try:
        response = client.chat(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": _build_user_prompt(record)},
            ],
            format=OUTPUT_SCHEMA,  # Ollama structured output (JSON schema)
            options={"temperature": 0.7},
        )
    except ollama.ResponseError as e:
        raise RuntimeError(f"Ollama API error: {e}") from e
    except Exception as e:  # noqa: BLE001 - connection drop, timeout, etc.
        raise RuntimeError(
            f"Ollama request to {OLLAMA_HOST} failed — is the SSH tunnel still "
            f"open? ({e})"
        ) from e

    text = (response.get("message") or {}).get("content")
    if not text:
        raise RuntimeError("Ollama returned no text content to parse.")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Could not parse Ollama's JSON response: {e}\n{text[:300]}") from e

    if not isinstance(data, dict) or "simple" not in data or "hard" not in data:
        raise RuntimeError(f"Ollama response missing 'simple'/'hard' keys: {text[:300]}")
    return data


def _validate(variants: dict, original_problem: str) -> list:
    """Return a list of human-readable warnings (empty == clean)."""
    warnings = []
    for kind in ("simple", "hard"):
        v = variants.get(kind) or {}
        problem = (v.get("problem") or "").strip()
        answer = (v.get("answer") or "").strip()
        label = kind.capitalize()
        if not problem:
            warnings.append(f"{label} variant has no problem text.")
        elif problem == original_problem.strip():
            warnings.append(f"{label} problem is identical to the original.")
        if not answer:
            warnings.append(f"{label} variant is missing an answer.")
    return warnings


def generate_for_problem(record, *, model=DEFAULT_MODEL, auto_verify=False, client=None) -> dict:
    """Generate + persist simple/hard variants for one raw problem.

    Returns a summary dict {ok, problem_id, file, records, warnings}.
    Raises RuntimeError on hard failures (auth, API, parse, empty output).
    This is the entrypoint the Flask /api/llm_generate route calls.
    """
    if client is None:
        client = _make_client()

    orig = record.get("original") or {}
    original_problem = (orig.get("problem") or record.get("problem") or "").strip()
    pid = record.get("problem_id")

    variants = generate_variants(client, record, model)
    warnings = _validate(variants, original_problem)
    # Block only on a totally unusable variant (empty problem or answer); a
    # "too similar" warning is surfaced but still saved for human review.
    blocking = [w for w in warnings if "no problem text" in w or "missing an answer" in w]
    if blocking:
        raise RuntimeError("Claude output failed validation: " + "; ".join(blocking))

    # Fold both perturbations onto the base record (one entry per problem) and
    # persist the update in place.
    apply_perturbations(record, variants["simple"], variants["hard"],
                        verified=auto_verify, author=_ollama_author(model))
    _update_record(record)

    logger.info("problem_id=%s → simple+hard folded into %s", pid, DATASET_FILE.name)
    return {
        "ok": True,
        "problem_id": pid,
        "auto_verified": auto_verify,
        "file": DATASET_FILE.name,
        "record": record,
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Generate perturbations with Ollama")
    sel = parser.add_mutually_exclusive_group(required=True)
    sel.add_argument("--id", type=int, help="generate for a single problem_id")
    sel.add_argument("--count", type=int, help="generate for the first N raw problems")
    sel.add_argument("--all", action="store_true", help="generate for every raw problem")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"default {DEFAULT_MODEL}")
    parser.add_argument("--auto-verify", action="store_true",
                        help="save straight to DSPR_dataset.json with status 'Verified'")
    args = parser.parse_args()

    records = [r for r in _read_dataset() if r.get("status") == STATUS_ORIGINAL]
    if not records:
        logger.error("No original problems found in %s — pull some first.", DATASET_FILE)
        sys.exit(1)

    if args.id is not None:
        selected = [r for r in records if r.get("problem_id") == args.id]
        if not selected:
            logger.error("No raw problem with problem_id=%s", args.id)
            sys.exit(1)
    elif args.count is not None:
        selected = records[: max(0, args.count)]
    else:  # --all
        selected = records

    try:
        client = _make_client()
    except RuntimeError as e:
        logger.error("%s", e)
        sys.exit(1)

    ok = 0
    for r in selected:
        pid = r.get("problem_id")
        try:
            result = generate_for_problem(
                r, model=args.model, auto_verify=args.auto_verify, client=client
            )
            ok += 1
            if result["warnings"]:
                logger.warning("problem_id=%s warnings: %s", pid, "; ".join(result["warnings"]))
        except RuntimeError as e:
            logger.error("problem_id=%s failed: %s", pid, e)

    logger.info("Done: %d/%d problems generated.", ok, len(selected))


if __name__ == "__main__":
    main()
