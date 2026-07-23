# CoTSimilarity eval shim

A tiny FastAPI service that lets the **DSPR authoring app** score training samples
using the **CoTSimilarity / DSPR** research code, without either project importing
the other. The app talks to it only over HTTP (through the same SSH tunnel it uses
for Ollama).

It exposes:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | `{model, cuda, ged_ready}` — readiness probe |
| `POST /eval/solvability` | pass-rate of the vLLM math model on one problem (Pull step) |
| `POST /eval/pair` | solvability of original/simple/hard **+** GED structural similarity of simple & hard vs the original (Verify step) |

## Deploy (on the remote GPU host)

This folder is meant to live **inside the CoTSimilarity repo** so it can import
that repo's `src/` packages. On the machine where the repo is checked out
(e.g. `/scratch/<user>/DSPR`):

```bash
cd /scratch/<user>/DSPR                      # the CoTSimilarity repo root
# put this folder here → /scratch/<user>/DSPR/cot_eval_service/
pip install -r cot_eval_service/requirements-shim.txt   # into the repo's env

export DEEPSEEK_API_KEY=...    # only needed for the GED (structural) score
# optional overrides:
# export COT_EVAL_MODEL="Qwen/Qwen2.5-Math-1.5B-Instruct"
# export COT_EVAL_N=10

uvicorn cot_eval_service.app:app --host 127.0.0.1 --port 8100 --workers 1
```

Run it from the **repo root** (so both `cot_eval_service` and `src/` import) and
keep `--workers 1` — the vLLM engine is a single resident model and the DSPR app
already serialises requests. The model loads lazily on the first
`/eval/*` call, so `/health` answers immediately.

The DSPR app reaches this over the SSH tunnel it already opens for Ollama: set
`COT_EVAL_PORT=8100` in the app's `ollama.local.sh` and the app forwards
`localhost:8100 → remote:8100` alongside `11434`.

## Smoke test (on the remote)

```bash
curl localhost:8100/health
curl -s -XPOST localhost:8100/eval/solvability \
  -H 'content-type: application/json' \
  -d '{"problem":"What is 2+2?","ground_truth":"4","n":2}'
```

## What it imports from the repo

* generation — `vllm.LLM` (same load as `scripts/pertubation_test.py`)
* correctness — `utils.evaluate.answer_check`
* reasoning graph — `data_analysis.cot_segmenter.segment_response` →
  `data_analysis.llm.api_client.LLMClient.analyze_reasoning_chain` →
  `data_analysis.dag_compressor.build_digraph_with_tags` / `compress_dag_combined`
* similarity — `data_analysis.dag_similarity.compute_ged_similarity`

If `DEEPSEEK_API_KEY` is unset the service still returns solvability; the GED
fields come back `null` with a note in `warnings`.
