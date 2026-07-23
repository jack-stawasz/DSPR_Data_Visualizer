#!/usr/bin/env python3
"""
Flask backend for the DSPR training-data viewer (DSPR_Training_Data/frontend/index.html).

All data lives under DSPR_Training_Data/data/ in a single file, DSPR_dataset.json,
with a "status" field distinguishing record types:

    "Original (unperturbed)" — base problems pulled from a HuggingFace source.
    "Unverified"             — authored simple/hard variants awaiting review.
    "Verified"               — perturbation bundles approved in the Verify tab.

Capabilities
------------
1. Serves frontend/index.html and data/ (static files).
2. Dataset browser (multi-source pull; providers in dataset_providers.py):
     GET  /api/datasets        -> source tabs + their filter/sort metadata.
     GET  /api/dataset_records -> a streamed, normalized sample for one source
                                  plus data-derived facet values.
     POST /api/pull_record     -> append one browsed record to DSPR_dataset.json
                                  with status "Original (unperturbed)".
   POST /api/pull_math remains for the CLI's bulk MATH pull.
3. POST /api/save_variant -> append a perturbation to DSPR_dataset.json with
   status "Unverified" (or "Verified" when auto_verify is set).
4. GET  /api/pending      -> perturbations with status "Unverified".
5. POST /api/verify       -> update a pending bundle in-place to status "Verified".
6. POST /api/reject       -> remove a pending bundle from DSPR_dataset.json.
7. GET  /api/records      -> "Original (unperturbed)" + "Verified" records
   for the browse view.
8. GET  /api/llm_status   -> LLM generation readiness: Ollama reachability,
   GPU info (nvidia-smi, run on the remote host via SSH when GPU_SSH is set),
   and an overall available/reason verdict.
9. POST /api/llm_generate -> generate simple/hard variants with the configured
   LLM (alias of /api/claude_generate; see llm_generate.py).

CLI
---
    python backend/app.py                 # run the web server (default port 8000)
    python backend/app.py serve --port 8000
    python backend/app.py pull --count 50 # pull MATH problems without the server
"""

import argparse
import atexit
import json
import os
import queue
import random
import re
import shlex
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from dataset_providers import PROVIDERS, get_provider

HERE = Path(__file__).resolve().parent          # GitHub/DSPR_Training_Data/backend/
ROOT = HERE.parent                              # GitHub/DSPR_Training_Data/

# All data lives under DSPR_Training_Data/data/ in a single file.
DATA_DIR = ROOT / "data"

DATASET_FILE  = DATA_DIR / "DSPR_dataset.json"

# Status field values — used throughout for filtering, never shown as UI tags.
# Pipeline: Pull → Filter → Generate → Verify, gated by this field.
STATUS_ORIGINAL   = "Original (unperturbed)"   # pulled, not yet filtered
STATUS_KEPT       = "Filtered (kept)"          # passed Filter → Generate's pool
STATUS_REJECTED   = "Filtered (rejected)"      # failed Filter → excluded
STATUS_UNVERIFIED = "Unverified"
STATUS_VERIFIED   = "Verified"

# Non-generated records (no perturbations yet) — the Filter step's working pool.
STATUS_FILTER_POOL = (STATUS_ORIGINAL, STATUS_KEPT, STATUS_REJECTED)

# Candidate HuggingFace sources for the MATH (Hendrycks) dataset, tried in order.
# Each entry: (repo_id, config_name_or_None, split).
# These must be standard Parquet datasets (no loading script): current
# `datasets` versions dropped `trust_remote_code`, so script-based repos
# (lighteval/MATH, EleutherAI/hendrycks_math, hendrycks/competition_math)
# can no longer be loaded here.
MATH_SOURCES = [
    ("HuggingFaceH4/MATH-500", None, "test"),
]

app = Flask(__name__, static_folder=str(ROOT), static_url_path="")


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def read_jsonl(path: Path):
    """Read a newline-delimited JSON file (any .jsonl dropped into data/)."""
    out = []
    if not path.exists():
        return out
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def read_json_array(path: Path):
    """Read a JSON array file, tolerating a missing or malformed file."""
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    return data if isinstance(data, list) else []


