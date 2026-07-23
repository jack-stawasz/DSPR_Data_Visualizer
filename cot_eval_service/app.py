#!/usr/bin/env python3
"""
CoTSimilarity / DSPR sample-evaluation shim (FastAPI).

Deploy this file INSIDE the CoTSimilarity repo on the remote GPU host
(the repo the DSPR maintainers keep at /scratch/<user>/DSPR). It wraps the
repo's own primitives behind two HTTP endpoints the DSPR authoring app calls
over an SSH tunnel:

    POST /eval/solvability  -> does the math model solve one problem? pass-rate over N samples.
    POST /eval/pair         -> solvability of original/simple/hard + GED structural
                               similarity of simple & hard vs the original reasoning.
    GET  /health            -> {model, cuda, ged_ready}

It imports (never re-implements) the repo's logic:
  * generation      : vLLM (Qwen math model), same load as scripts/pertubation_test.py
  * correctness     : utils.evaluate.answer_check
  * reasoning graph : data_analysis.cot_segmenter.segment_response
                      -> LLMClient.analyze_reasoning_chain (LiteLLM, DeepSeek default)
                      -> data_analysis.dag_compressor.build_digraph_with_tags / compress_dag_combined
  * similarity      : data_analysis.dag_similarity.compute_ged_similarity

Run it from the repo root so both `cot_eval_service` and `src/` resolve:

    export DEEPSEEK_API_KEY=...        # only needed for the GED (structural) score
    uvicorn cot_eval_service.app:app --host 127.0.0.1 --port 8100 --workers 1

Keep --workers 1: the vLLM model is a single resident engine and the DSPR app
already serialises requests, so one worker avoids loading the model twice.

Config via env (all optional):
    COT_EVAL_MODEL        HF model for vLLM (default Qwen/Qwen2.5-Math-1.5B-Instruct)
    COT_EVAL_N            default samples per variant (default 10)
    COT_EVAL_MAX_TOKENS   max new tokens per sample (default 2048)
    COT_EVAL_GPU_UTIL     vLLM gpu_memory_utilization, e.g. 0.3 on a shared GPU (default vLLM's 0.90)
    COT_EVAL_MAX_MODEL_LEN  cap vLLM max_model_len to shrink the KV cache (default model max)
    COT_EVAL_GED_TIMEOUT  seconds for one graph-edit-distance computation (default 30)
    DEEPSEEK_API_KEY      enables the GED step (LLMConfig default provider is DeepSeek)
"""

import logging
import os
import sys
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel

# This file lives at <repo>/cot_eval_service/app.py; the repo's packages are
# rooted at <repo>/src (the repo scripts do the same sys.path insert).
REPO_ROOT = Path(__file__).resolve().parents[1]
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("cot_eval_service")

MODEL_NAME = os.getenv("COT_EVAL_MODEL", "Qwen/Qwen2.5-Math-1.5B-Instruct")
DEFAULT_N = int(os.getenv("COT_EVAL_N", "10"))
MAX_TOKENS = int(os.getenv("COT_EVAL_MAX_TOKENS", "2048"))
GED_TIMEOUT = float(os.getenv("COT_EVAL_GED_TIMEOUT", "30"))

# GED (reasoning-structure) extractor is LiteLLM; the provider is configurable so
# it can point at DeepSeek (repo default), Gemini, OpenAI, Anthropic, or a local
# Ollama without code changes. The API key is read from the provider's standard
# env var (e.g. GEMINI_API_KEY, DEEPSEEK_API_KEY) by the repo's LLMConfig.
GED_PROVIDER = (os.getenv("COT_EVAL_GED_PROVIDER", "deepseek").strip() or "deepseek")
GED_MODEL = os.getenv("COT_EVAL_GED_MODEL", "").strip()
GED_BASE_URL = os.getenv("COT_EVAL_GED_BASE_URL", "").strip()
_DEFAULT_GED_MODEL = {
    "deepseek": "deepseek-chat",
    "gemini": "gemini-2.0-flash",
    "openai": "gpt-4o-mini",
    "anthropic": "claude-3-5-sonnet-latest",
    "ollama": "qwen2.5:7b",
}

app = FastAPI(title="CoTSimilarity eval shim")

# Same system framing the repo uses: force a \boxed{} final answer so the
# answer extractor can score it.
SYSTEM_PROMPT = ("You are a helpful mathematics assistant. Solve the problem "
                 "step by step and put your final answer in \\boxed{}.")

