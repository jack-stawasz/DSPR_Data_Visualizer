#!/usr/bin/env python3
"""
Client for the CoTSimilarity/DSPR sample-evaluation service.

The heavy evaluation (vLLM solvability + LLM-segmented GED structural similarity)
runs on the remote GPU host inside the CoTSimilarity repo, exposed as a small
FastAPI shim (see ../cot_eval_service/). This module is the *client* the Flask
app talks to over HTTP — reached over the SAME SSH tunnel already used for Ollama
(app.py forwards the shim's port alongside 11434).

Config mirrors llm_generate.py: env vars are read once at import, so
``COT_EVAL_HOST`` etc. must be set in the shell before the server starts
(start.sh exports them from ollama.local.sh).

    COT_EVAL_PORT   remote port the shim listens on / local forward port (default 8100)
    COT_EVAL_HOST   base URL the app POSTs to (default http://localhost:$COT_EVAL_PORT)
    COT_EVAL_N      samples per variant for the solvability pass-rate (default 10)
    COT_EVAL_MODEL  informational model label surfaced in results (the shim owns
                    the real vLLM model choice; default Qwen/Qwen2.5-Math-1.5B-Instruct)

Nothing here imports app.py, so it can be imported lazily by the routes without a
circular dependency (app imports this only when an eval route runs).
"""

import json
import os
import urllib.error
import urllib.request

# --------------------------------------------------------------------------- #
# Config (read once at import, like llm_generate.OLLAMA_HOST)
# --------------------------------------------------------------------------- #
COT_EVAL_PORT = os.getenv("COT_EVAL_PORT", "8100").strip() or "8100"
COT_EVAL_HOST = os.getenv("COT_EVAL_HOST", f"http://localhost:{COT_EVAL_PORT}").strip()
COT_EVAL_MODEL = os.getenv("COT_EVAL_MODEL", "Qwen/Qwen2.5-Math-1.5B-Instruct")

try:
    COT_EVAL_N = max(1, int(os.getenv("COT_EVAL_N", "10")))
except (TypeError, ValueError):
    COT_EVAL_N = 10

# The shim generates N samples (temperature 1.0) then does the DAG/GED work, so a
# pair eval can legitimately run for minutes; give it plenty of headroom. These
# calls happen on a background worker thread, never in a request handler.
_HEALTH_TIMEOUT = 5
_EVAL_TIMEOUT = 900  # 15 min ceiling for a single record's evaluation


def _url(path: str) -> str:
    return COT_EVAL_HOST.rstrip("/") + path


def _ground_truth(variant: dict, record: dict = None, *, is_original: bool = False):
    """Ground-truth answer string for a variant.

    Original records carry the boxed answer at the top level (record["answer"]),
    falling back to the worked solution; authored simple/hard variants carry their
    own "answer".
    """
    if is_original and record is not None:
        return (record.get("answer")
                or (variant or {}).get("solution")
                or (variant or {}).get("answer")
                or "")
    return (variant or {}).get("answer") or (variant or {}).get("solution") or ""


# --------------------------------------------------------------------------- #
# HTTP helpers
# --------------------------------------------------------------------------- #
def probe_eval(timeout: int = _HEALTH_TIMEOUT) -> dict:
    """GET /health on the eval service. Mirrors app._probe_ollama's shape:
    returns {reachable, model, ged_ready, error}."""
    try:
        with urllib.request.urlopen(_url("/health"), timeout=timeout) as resp:
            data = json.load(resp)
        return {"reachable": True,
                "model": data.get("model"),
                "ged_ready": bool(data.get("ged_ready")),
                "error": None}
    except Exception as e:  # noqa: BLE001 - any failure means unreachable
        return {"reachable": False, "model": None, "ged_ready": False,
                "error": f"Cannot reach eval service at {COT_EVAL_HOST} ({e})"}


def _post(path: str, payload: dict, timeout: int = _EVAL_TIMEOUT) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        _url(path), data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(
            f"Eval service returned HTTP {e.code} for {path}: {detail[:400]}") from e
    except Exception as e:  # noqa: BLE001 - connection/timeout/etc.
        raise RuntimeError(
            f"Cannot reach the eval service at {COT_EVAL_HOST} — is the SSH tunnel "
            f"open and the shim running (uvicorn cot_eval_service.app:app --port "
            f"{COT_EVAL_PORT})? ({e})") from e


# --------------------------------------------------------------------------- #
# Public API used by the app's background worker
# --------------------------------------------------------------------------- #
def eval_solvability(record: dict, n: int = None) -> dict:
    """Score how reliably the math model solves the ORIGINAL problem.

    Returns {pass_rate, n, model} (as reported by the shim). Used at the Pull
    stage, where only the original exists.
    """
    n = n or COT_EVAL_N
    orig = record.get("original") or {}
    problem = (orig.get("problem") or record.get("problem") or "").strip()
    if not problem:
        raise RuntimeError("record has no original problem text to evaluate")
    payload = {
        "problem": problem,
        "ground_truth": str(_ground_truth(orig, record, is_original=True)),
        "n": n,
    }
    return _post("/eval/solvability", payload)


def eval_pair(record: dict, n: int = None) -> dict:
    """Full pair evaluation for a Verify-stage record: solvability of
    original/simple/hard plus GED structural similarity of simple & hard vs the
    original's reasoning. Returns the shim's per-variant result dict."""
    n = n or COT_EVAL_N
    orig = record.get("original") or {}
    simple = record.get("simple") or {}
    hard = record.get("hard") or {}
    if not (orig.get("problem") and simple.get("problem") and hard.get("problem")):
        raise RuntimeError("record is missing original/simple/hard problem text")
    payload = {
        "n": n,
        "original": {
            "problem": orig.get("problem", "").strip(),
            "ground_truth": str(_ground_truth(orig, record, is_original=True)),
        },
        "simple": {
            "problem": simple.get("problem", "").strip(),
            "ground_truth": str(_ground_truth(simple)),
        },
        "hard": {
            "problem": hard.get("problem", "").strip(),
            "ground_truth": str(_ground_truth(hard)),
        },
    }
    return _post("/eval/pair", payload)
