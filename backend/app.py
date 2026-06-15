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
import json
import os
import random
import shlex
import subprocess
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
STATUS_ORIGINAL   = "Original (unperturbed)"
STATUS_UNVERIFIED = "Unverified"
STATUS_VERIFIED   = "Verified"

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


def _ollama_status():
    """Reachability + model availability of the configured Ollama host."""
    # Lazy import keeps the env-derived config in one place (llm_generate
    # reads OLLAMA_HOST/OLLAMA_MODEL at import); the module itself imports
    # cleanly even when the ollama package is not installed.
    from llm_generate import DEFAULT_MODEL, OLLAMA_HOST
    info = {"host": OLLAMA_HOST, "model": DEFAULT_MODEL,
            "reachable": False, "models": [], "error": None}
    try:
        with urllib.request.urlopen(OLLAMA_HOST.rstrip("/") + "/api/tags",
                                    timeout=4) as resp:
            data = json.load(resp)
        info["reachable"] = True
        info["models"] = [m.get("name", "") for m in data.get("models", [])]
    except Exception as e:  # noqa: BLE001 - any failure means unreachable
        info["error"] = (f"Cannot reach Ollama at {OLLAMA_HOST} — is the SSH "
                         f"tunnel open and `ollama serve` running? ({e})")
    return info


@app.route("/api/llm_status")
def api_llm_status():
    """Everything the LLM Generation panel needs to decide if it can run."""
    gpu = _gpu_status()
    ollama = _ollama_status()
    if not ollama["reachable"]:
        available, reason = False, ollama["error"]
    elif ollama["model"] not in ollama["models"]:
        available, reason = False, (
            f"Model '{ollama['model']}' is not available on the Ollama host "
            f"(found: {', '.join(ollama['models']) or 'none'}).")
    else:
        available, reason = True, "LLM generation is ready."
    return jsonify({"ok": True, "gpu": gpu, "ollama": ollama,
                    "available": available, "reason": reason})


def _status_payload(status: str) -> dict:
    """{exists, count, records} for records of a given status, for UI/API use."""
    recs = [r for r in _read_dataset() if r.get("status") == status]
    return {"exists": DATASET_FILE.exists(), "count": len(recs), "records": recs}


@app.route("/api/records")
def records():
    # Browse set: every natively-shaped record in our dataset — Original
    # (perturbations pending/none) and Verified pairs. Unverified records are
    # excluded; they belong to the Verify tab.
    recs = [r for r in _read_dataset()
            if r.get("status") in (STATUS_ORIGINAL, STATUS_VERIFIED)]
    return jsonify(recs)


@app.route("/api/raw")
def api_raw():
    # Base problems for the Generate tab — "Original (unperturbed)" records only.
    return jsonify(_status_payload(STATUS_ORIGINAL))


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
                   and r.get("status") == STATUS_ORIGINAL), None)
    if record is None:
        return jsonify({"ok": False, "error": f"no raw problem with id {pid}"}), 404
    try:
        from llm_generate import generate_for_problem  # lazy: no hard ollama dep
    except ImportError:
        return jsonify({"ok": False,
                        "error": "ollama not installed — pip install -r requirements.txt"}), 500
    try:
        result = generate_for_problem(record, auto_verify=bool(body.get("auto_verify")))
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
    # Revert to the base problem: drop the perturbations, keep the original so it
    # returns to the Generate pool to be re-perturbed.
    record["simple"] = None
    record["hard"] = None
    record.pop("create_author", None)
    record["status"] = STATUS_ORIGINAL
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

    args = parser.parse_args()

    if args.cmd == "pull":
        added = pull_math(count=args.count, levels=args.levels,
                          types=args.types, seed=args.seed)
        print(f"Added {len(added)} problems to {DATASET_FILE}")
        return

    host = getattr(args, "host", "127.0.0.1")
    port = getattr(args, "port", 8000)
    print(f"Serving DSPR viewer on http://{host}:{port}")
    app.run(host=host, port=port, debug=False)


if __name__ == "__main__":
    main()
