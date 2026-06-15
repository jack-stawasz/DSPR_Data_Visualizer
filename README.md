# DSPR Training Data

A small Flask web app for **authoring and curating perturbation training data** — the
`simple` / `hard` variants of competition math problems consumed by the **DSPR**
(CoTSimilarity) research pipeline. You browse public math datasets, pull problems,
author or LLM-generate two perturbed variants of each, review them, and store everything
in a single curated file.

It is self-contained: all data lives in `data/DSPR_dataset.json`.

## Quickstart

Run from **WSL / Linux / macOS** (the launcher builds a Linux/Unix virtualenv — on
Windows use WSL, not native PowerShell):

```bash
./start.sh
```

Then open <http://127.0.0.1:8000>. `start.sh` is idempotent: it frees port 8000, creates
or reuses a local `venv/` (rebuilt automatically when `requirements.txt` changes), and
starts the server. Requirements: `python3` (3.10+) and the packages in
[requirements.txt](requirements.txt) (`flask`, `datasets`, `ollama`).

### CLI (no server)

```bash
python backend/app.py pull --count 50      # pull base MATH problems into the dataset
python backend/llm_generate.py --count 1   # generate variants for the first N originals
```

## Project layout

```
DSPR_Data_Visualizer/
├── backend/     # Python/Flask: app.py, dataset_providers.py, llm_generate.py
├── frontend/    # static client: index.html, app.js, styles.css
├── data/        # the single dataset store: DSPR_dataset.json
├── scripts/     # one-off utilities (e.g. merge_math_paired.py)
├── requirements.txt, start.sh, ollama.local.sh(.example)
└── README.md, CLAUDE.md
```

The backend resolves all paths from the repo root and serves `frontend/` and `data/`
from there. See [CLAUDE.md](CLAUDE.md) for architecture details.

## Data flow

Everything lives in `data/DSPR_dataset.json`, a JSON array where each record's `status`
marks its stage:

1. **Pull** → `Original (unperturbed)` — a base problem from a HuggingFace source
   (MATH-500, NuminaMath-1.5, OpenMathInstruct-2).
2. **Create** → `Unverified` — `simple` / `hard` variants authored or generated onto it.
3. **Verify** → `Verified` — an approved bundle (both `simple` and `hard` populated).

### Exporting for the model ⚠️

`DSPR_dataset.json` is the **authoring** store, not the model's input. The CoTSimilarity
loaders read a **`math_paired.jsonl`** (newline-delimited JSON) and require both `simple`
and `hard` to be populated on every record. Before handing data to the model you must
**export** the complete records (`Verified` bundles) to JSONL, dropping the authoring-only
fields (`status`, `source`, `pulled_at`, `create_author`). **This export step is not yet
implemented.**

## LLM generation (optional)

The "LLM Generation" feature talks to an **Ollama** model (default `qwen2.5:7b`), either
local or remote over an SSH tunnel. Connection config is read from a git-ignored
`ollama.local.sh`:

```bash
cp ollama.local.sh.example ollama.local.sh   # then edit it
```

With no `ollama.local.sh`, `start.sh` defaults to a local Ollama at
`http://localhost:11434` and opens no tunnel — so a fresh checkout runs out of the box
against `ollama serve`. See [ollama.local.sh.example](ollama.local.sh.example) for the
remote-tunnel form.