def write_json_array(path: Path, records: list):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(records, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def append_json_array(path: Path, record: dict):
    records = read_json_array(path)
    records.append(record)
    write_json_array(path, records)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def extract_boxed(solution: str):
    """Return the contents of the last \\boxed{...} in a solution, or None."""
    if not solution:
        return None
    key = "\\boxed"
    idx = solution.rfind(key)
    if idx == -1:
        return None
    i = idx + len(key)
    while i < len(solution) and solution[i] == " ":
        i += 1
    if i >= len(solution) or solution[i] != "{":
        return None
    depth = 0
    start = i + 1
    for j in range(i, len(solution)):
        if solution[j] == "{":
            depth += 1
        elif solution[j] == "}":
            depth -= 1
            if depth == 0:
                return solution[start:j]
    return None


def _read_dataset() -> list:
    return read_json_array(DATASET_FILE)


def _write_dataset(records: list):
    write_json_array(DATASET_FILE, records)


def _append_dataset(record: dict):
    recs = _read_dataset()
    recs.append(record)
    _write_dataset(recs)


def _find_record(problem_id, status=None):
    """First dataset record matching `problem_id` (and `status`, if given)."""
    for rec in _read_dataset():
        if rec.get("problem_id") == problem_id and (status is None or rec.get("status") == status):
            return rec
    return None


def _update_record(record: dict):
    """Replace the dataset record sharing `record`'s problem_id, then persist.

    The whole-problem record is the unit of update now (one entry per problem),
    so perturbation/verify/reject changes rewrite the matching record in place.
    """
    pid = record.get("problem_id")
    recs = _read_dataset()
    for i, rec in enumerate(recs):
        if rec.get("problem_id") == pid:
            recs[i] = record
            break
    else:
        recs.append(record)
    _write_dataset(recs)
    return record


def _collect_all_records() -> list:
    """All records from DSPR_dataset.json plus every .jsonl file in data/."""
    records: list = _read_dataset()
    if DATA_DIR.exists():
        for path in DATA_DIR.iterdir():
            if path.is_file() and path.suffix == ".jsonl":
                records.extend(read_jsonl(path))
    return records


def existing_problem_texts() -> set:
    """Set of problem strings already present anywhere in the pipeline."""
    texts: set = set()
    for rec in _collect_all_records():
        orig = rec.get("original") or {}
        p = orig.get("problem") or rec.get("problem")
        if p:
            texts.add(p.strip())
    return texts


def next_problem_id() -> int:
    max_id = 0
    for rec in _collect_all_records():
        try:
            max_id = max(max_id, int(rec.get("problem_id", 0)))
        except (TypeError, ValueError):
            pass
    return max_id + 1


def load_math_dataset():
    from datasets import load_dataset

    errors = []
    for repo, cfg, split in MATH_SOURCES:
        try:
            if cfg:
                return load_dataset(repo, cfg, split=split)
            return load_dataset(repo, split=split)
        except Exception as e:  # noqa: BLE001 - try the next source
            errors.append(f"  {repo!r} (config={cfg!r}, split={split!r}): {e}")

    detail = "\n".join(errors)
    raise RuntimeError(
        f"Could not load any MATH dataset source. All attempts failed:\n{detail}"
    )


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


def pull_math(count=20, levels=None, types=None, split="train", seed=0):
    """Pull `count` new MATH problems and append them to DSPR_dataset.json."""
    ds = load_math_dataset()
    seen = existing_problem_texts()
    pid = next_problem_id()

    levels = set(levels) if levels else None
    types = set(types) if types else None

    idxs = list(range(len(ds)))
    random.Random(seed).shuffle(idxs)

    added = []
    for i in idxs:
        if len(added) >= count:
            break
        row = ds[i]
        pos = i + 1  # 1-based position in the MATH-500 stream -> the record's id
        # Field names vary across MATH mirrors: problem/question,
        # solution/answer, type/subject, level int vs "Level N".
        problem = (row.get("problem") or row.get("question") or "").strip()
        solution = (row.get("solution") or row.get("output") or "").strip()
        level = _norm_level(row.get("level"))
        ptype = (row.get("type") or row.get("subject") or "").strip()
        if not problem or not solution:
            continue
        if levels and level not in levels:
            continue
        if types and ptype not in types:
            continue
        if problem in seen:
            continue
        seen.add(problem)
        answer = (str(row.get("answer")).strip() if row.get("answer") else None) \
            or extract_boxed(solution)
        record = {
            "problem_id": pid,
            "id": pos,
            "type": ptype,
            "level": level,
            "original": {"problem": problem, "solution": solution},
            "simple": None,
            "hard": None,
            "answer": answer,
            "source": "MATH",
            "pulled_at": now_iso(),
            "status": STATUS_ORIGINAL,
        }
        _append_dataset(record)
        added.append(record)
        pid += 1

    return added


def _clean_variant(v):
    """Coerce a {problem, answer} perturbation dict to trimmed strings, or None."""
    if not isinstance(v, dict):
        return None
    problem = (v.get("problem") or "").strip()
    answer = (v.get("answer") or "").strip()
    if not problem:
        return None
    return {"problem": problem, "answer": answer}


def apply_perturbations(record: dict, simple, hard, *, verified: bool, author: str = ""):
    """Fold simple/hard perturbations into a base problem record, in place.

    Mirrors the math_paired layout: the perturbations live on the same entry as
    the original, so there is one record per problem rather than separate variant
    rows. Flips the record's status to Unverified (or Verified when auto-verified).
    """
    record["simple"] = _clean_variant(simple)
    record["hard"] = _clean_variant(hard)
    record["create_author"] = (author or "").strip()
    record["status"] = STATUS_VERIFIED if verified else STATUS_UNVERIFIED
    return record


def norm_to_raw(provider, norm: dict, pid: int) -> dict:
    """Turn a provider's normalized browse record into a DSPR_dataset record."""
    # Every facet the provider declares (e.g. NuminaMath's question_type/source,
    # OpenMathInstruct's problem_source) is kept here under its own namespace so
    # it stays filterable later, without colliding with top-level fields like the
    # record's own "source" (the pipeline/provider source, e.g. "NuminaMath-1.5").
    facets = {f["key"]: str(norm[f["key"]]).strip()
              for f in provider.facet_defs if norm.get(f["key"])}
    return {
        "problem_id": pid,
        # `id` is the problem's 1-based position in its source dataset (stays true
        # to that dataset); `problem_id` remains the unique cross-source key.
        "id": norm.get("id"),
        "type": (norm.get("type") or "").strip(),
        "level": (norm.get("level") or "").strip(),
        "original": {
            "problem": (norm.get("problem") or "").strip(),
            "solution": (norm.get("solution") or "").strip(),
        },
        "simple": None,
        "hard": None,
        "answer": (norm.get("answer").strip() if norm.get("answer") else None),
        "source": provider.source,
        "facets": facets,
        "pulled_at": now_iso(),
        "status": STATUS_ORIGINAL,
    }


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return send_from_directory(ROOT / "frontend", "index.html")


@app.route("/data/<path:fname>")
def data_file(fname):
    return send_from_directory(DATA_DIR, fname)


@app.route("/api/health")
def health():
    return jsonify({"ok": True})


def _gpu_status():
    """GPU info via nvidia-smi.

    The Flask server runs locally (in WSL), which has no GPU, so by default
    nvidia-smi is run on the remote Ollama host over SSH. Set GPU_SSH to the
    ssh args for that host (e.g. "-J jump@bastion -p 13010 user@rocco");
    start.sh exports it. When GPU_SSH is empty, nvidia-smi runs locally.

    Informational only: generation runs on the remote Ollama host, so a missing
    GPU here does not by itself make LLM generation unavailable.
    """
    # nounits -> plain integers (MiB) so the frontend gets numbers, not "30380 MiB".
    nvidia = ["nvidia-smi",
              "--query-gpu=index,name,memory.total,memory.used,memory.free",
              "--format=csv,noheader,nounits"]
    gpu_ssh = os.getenv("GPU_SSH", "").strip()
    if gpu_ssh:
        # BatchMode keeps a missing/locked key from hanging on a prompt.
        cmd = (["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]
               + shlex.split(gpu_ssh) + nvidia)
        timeout = 15  # extra headroom: the hop goes through the bastion.
    else:
        cmd = nvidia
        timeout = 5
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        missing = "ssh" if gpu_ssh else "nvidia-smi"
        return {"detected": False, "gpus": [],
                "error": f"{missing} not found on the backend host"}
    except subprocess.TimeoutExpired:
        where = "remote nvidia-smi (SSH)" if gpu_ssh else "nvidia-smi"
        return {"detected": False, "gpus": [], "error": f"{where} timed out"}
    if out.returncode != 0:
        return {"detected": False, "gpus": [],
                "error": (out.stderr or "nvidia-smi failed").strip()}
    gpus = []
    for line in out.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue
        try:
            idx = int(parts[0])
            total, used, free = (int(parts[2]), int(parts[3]), int(parts[4]))
        except ValueError:
            continue  # unexpected row format — skip rather than poison the list
        gpus.append({"index": idx, "name": parts[1],
                     "mem_total_mib": total, "mem_used_mib": used,
                     "mem_free_mib": free})
    gpus.sort(key=lambda g: g["index"])
    return {"detected": bool(gpus), "gpus": gpus,
            "error": None if gpus else "nvidia-smi reported no GPUs"}


# --------------------------------------------------------------------------- #
# Ollama connection + lazy SSH tunnel
# --------------------------------------------------------------------------- #
# The tunnel to a remote Ollama is opened on demand (when the LLM panel calls
# /api/llm_connect), not at server startup — so a session that never touches
# LLM generation never opens an SSH connection. start.sh exports the SSH params
# (SSH_TARGET/SSH_PORT/SSH_JUMP/TUNNEL_PORT) it read from ollama.local.sh; we
# rebuild the same `ssh -N -L` command here and track the process so atexit can
# tear it down (replacing start.sh's old cleanup trap).
_TUNNEL = {"proc": None}


def _config_present() -> bool:
    """True when the user has a local Ollama config (ollama.local.sh)."""
    return (ROOT / "ollama.local.sh").exists()


def _remote_configured() -> bool:
    """True when a remote Ollama over SSH is configured (mirrors start.sh)."""
    return bool(os.getenv("SSH_TARGET", "").strip()
                and os.getenv("TUNNEL_PORT", "").strip())


def _parse_param_size(name: str):
    """Best-effort parameter size from a model name/tag: 'qwen2.5:7b' -> '7B'."""
    m = re.search(r"(\d+(?:\.\d+)?)\s*([bBmM])", name or "")
    return f"{m.group(1)}{m.group(2).upper()}" if m else None


def _model_info(entry: dict) -> dict:
    """Map one /api/tags entry to {full, name, version, parameter_size}.

    parameter_size prefers the reliable details.parameter_size, falls back to a
    string parse of the tag/name, and is "?" when neither yields anything.
    """
    full = entry.get("name", "")
    base, _, tag = full.partition(":")
    details = entry.get("details") or {}
    psize = details.get("parameter_size") or _parse_param_size(tag or full) or "?"
    return {"full": full, "name": base or full,
            "version": tag or "latest", "parameter_size": psize}


def _probe_ollama(timeout: int = 4) -> dict:
    """Probe the configured Ollama host's /api/tags.

    Returns {reachable, models, model_info, error}; shared by status + connect.
    """
    from llm_generate import OLLAMA_HOST
    try:
        with urllib.request.urlopen(OLLAMA_HOST.rstrip("/") + "/api/tags",
                                    timeout=timeout) as resp:
            data = json.load(resp)
        entries = data.get("models", [])
        return {"reachable": True,
                "models": [m.get("name", "") for m in entries],
                "model_info": [_model_info(m) for m in entries],
                "error": None}
    except Exception as e:  # noqa: BLE001 - any failure means unreachable
        return {"reachable": False, "models": [], "model_info": [],
                "error": f"Cannot reach Ollama at {OLLAMA_HOST} ({e})"}


def _tunnel_running() -> bool:
    proc = _TUNNEL["proc"]
    return proc is not None and proc.poll() is None


def _open_tunnel() -> None:
    """Spawn `ssh -N -L <local>:localhost:11434 ...`, tracking the process.

    Mirrors start.sh's tunnel command but without -f, so we keep the handle and
    can read stderr / kill it on exit. BatchMode + ExitOnForwardFailure make it
    fail fast (no password prompt to hang on — key-based auth is required).
    """
    from llm_generate import OLLAMA_HOST
    local_port = urllib.parse.urlparse(OLLAMA_HOST).port or 11434
    cmd = ["ssh", "-N", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
           "-o", "ExitOnForwardFailure=yes"]
    jump = os.getenv("SSH_JUMP", "").strip()
    if jump:
        cmd += ["-J", jump]
    cmd += ["-L", f"{local_port}:localhost:11434"]
    # Forward the CoTSimilarity eval shim's port over the SAME connection, so the
    # eval panel rides the tunnel the LLM panel opens (both on the GPU host).
    try:
        from cot_eval import COT_EVAL_PORT
        cmd += ["-L", f"{COT_EVAL_PORT}:localhost:{COT_EVAL_PORT}"]
    except Exception:  # noqa: BLE001 - eval is optional; never block the Ollama tunnel
        pass
    cmd += [os.getenv("SSH_TARGET", "").strip(),
            "-p", os.getenv("SSH_PORT", "22").strip() or "22"]
    _TUNNEL["proc"] = subprocess.Popen(
        cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)


def _close_tunnel() -> None:
    proc = _TUNNEL["proc"]
    if proc is not None and proc.poll() is None:
        proc.kill()


atexit.register(_close_tunnel)


# Note: the LLM panel's GPU column is informational. On the target host Ollama
# runs as a shared, root-owned system service that auto-schedules GPUs and can't
# be pinned per request, so the frontend only *highlights* the GPU the scheduler
# is most likely to use (the most-free card) rather than selecting one.


def _ensure_connection() -> dict:
    """Ensure Ollama is reachable, opening the SSH tunnel if needed.

    Returns {reachable, models, error}. Idempotent: a probe that already
    succeeds (a local Ollama, or a tunnel left from a previous attempt) returns
    immediately without spawning anything.
    """
    probe = _probe_ollama()
    if probe["reachable"]:
        return probe

    if not _remote_configured():
        probe["error"] = (
            "Ollama is not reachable and no remote host is configured — start a "
            "local `ollama serve`, or set SSH_TARGET/TUNNEL_PORT in "
            "ollama.local.sh for a remote host.")
        return probe

    # Remote: open the tunnel (once) and wait for Ollama to answer through it.
    if not _tunnel_running():
        try:
            _open_tunnel()
        except FileNotFoundError:
            return {"reachable": False, "models": [],
                    "error": "Cannot open SSH tunnel — `ssh` not found on the backend host."}

    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        proc = _TUNNEL["proc"]
        if proc is not None and proc.poll() is not None:
            # ssh exited before/while forwarding — surface its stderr.
            err = (proc.stderr.read() if proc.stderr else "").strip()
            _TUNNEL["proc"] = None
            return {"reachable": False, "models": [],
                    "error": f"SSH tunnel failed: {err or 'ssh exited unexpectedly'}"}
        probe = _probe_ollama(timeout=2)
        if probe["reachable"]:
            return probe
        time.sleep(0.7)

    return {"reachable": False, "models": [],
            "error": ("SSH tunnel opened but Ollama did not respond within 12s — "
                      "is `ollama serve` running on the remote host?")}


def _ollama_status():
    """Reachability + model availability of the configured Ollama host."""
    # Lazy import keeps the env-derived config in one place (llm_generate
    # reads OLLAMA_HOST/OLLAMA_MODEL at import); the module itself imports
    # cleanly even when the ollama package is not installed.
    from llm_generate import DEFAULT_MODEL, OLLAMA_HOST
    probe = _probe_ollama()
    error = None if probe["reachable"] else (
        probe["error"] + " — is the SSH tunnel open and `ollama serve` running?")
    return {"host": OLLAMA_HOST, "model": DEFAULT_MODEL,
            "reachable": probe["reachable"], "models": probe["models"],
            "model_info": probe.get("model_info", []), "error": error}


def _availability(ollama: dict):
    """(available, reason) verdict shared by the status and connect routes."""
    if not ollama["reachable"]:
        return False, ollama["error"]
    if not ollama["models"]:
        return False, "No models are installed on the Ollama host."
    return True, "LLM generation is ready."


@app.route("/api/llm_status")
def api_llm_status():
    """Passive readiness re-check (no tunnel opened) for the Refresh button."""
    gpu = _gpu_status()
    ollama = _ollama_status()
    available, reason = _availability(ollama)
    return jsonify({"ok": True, "gpu": gpu, "ollama": ollama,
                    "available": available, "reason": reason})


@app.route("/api/llm_connect", methods=["POST"])
def api_llm_connect():
    """Lazily connect to Ollama (opening the SSH tunnel if needed) on demand.

    Called when the user enters the LLM Generation panel. Gated on a local
    config: without ollama.local.sh we point the user at the example rather than
    attempting any connection. On success returns the same shape as
    /api/llm_status plus configured:true.
    """
    if not _config_present():
        return jsonify({
            "ok": False, "configured": False,
            "hint_file": "ollama.local.sh.example",
            "error": ("No ollama.local.sh found — copy ollama.local.sh.example "
                      "to ollama.local.sh and set your Ollama host."),
        })

    from llm_generate import DEFAULT_MODEL, OLLAMA_HOST
    conn = _ensure_connection()
    ollama = {"host": OLLAMA_HOST, "model": DEFAULT_MODEL,
              "reachable": conn["reachable"], "models": conn["models"],
              "model_info": conn.get("model_info", []), "error": conn["error"]}
    available, reason = _availability(ollama)
    return jsonify({"ok": True, "configured": True, "gpu": _gpu_status(),
                    "ollama": ollama, "available": available, "reason": reason})


# --------------------------------------------------------------------------- #
# CoTSimilarity sample evaluation (remote shim over the shared SSH tunnel)
# --------------------------------------------------------------------------- #
# Evaluations are slow (vLLM sampling + LLM-segmented GED), so they run as
# background jobs: a route enqueues {problem_id}, one worker thread drains the
# queue (serialising calls so the resident vLLM model is hit one request at a
# time), and the result is cached onto the record's "evaluation" field. The
# frontend polls /api/eval_status until the job leaves the "running" state.
_EVAL_QUEUE: "queue.Queue" = queue.Queue()
_EVAL_JOBS = {}                 # problem_id -> job dict (state/result/error/…)
_EVAL_LOCK = threading.Lock()   # serialises the read-modify-write of a record's eval


def _eval_service_status() -> dict:
    """Reachability + capability of the configured CoTSimilarity eval shim."""
    from cot_eval import COT_EVAL_HOST, COT_EVAL_MODEL, COT_EVAL_N, probe_eval
    probe = probe_eval()
    return {"host": COT_EVAL_HOST, "model": probe.get("model") or COT_EVAL_MODEL,
            "n": COT_EVAL_N, "reachable": probe["reachable"],
            "ged_ready": probe.get("ged_ready", False), "error": probe["error"]}


def _eval_availability(svc: dict):
    """(available, reason) verdict shared by the eval status + connect routes."""
    if not svc["reachable"]:
        return False, svc["error"]
    if not svc.get("ged_ready"):
        return True, ("Solvability ready; GED disabled on the service — set "
                      "DEEPSEEK_API_KEY on the remote for structural similarity.")
    return True, "Sample evaluation is ready."


def _ensure_eval_connection() -> dict:
    """Ensure the eval shim is reachable, opening the shared SSH tunnel if needed.

    Mirrors _ensure_connection but probes the eval service (the tunnel forwards
    both Ollama's 11434 and the eval port, so either panel can open it).
    """
    from cot_eval import COT_EVAL_PORT, probe_eval
    probe = probe_eval()
    if probe["reachable"]:
        return probe
    if not _remote_configured():
        probe["error"] = (
            probe["error"] + " — no remote host is configured; run the shim "
            "locally or set SSH_TARGET/TUNNEL_PORT in ollama.local.sh.")
        return probe
    if not _tunnel_running():
        try:
            _open_tunnel()
        except FileNotFoundError:
            return {"reachable": False, "model": None, "ged_ready": False,
                    "error": "Cannot open SSH tunnel — `ssh` not found on the backend host."}
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        proc = _TUNNEL["proc"]
        if proc is not None and proc.poll() is not None:
            err = (proc.stderr.read() if proc.stderr else "").strip()
            _TUNNEL["proc"] = None
            return {"reachable": False, "model": None, "ged_ready": False,
                    "error": f"SSH tunnel failed: {err or 'ssh exited unexpectedly'}"}
        probe = probe_eval(timeout=2)
        if probe["reachable"]:
            return probe
        time.sleep(0.7)
    return {"reachable": False, "model": None, "ged_ready": False,
            "error": (f"SSH tunnel opened but the eval shim on port {COT_EVAL_PORT} "
                      "did not respond within 12s — is uvicorn running on the remote?")}


def _run_eval_job(pid):
    """Worker body for one queued evaluation: pick solvability vs pair by the
    record's status, call the shim, and cache the result onto the record."""
    import cot_eval
    record = _find_record(pid)
    if record is None:
        raise RuntimeError(f"no record with id {pid}")
    if record.get("status") in STATUS_FILTER_POOL:
        # Sample one trial at a time so the UI can show a live 0→N trial bar
        # (the shim has no per-sample callback within a single n=N call).
        n = cot_eval.COT_EVAL_N
        job = _EVAL_JOBS.get(pid)
        if job is not None:
            job["progress"] = {"trial": 0, "trials": n}
        correct = 0
        model = None
        grader_errors = []
        sample_response = None
        for i in range(1, n + 1):
            trial = cot_eval.eval_solvability(record, n=1)
            correct += sum(1 for c in (trial.get("correct") or []) if c)
            model = trial.get("model") or model
            for err in (trial.get("errors") or []):
                if err:
                    grader_errors.append(err)
            if sample_response is None:
                responses = trial.get("responses") or []
                if responses:
                    sample_response = responses[0]
            if job is not None:
                job["progress"] = {"trial": i, "trials": n}
        evaluation = {
            "kind": "solvability",
            "solvability": {"pass_rate": (correct / n if n else None), "n": n},
            "model": model,
            "evaluated_at": now_iso(),
            "error": None,
            "debug": {"errors": grader_errors, "sample_response": sample_response},
        }
    else:  # Unverified or Verified — the simple/hard pair exists
        result = cot_eval.eval_pair(record)
        original = result.get("original") or {}
        simple = result.get("simple") or {}
        hard = result.get("hard") or {}
        evaluation = {
            "kind": "pair",
            "solvability": {"pass_rate": original.get("pass_rate"), "n": result.get("n")},
            "pair": {
                "original_pass_rate": original.get("pass_rate"),
                "simple": {"pass_rate": simple.get("pass_rate"), "ged": simple.get("ged"),
                           "similarity_normalized": simple.get("similarity_normalized")},
                "hard": {"pass_rate": hard.get("pass_rate"), "ged": hard.get("ged"),
                         "similarity_normalized": hard.get("similarity_normalized")},
            },
            "model": result.get("model"),
            "evaluated_at": now_iso(),
            "error": None,
            "warnings": result.get("warnings") or [],
        }
    # Re-read fresh right before writing to minimise the window against a
    # concurrent save; the lock serialises eval writes with each other.
    with _EVAL_LOCK:
        fresh = _find_record(pid)
        if fresh is not None:
            fresh["evaluation"] = evaluation
            _update_record(fresh)
    return evaluation


def _eval_worker():
    while True:
        pid = _EVAL_QUEUE.get()
        job = _EVAL_JOBS.get(pid)
        if job is None:
            continue
        job["state"] = "running"
        try:
            job["result"] = _run_eval_job(pid)
            job["state"] = "done"
        except Exception as e:  # noqa: BLE001 - surfaced to the UI via /api/eval_status
            job["error"] = str(e)
            job["state"] = "error"
        finally:
            job["finished_at"] = now_iso()


threading.Thread(target=_eval_worker, name="cot-eval-worker", daemon=True).start()


@app.route("/api/eval_service_status")
def api_eval_service_status():
    """Passive readiness of the CoTSimilarity eval shim (no tunnel opened)."""
    svc = _eval_service_status()
    available, reason = _eval_availability(svc)
    return jsonify({"ok": True, "service": svc, "available": available, "reason": reason})


@app.route("/api/eval_connect", methods=["POST"])
def api_eval_connect():
    """Open the shared SSH tunnel (if needed) and probe the eval shim on demand."""
    if not _config_present():
        return jsonify({
            "ok": False, "configured": False,
            "hint_file": "ollama.local.sh.example",
            "error": ("No ollama.local.sh found — copy ollama.local.sh.example to "
                      "ollama.local.sh and set COT_EVAL_PORT (and your SSH host)."),
        })
    from cot_eval import COT_EVAL_HOST, COT_EVAL_MODEL, COT_EVAL_N
    conn = _ensure_eval_connection()
    svc = {"host": COT_EVAL_HOST, "model": conn.get("model") or COT_EVAL_MODEL,
           "n": COT_EVAL_N, "reachable": conn["reachable"],
           "ged_ready": conn.get("ged_ready", False), "error": conn["error"]}
    available, reason = _eval_availability(svc)
    return jsonify({"ok": True, "configured": True, "service": svc,
                    "available": available, "reason": reason})


@app.route("/api/eval_record", methods=["POST"])
def api_eval_record():
    """Enqueue a background evaluation for one record (solvability if Original,
    full pair otherwise). Idempotent: an in-flight job is returned as-is."""
    body = request.get_json(force=True, silent=True) or {}
    pid = body.get("problem_id")
    if pid is None:
        return jsonify({"ok": False, "error": "problem_id required"}), 400
    record = _find_record(pid)
    if record is None:
        return jsonify({"ok": False, "error": f"no record with id {pid}"}), 404
    kind = "solvability" if record.get("status") in STATUS_FILTER_POOL else "pair"
    job = _EVAL_JOBS.get(pid)
    if job and job.get("state") in ("queued", "running"):
        return jsonify({"ok": True, "state": job["state"], "kind": job.get("kind")})
    _EVAL_JOBS[pid] = {"state": "queued", "kind": kind, "result": None,
                       "error": None, "progress": None,
                       "started_at": now_iso(), "finished_at": None}
    _EVAL_QUEUE.put(pid)
    return jsonify({"ok": True, "state": "queued", "kind": kind})


@app.route("/api/eval_status")
def api_eval_status():
    """Poll a record's evaluation job. Returns the job state plus (when done) the
    cached evaluation block from the record."""
    raw = request.args.get("problem_id")
    if raw is None:
        return jsonify({"ok": False, "error": "problem_id required"}), 400
    try:
        pid = int(raw)
    except (TypeError, ValueError):
        pid = raw
    job = _EVAL_JOBS.get(pid)
    record = _find_record(pid)
    evaluation = (record or {}).get("evaluation")
    if job is None:
        # No job this session — report any cached result already on the record.
        return jsonify({"ok": True, "state": "idle", "evaluation": evaluation})
    return jsonify({"ok": True, "state": job["state"], "kind": job.get("kind"),
                    "error": job.get("error"), "progress": job.get("progress"),
                    "evaluation": job.get("result") or evaluation})


def _status_payload(status: str) -> dict:
    """{exists, count, records} for records of a given status, for UI/API use."""
    recs = [r for r in _read_dataset() if r.get("status") == status]
    return {"exists": DATASET_FILE.exists(), "count": len(recs), "records": recs}


@app.route("/api/records")
def records():
    # Browse set: every record regardless of pipeline stage — Original, Kept,
    # Rejected, Unverified, and Verified. The frontend's Status facet is how the
    # user narrows to a stage; this route no longer does that filtering itself.
    return jsonify(_read_dataset())


@app.route("/api/raw")
def api_raw():
    # Base problems for the Generate tab — Kept records (passed the Filter step).
    return jsonify(_status_payload(STATUS_KEPT))


@app.route("/api/filter_pool")
def api_filter_pool():
    # The Filter step's working pool: every non-generated record (pulled but no
    # perturbations yet) — Original (unfiltered), Kept, and Rejected — so the UI
    # can show each problem's current disposition and re-partition on Apply.
    recs = [r for r in _read_dataset() if r.get("status") in STATUS_FILTER_POOL]
    return jsonify({"exists": DATASET_FILE.exists(), "count": len(recs), "records": recs})


@app.route("/api/apply_filter", methods=["POST"])
def api_apply_filter():
    """Commit a Filter-step partition: mark the given problem_ids Kept or Rejected.

    Only records currently in the filter pool (Original/Kept/Rejected — i.e. not
    yet generated) are affected; ids that are missing or already generated are
    ignored. This is the whitelist/blacklist gate before Generate.
    """
    body = request.get_json(force=True, silent=True) or {}
    keep = {int(p) for p in (body.get("keep") or []) if p is not None}
    reject = {int(p) for p in (body.get("reject") or []) if p is not None}
    dataset = _read_dataset()
    kept = rejected = 0
    for r in dataset:
        if r.get("status") not in STATUS_FILTER_POOL:
            continue
        pid = r.get("problem_id")
        if pid in keep:
            r["status"] = STATUS_KEPT
            kept += 1
        elif pid in reject:
            r["status"] = STATUS_REJECTED
            rejected += 1
    _write_dataset(dataset)
    return jsonify({"ok": True, "kept": kept, "rejected": rejected})


@app.route("/api/pull_math", methods=["POST"])
def api_pull_math():
    body = request.get_json(force=True, silent=True) or {}
    try:
        count = max(1, min(int(body.get("count", 20)), 500))
    except (TypeError, ValueError):
        count = 20
    levels = body.get("levels") or None
    types = body.get("types") or None
    try:
        added = pull_math(count=count, levels=levels, types=types,
                          seed=int(body.get("seed", 0)))
    except Exception as e:  # noqa: BLE001 - report to the UI
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({
        "ok": True,
        "added": len(added),
        "file": str(DATASET_FILE.relative_to(ROOT)),
        "records": added,
    })


@app.route("/api/datasets")
def api_datasets():
    """Available dataset sources + their filter/sort metadata (no record data)."""
    return jsonify({"ok": True,
                    "datasets": [p.describe() for p in PROVIDERS.values()]})


@app.route("/api/dataset_records")
def api_dataset_records():
    """Normalized sample records for one dataset, plus data-derived facets.

    Query: dataset=<id>&limit=<n>. Filtering/sorting happen client-side on this
    sample, so it stays responsive; `limit` caps how many rows we stream.
    """
    ds_id = request.args.get("dataset", "math")
    provider = get_provider(ds_id)
    if provider is None:
        return jsonify({"ok": False, "error": f"unknown dataset '{ds_id}'"}), 404
    try:
        limit = max(1, min(int(request.args.get("limit", 200)), 1000))
    except (TypeError, ValueError):
        limit = 200
    try:
        records = provider.load_sample(limit)
    except Exception as e:  # noqa: BLE001 - surface load/network errors to the UI
        return jsonify({"ok": False, "error": str(e)}), 500
    # Flag rows already present anywhere in the pipeline so the UI can mark them.
    seen = existing_problem_texts()
    for i, r in enumerate(records):
        r["_idx"] = i
        r["pulled"] = (r.get("problem") or "").strip() in seen
    return jsonify({
        "ok": True,
        "dataset": ds_id,
        "count": len(records),
        "records": records,
        "facets": provider.compute_facets(records),
        "sorts": provider.sorts,
    })


@app.route("/api/pull_record", methods=["POST"])
def api_pull_record():
    """Pull one browsed record into DSPR_dataset.json (any dataset source)."""
    body = request.get_json(force=True, silent=True) or {}
    provider = get_provider(body.get("dataset"))
    if provider is None:
        return jsonify({"ok": False, "error": f"unknown dataset '{body.get('dataset')}'"}), 404
    norm = body.get("record")
    if not isinstance(norm, dict) or not (norm.get("problem") or "").strip():
        return jsonify({"ok": False, "error": "record with problem text required"}), 400
    if not (norm.get("solution") or "").strip():
        return jsonify({"ok": False, "error": "record is missing a solution"}), 400
    if (norm.get("problem") or "").strip() in existing_problem_texts():
        return jsonify({"ok": False, "error": "already pulled (duplicate problem)"}), 409
    record = norm_to_raw(provider, norm, next_problem_id())
    _append_dataset(record)
    return jsonify({"ok": True, "record": record,
                    "file": str(DATASET_FILE.relative_to(ROOT))})


@app.route("/api/save_variant", methods=["POST"])
def api_save_variant():
    body = request.get_json(force=True, silent=True) or {}
    pid = body.get("problem_id")
    if pid is None:
        return jsonify({"ok": False, "error": "problem_id required"}), 400
    simple = _clean_variant(body.get("simple"))
    hard = _clean_variant(body.get("hard"))
    if simple is None or hard is None:
        return jsonify({"ok": False, "error": "both 'simple' and 'hard' perturbations are required"}), 400

    dataset = _read_dataset()
    record = next((r for r in dataset if r.get("problem_id") == pid), None)
    if record is None:
        return jsonify({"ok": False, "error": f"no base problem with id {pid}"}), 404

    auto_verify = bool(body.get("auto_verify"))
    apply_perturbations(record, simple, hard,
                        verified=auto_verify, author=body.get("create_author") or "")
    _write_dataset(dataset)
    return jsonify({
        "ok": True,
        "auto_verified": auto_verify,
        "file": str(DATASET_FILE.relative_to(ROOT)),
        "record": record,
    })


@app.route("/api/llm_generate", methods=["POST"])
@app.route("/api/claude_generate", methods=["POST"])  # legacy alias
def api_llm_generate():
    body = request.get_json(force=True, silent=True) or {}
    pid = body.get("problem_id")
    if pid is None:
        return jsonify({"ok": False, "error": "problem_id required"}), 400
    record = next((r for r in _read_dataset()
                   if r.get("problem_id") == pid
                   and r.get("status") == STATUS_KEPT), None)
    if record is None:
        return jsonify({"ok": False, "error": f"no kept problem with id {pid}"}), 404
    try:
        from llm_generate import generate_for_problem  # lazy: no hard ollama dep
    except ImportError:
        return jsonify({"ok": False,
                        "error": "ollama not installed — pip install -r requirements.txt"}), 500
    try:
        kwargs = {"auto_verify": bool(body.get("auto_verify"))}
        model = (body.get("model") or "").strip()
        if model:  # else generate_for_problem falls back to DEFAULT_MODEL
            kwargs["model"] = model
        result = generate_for_problem(record, **kwargs)
    except Exception as e:  # noqa: BLE001 - report to the UI
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify(result)


@app.route("/api/pending")
def api_pending():
    return jsonify(_status_payload(STATUS_UNVERIFIED))


@app.route("/api/verified")
def api_verified():
    return jsonify(_status_payload(STATUS_VERIFIED))


@app.route("/api/verify", methods=["POST"])
def api_verify():
    body = request.get_json(force=True, silent=True) or {}
    pid = body.get("problem_id")
    if pid is None:
        return jsonify({"ok": False, "error": "problem_id required"}), 400
    verify_author = (body.get("verify_author") or "").strip()
    dataset = _read_dataset()
    record = next((r for r in dataset
                   if r.get("problem_id") == pid and r.get("status") == STATUS_UNVERIFIED), None)
    if record is None:
        return jsonify({"ok": False, "error": f"no pending problem with id {pid}"}), 404
    record["status"] = STATUS_VERIFIED
    record["verify_author"] = verify_author
    _write_dataset(dataset)
    return jsonify({
        "ok": True,
        "file": str(DATASET_FILE.relative_to(ROOT)),
        "record": record,
    })


@app.route("/api/remove_raw", methods=["POST"])
def api_remove_raw():
    body = request.get_json(force=True, silent=True) or {}
    pid = body.get("problem_id")
    if pid is None:
        return jsonify({"ok": False, "error": "problem_id required"}), 400
    dataset = _read_dataset()
    kept = [r for r in dataset
            if not (r.get("problem_id") == pid and r.get("status") == STATUS_ORIGINAL)]
    _write_dataset(kept)
    return jsonify({"ok": True, "removed": len(dataset) - len(kept)})


@app.route("/api/reject", methods=["POST"])
def api_reject():
    body = request.get_json(force=True, silent=True) or {}
    pid = body.get("problem_id")
    if pid is None:
        return jsonify({"ok": False, "error": "problem_id required"}), 400
    dataset = _read_dataset()
    record = next((r for r in dataset
                   if r.get("problem_id") == pid and r.get("status") == STATUS_UNVERIFIED), None)
    if record is None:
        return jsonify({"ok": False, "error": f"no pending problem with id {pid}"}), 404
    # Revert to the base problem: drop the perturbations and return it to the Kept
    # pool (it already passed the Filter step) so it re-enters Generate, not Filter.
    record["simple"] = None
    record["hard"] = None
    record.pop("create_author", None)
    record["status"] = STATUS_KEPT
    _write_dataset(dataset)
    return jsonify({"ok": True, "record": record})


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main():
    parser = argparse.ArgumentParser(description="DSPR data viewer backend")
    sub = parser.add_subparsers(dest="cmd")

    pull = sub.add_parser("pull", help="Pull MATH problems into raw_problems.json")
    pull.add_argument("--count", type=int, default=20)
    pull.add_argument("--levels", nargs="*", default=None,
                      help='e.g. --levels "Level 4" "Level 5"')
    pull.add_argument("--types", nargs="*", default=None)
    pull.add_argument("--seed", type=int, default=0)

    serve = sub.add_parser("serve", help="Run the web server (default)")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)

    sub.add_parser("reset-unfiltered",
                   help="One-time: delete every un-filtered 'Original' record "
                        "(pulled but not yet run through the Filter step)")

    args = parser.parse_args()

    if args.cmd == "pull":
        added = pull_math(count=args.count, levels=args.levels,
                          types=args.types, seed=args.seed)
        print(f"Added {len(added)} problems to {DATASET_FILE}")
        return

    if args.cmd == "reset-unfiltered":
        dataset = _read_dataset()
        kept = [r for r in dataset if r.get("status") != STATUS_ORIGINAL]
        removed = len(dataset) - len(kept)
        _write_dataset(kept)
        from collections import Counter
        counts = Counter(r.get("status") for r in kept)
        print(f"Removed {removed} '{STATUS_ORIGINAL}' record(s) from {DATASET_FILE}")
        print("Remaining by status: " + (", ".join(f"{k}: {v}" for k, v in counts.items()) or "(empty)"))
        return

    host = getattr(args, "host", "127.0.0.1")
    port = getattr(args, "port", 8000)
    print(f"Serving DSPR viewer on http://{host}:{port}")
    app.run(host=host, port=port, debug=False)


if __name__ == "__main__":
    main()
