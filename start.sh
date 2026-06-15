#!/bin/bash

# Run from this script's directory so relative paths (and the local config
# sourced just below) resolve no matter where start.sh is invoked from.
cd "$(dirname "$0")"

# ─── Personal Ollama / SSH config ─────────────────────────────────────────────
# Private host/usernames/ports live in ollama.local.sh (git-ignored), not here,
# so the committed script carries no secrets. Copy ollama.local.sh.example to
# ollama.local.sh and fill it in to point at your own Ollama. When the file is
# absent, we fall back to a plain local Ollama and open no SSH tunnel.
if [ -f ollama.local.sh ]; then
    source ./ollama.local.sh
fi

# Defaults so the committed script runs bare (no ollama.local.sh present).
export OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"
TUNNEL_PORT="${TUNNEL_PORT:-}"   # blank = no SSH tunnel
# GPU_SSH stays unset unless ollama.local.sh exports it -> _gpu_status() then
# runs nvidia-smi locally (informational only; generation runs on the Ollama host).

# Open the tunnel only when a remote host AND a local forward port are configured.
USE_TUNNEL=""
if [ -n "$SSH_TARGET" ] && [ -n "$TUNNEL_PORT" ]; then
    USE_TUNNEL=1
fi

# ─── Stop any previously-running viewer server ────────────────────────
# A prior run that wasn't cleanly stopped can keep port 8000 bound. The
# next start then fails to bind: the terminal prints a banner but
# localhost serves nothing. Clear it before every start so ./start.sh is
# always idempotent.
PORT=8000
printf "Clearing any existing server on port %s..." "$PORT"
# 1. Kill by command line — catches the app process.
pkill -f "DSPR_Data_Visualizer/backend/app.py" 2>/dev/null
pkill -f "app.py serve" 2>/dev/null
# 2. Belt-and-suspenders: kill whatever still holds the TCP port.
if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" 2>/dev/null
elif command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:${PORT}" 2>/dev/null | xargs -r kill -9 2>/dev/null
fi
sleep 1
printf " Done\n"

if [ -n "$USE_TUNNEL" ]; then
    printf "Clearing any existing SSH tunnel on port %s..." "$TUNNEL_PORT"
    pkill -f "${TUNNEL_PORT}:localhost:11434" 2>/dev/null
    if command -v fuser >/dev/null 2>&1; then
        fuser -k "${TUNNEL_PORT}/tcp" 2>/dev/null
    elif command -v lsof >/dev/null 2>&1; then
        lsof -ti "tcp:${TUNNEL_PORT}" 2>/dev/null | xargs -r kill -9 2>/dev/null
    fi
    sleep 1
    printf " Done\n"
fi

# Create venv if it doesn't exist
if [ ! -d "venv" ]; then
    printf "Creating virtual environment..."
    python3 -m venv venv
    printf " Done\n"
fi
printf "Activating virtual environment..."
source venv/bin/activate
printf " Done\n"

# Only reinstall if requirements.txt has changed. Hash with whatever the OS
# provides: md5sum on Linux/WSL, shasum/md5 on macOS (which has no md5sum).
HASH_FILE="venv/.req_hash"
REQ_PATH="requirements.txt"
if command -v md5sum >/dev/null 2>&1; then
    CURRENT_HASH=$(md5sum "$REQ_PATH" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
    CURRENT_HASH=$(shasum "$REQ_PATH" | awk '{print $1}')
else
    CURRENT_HASH=$(md5 -q "$REQ_PATH")
fi

if [ ! -f "$HASH_FILE" ] || [ "$CURRENT_HASH" != "$(cat $HASH_FILE)" ]; then
    printf "Installing dependencies..."
    pip3 install -r "$REQ_PATH" --quiet
    echo "$CURRENT_HASH" > "$HASH_FILE"
    printf " Done\n"
fi

# Avoid the HuggingFace Xet backend, which has hung on this box before.
export HF_HUB_DISABLE_XET=1

# Point the generator at the remote Ollama via an SSH tunnel, opened here and
# torn down when this script exits. Skipped entirely when no tunnel is
# configured (the generator then talks to OLLAMA_HOST directly).
TUNNEL_PID=""
cleanup() {
    if [ -n "$TUNNEL_PID" ]; then
        printf "\nClosing SSH tunnel (pid %s)...\n" "$TUNNEL_PID"
        kill "$TUNNEL_PID" 2>/dev/null
    fi
}
trap cleanup EXIT INT TERM

if [ -n "$USE_TUNNEL" ]; then
    printf "Opening SSH tunnel (Ollama on local port %s)..." "$TUNNEL_PORT"
    ssh -N -f \
        ${SSH_JUMP:+-J "$SSH_JUMP"} \
        -L "${TUNNEL_PORT}:localhost:11434" \
        "$SSH_TARGET" -p "${SSH_PORT:-22}"
    TUNNEL_PID=$(pgrep -n -f "${TUNNEL_PORT}:localhost:11434")
    printf " Done (pid %s)\n" "$TUNNEL_PID"
else
    printf "No SSH tunnel configured — using Ollama at %s\n" "$OLLAMA_HOST"
    printf "  (copy ollama.local.sh.example to ollama.local.sh to use a remote host)\n"
fi

# Start the server
printf "Starting server on http://127.0.0.1:%s ...\n" "$PORT"
python3 backend/app.py serve --port "$PORT"
