#!/bin/bash
# Restart the CoT eval shim in place, ON THE REMOTE GPU HOST.
#
# Not meant to be run locally — scripts/deploy_eval_shim.sh scp's this whole
# cot_eval_service/ folder to the remote and then SSHes in to run it there.
# Secrets (GEMINI_API_KEY etc.) are never in this repo: this script sources
# ~/.cot_eval_env on the remote. Manage its contents FROM THE LOCAL MACHINE —
# copy cot_eval.local.sh.example -> cot_eval.local.sh (repo root, git-ignored),
# fill in your key, and deploy_eval_shim.sh scp's it to ~/.cot_eval_env on every
# run. Don't hand-edit ~/.cot_eval_env on the remote: it gets overwritten by the
# next deploy and a stray edit there isn't visible to git or local review.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root (the parent of cot_eval_service/)

if [ -f ~/.cot_eval_env ]; then
    source ~/.cot_eval_env
else
    echo "warning: ~/.cot_eval_env not found — GED scoring will be disabled" >&2
fi

PORT="${COT_EVAL_PORT:-8100}"

pkill -f "uvicorn cot_eval_service.app:app" 2>/dev/null || true
sleep 1

nohup testenv/bin/uvicorn cot_eval_service.app:app --host 127.0.0.1 --port "$PORT" \
    --workers 1 > ~/cot_eval.log 2>&1 &
disown

sleep 3
if curl -sf "http://localhost:$PORT/health"; then
    echo
else
    echo "shim did not come up — tail of ~/cot_eval.log:" >&2
    tail -n 40 ~/cot_eval.log >&2
    exit 1
fi