_LLM = None  # lazily-loaded vLLM engine (resident once first request lands)


def _ged_key_env() -> str:
    """Env var the configured provider's key comes from (matches LLMConfig)."""
    return f"{GED_PROVIDER.upper()}_API_KEY"


def _ged_enabled() -> bool:
    # Ollama needs no key; every hosted provider reads {PROVIDER}_API_KEY.
    if GED_PROVIDER == "ollama":
        return True
    return bool(os.getenv(_ged_key_env()))


def get_llm():
    global _LLM
    if _LLM is None:
        from vllm import LLM
        kwargs = {"model": MODEL_NAME, "trust_remote_code": True, "dtype": "float16"}
        # On a shared GPU, vLLM's default gpu_memory_utilization (0.90) grabs most
        # of the card and OOMs alongside other processes. COT_EVAL_GPU_UTIL lets the
        # (small) math model reserve only what it needs; COT_EVAL_MAX_MODEL_LEN caps
        # the KV-cache footprint further. Both unset -> vLLM defaults (unchanged).
        util = os.getenv("COT_EVAL_GPU_UTIL", "").strip()
        if util:
            kwargs["gpu_memory_utilization"] = float(util)
        max_len = os.getenv("COT_EVAL_MAX_MODEL_LEN", "").strip()
        if max_len:
            kwargs["max_model_len"] = int(max_len)
        log.info("Loading vLLM model %s (%s) …", MODEL_NAME,
                 ", ".join(f"{k}={v}" for k, v in kwargs.items() if k != "model"))
        _LLM = LLM(**kwargs)
    return _LLM


def generate(problem: str, n: int, temperature: float, max_tokens: int):
    """N sampled responses for one problem (list of strings)."""
    from vllm import SamplingParams
    llm = get_llm()
    messages = [{"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": problem}]
    sp = SamplingParams(temperature=temperature, top_p=1.0,
                        max_tokens=max_tokens, n=n)
    outputs = llm.chat(messages, sp)
    return [o.text for o in outputs[0].outputs]


def score(problem: str, responses, ground_truth: str, dataset_type: str):
    """Per-response correctness + pass-rate via the repo's answer_check.

    Also returns the exception message (or None) per response, so a grader
    crash — silently recorded as "incorrect" — can be told apart from a
    genuine wrong answer without digging through the shim's own logs.
    """
    from utils.evaluate import answer_check
    from cot_eval_service.answer_norm import answers_equivalent, extract_final_answer
    correct = []
    errors = []
    gt = str(ground_truth)
    for r in responses:
        try:
            ok = bool(answer_check(problem, r, gt, dataset_type))
            # Fallback ONLY when answer_check says wrong: rescue rationalized
            # radicals and tuple/"find-all" answers it can't match. This can only
            # upgrade False->True, never the reverse, so correct grades are safe.
            if not ok:
                ok = answers_equivalent(extract_final_answer(r), gt)
            correct.append(ok)
            errors.append(None)
        except Exception as e:  # noqa: BLE001 - a bad extraction is just "incorrect"
            log.warning("answer_check failed: %s", e)
            correct.append(False)
            errors.append(str(e))
    pass_rate = (sum(correct) / len(correct)) if correct else 0.0
    return correct, pass_rate, errors


def _pick_response(responses, correct):
    """Representative trace for the GED: the first correct one, else the first."""
    for r, c in zip(responses, correct):
        if c:
            return r
    return responses[0] if responses else ""


def _build_compressed_graph(problem: str, response_text: str, client):
    """response text -> segmented steps -> LLM-tagged DAG -> compressed DiGraph.

    Returns (compressed_graph, None) on success, or (None, reason) so a single
    failed trace degrades to "no GED" (with a real reason) rather than a 500 or
    a silent, unexplained skip.
    """
    from data_analysis.cot_segmenter import segment_response
    from data_analysis.dag_compressor import build_digraph_with_tags, compress_dag_combined

    step_strings = segment_response(response_text or "")
    if not step_strings:
        return None, "no reasoning steps could be segmented from the response"
    steps = [{"index": i + 1, "text": s} for i, s in enumerate(step_strings)]
    dag, error = client.analyze_reasoning_chain(problem, steps)
    if error or not dag:
        reason = error or "analyze_reasoning_chain returned no DAG"
        log.warning("analyze_reasoning_chain returned no DAG (error=%s)", error)
        return None, reason
    graph = build_digraph_with_tags(dag)
    compressed, _ = compress_dag_combined(graph)
    return compressed, None


