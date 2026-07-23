#!/bin/bash
# Sync cot_eval_service/ to the remote GPU host and restart it there — the
# single command to run after editing cot_eval_service/app.py locally.
#
# Usage (from the repo root, in WSL — needs the same ssh/scp as start.sh):
#   ./scripts/deploy_eval_shim.sh
#
# Reads SSH_TARGET / SSH_PORT / SSH_JUMP / REMOTE_DSPR_DIR from ollama.local.sh
# (the same file start.sh sources for the Ollama/eval tunnel).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f ollama.local.sh ] && source ollama.local.sh

: "${SSH_TARGET:?Set SSH_TARGET in ollama.local.sh}"
: "${SSH_PORT:=22}"
: "${REMOTE_DSPR_DIR:?Set REMOTE_DSPR_DIR in ollama.local.sh, e.g. /scratch/<user>/DSPR (the CoTSimilarity repo root)}"

JUMP_ARGS=()
[ -n "${SSH_JUMP:-}" ] && JUMP_ARGS=(-J "$SSH_JUMP")

echo "==> Syncing cot_eval_service/ -> $SSH_TARGET:$REMOTE_DSPR_DIR/cot_eval_service/"
scp "${JUMP_ARGS[@]}" -P "$SSH_PORT" -r cot_eval_service/ "$SSH_TARGET:$REMOTE_DSPR_DIR/"

if [ -f cot_eval.local.sh ]; then
    echo "==> Syncing cot_eval.local.sh -> $SSH_TARGET:~/.cot_eval_env"
    scp "${JUMP_ARGS[@]}" -P "$SSH_PORT" cot_eval.local.sh "$SSH_TARGET:.cot_eval_env"
else
    echo "==> No cot_eval.local.sh locally — leaving ~/.cot_eval_env on the remote untouched"
    echo "    (copy cot_eval.local.sh.example -> cot_eval.local.sh to manage the GED key from here)"
fi

echo "==> Restarting shim on remote..."
ssh "${JUMP_ARGS[@]}" -p "$SSH_PORT" "$SSH_TARGET" "bash $REMOTE_DSPR_DIR/cot_eval_service/restart.sh"