def _make_ged_client():
    from data_analysis.llm.api_client import LLMClient
    from data_analysis.llm.config import LLMConfig
    model = GED_MODEL or _DEFAULT_GED_MODEL.get(GED_PROVIDER, "")
    kwargs = {"provider": GED_PROVIDER}
    if model:
        kwargs["model"] = model
    if GED_BASE_URL:
        kwargs["base_url"] = GED_BASE_URL
    elif GED_PROVIDER != "deepseek":
        # LLMConfig's base_url defaults to DeepSeek's endpoint; clear it so other
        # providers use LiteLLM's built-in routing for that provider.
        kwargs["base_url"] = None
    return LLMClient(LLMConfig(**kwargs))


# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #
class SolvabilityRequest(BaseModel):
    problem: str
    ground_truth: str = ""
    n: int = DEFAULT_N
    temperature: float = 1.0
    max_tokens: int = MAX_TOKENS


class Variant(BaseModel):
    problem: str
    ground_truth: str = ""


class PairRequest(BaseModel):
    original: Variant
    simple: Variant
    hard: Variant
    n: int = DEFAULT_N
    temperature: float = 1.0
    max_tokens: int = MAX_TOKENS


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@app.get("/health")
def health():
    try:
        import torch
        cuda = bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        cuda = False
    return {"ok": True, "model": MODEL_NAME, "cuda": cuda,
            "ged_ready": _ged_enabled()}


@app.post("/eval/solvability")
def eval_solvability(req: SolvabilityRequest):
    responses = generate(req.problem, req.n, req.temperature, req.max_tokens)
    correct, pass_rate, errors = score(req.problem, responses, req.ground_truth, "original")
    return {"pass_rate": pass_rate, "n": len(responses),
            "correct": correct, "model": MODEL_NAME,
            "errors": errors, "responses": [r[:6000] for r in responses]}


@app.post("/eval/pair")
def eval_pair(req: PairRequest):
    warnings = []
    result = {}
    reps = {}
    variants = [("original", req.original, "original"),
                ("simple", req.simple, "perturb"),
                ("hard", req.hard, "perturb")]

    # 1) Solvability for every variant.
    for label, v, dataset_type in variants:
        responses = generate(v.problem, req.n, req.temperature, req.max_tokens)
        correct, pass_rate, _errors = score(v.problem, responses, v.ground_truth, dataset_type)
        result[label] = {"pass_rate": pass_rate}
        reps[label] = _pick_response(responses, correct)

    # 2) GED of simple & hard vs the original's reasoning structure.
    if not _ged_enabled():
        warnings.append("GED skipped: DEEPSEEK_API_KEY not set on the eval service.")
    else:
        try:
            from data_analysis.dag_similarity import compute_ged_similarity
            client = _make_ged_client()
            g_orig, g_orig_err = _build_compressed_graph(req.original.problem, reps["original"], client)
            if g_orig is None:
                warnings.append(f"GED skipped: could not extract the original's reasoning DAG ({g_orig_err}).")
            else:
                for label, v in [("simple", req.simple), ("hard", req.hard)]:
                    try:
                        g_var, g_var_err = _build_compressed_graph(v.problem, reps[label], client)
                        if g_var is None:
                            warnings.append(f"GED skipped for {label}: DAG extraction failed ({g_var_err}).")
                            continue
                        sim = compute_ged_similarity(g_orig, g_var, timeout=GED_TIMEOUT)
                        result[label]["ged"] = sim.get("ged")
                        result[label]["similarity_normalized"] = sim.get("similarity_normalized")
                        if sim.get("timed_out"):
                            warnings.append(f"GED for {label} timed out at {GED_TIMEOUT}s.")
                        elif sim.get("error"):
                            warnings.append(f"GED computation error for {label}: {sim['error']}")
                    except Exception as e:  # noqa: BLE001
                        warnings.append(f"GED failed for {label}: {e}")
        except Exception as e:  # noqa: BLE001
            warnings.append(f"GED setup failed: {e}")

    result["original"]["ged"] = None  # the original is the GED reference, not scored
    return {**result, "n": req.n, "model": MODEL_NAME, "warnings": warnings}
