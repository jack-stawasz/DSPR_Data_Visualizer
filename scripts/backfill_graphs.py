#!/usr/bin/env python3
"""Backfill reasoning-graph previews for already-Verified records.

The Verify tab builds a preview on demand, one record at a time. This walks the
Verified pool and does the same work ahead of time, persisting each result to
data/graph_previews/reasoning_graphs.jsonl so the viewer opens instantly.

Reuses app._run_graph_job (like llm_generate.py reuses app's record helpers) so a
backfilled payload is byte-identical to one produced by the button — same variant
loop, same per-variant error handling, same sidecar write.

Resumable: records already in the sidecar are skipped unless --force is given, so
an interrupted run picks up where it left off.

IMPORTANT: each record costs ~105s of remote GPU time (3 variants x sampling +
LLM DAG extraction), and the graphs are NOT reproducible — they come from
temperature-1.0 sampling, so a stored graph is a snapshot of one trace, not
necessarily the trace behind that record's cached GED score.

Needs the SSH tunnel to the eval shim open (start.sh opens it; see
cot_eval_service/README.md).

Run from the repo root:
    python scripts/backfill_graphs.py --limit 20      # pilot
    python scripts/backfill_graphs.py                 # the rest
"""

import argparse
import re
import sys
import time
from pathlib import Path

# app.py lives in ../backend relative to this script; add it to the import path
# so `from app import ...` resolves no matter where this is invoked from.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app import (  # noqa: E402
    GRAPH_STORE_FILE,
    STATUS_VERIFIED,
    _graph_store_all,
    _read_dataset,
    _run_graph_job,
)
import cot_eval  # noqa: E402


def print_stats(stored: dict, verified: list):
    """Coverage report over the sidecar — what's done, what still has gaps, and
    which failure reasons dominate (the input to 'is another pass worth it?')."""
    from collections import Counter

    def graphed(rec):
        return sum(1 for v in (rec.get("variants") or {}).values()
                   if (v or {}).get("compressed"))

    n = len(stored)
    if not n:
        print("No previews stored yet.")
        return
    full = sum(1 for r in stored.values() if graphed(r) == 3)
    partial = sum(1 for r in stored.values() if 0 < graphed(r) < 3)
    zero = sum(1 for r in stored.values() if graphed(r) == 0)
    variants = sum(graphed(r) for r in stored.values())
    carried = sum(1 for r in stored.values()
                  for v in (r.get("variants") or {}).values() if (v or {}).get("carried_over"))

    print(f"Verified records : {len(verified)}")
    print(f"  with a preview : {n} ({100*n/max(1,len(verified)):.0f}%)")
    print(f"    complete 3/3 : {full}")
    print(f"    partial      : {partial}")
    print(f"    no graphs    : {zero}")
    print(f"  variants graphed: {variants}/{3*n} ({100*variants/max(1,3*n):.0f}%)")
    if carried:
        print(f"  carried over from an earlier attempt: {carried} variants")

    reasons = Counter()
    per_variant = Counter()
    for rec in stored.values():
        for name, v in (rec.get("variants") or {}).items():
            if not (v or {}).get("compressed"):
                per_variant[name] += 1
                err = (v or {}).get("error") or "unknown"
                # Collapse the numbers out of "Expected 22 steps, got 19" etc. so
                # the same failure mode groups into one bucket.
                err = re.sub(r"\d+", "N", err)
                reasons[err[:90]] += 1
    if reasons:
        print("\n  failures by variant:", dict(per_variant))
        print("  failure reasons (top 6):")
        for reason, count in reasons.most_common(6):
            print(f"    {count:4d}  {reason}")
    if GRAPH_STORE_FILE.exists():
        mb = GRAPH_STORE_FILE.stat().st_size / 1e6
        print(f"\n  sidecar: {mb:.1f} MB ({mb/max(1,n)*1000:.0f} KB/record)")


def _wait_for_service(max_wait: int, poll: int = 30) -> bool:
    """True once the shim answers /health; False if still down after max_wait.

    Returns immediately on the common path (service up), so the per-record cost is
    one ~5s probe.
    """
    deadline = time.time() + max_wait
    first = True
    while True:
        if cot_eval.probe_eval()["reachable"]:
            if not first:
                print("  eval service is back — continuing.")
            return True
        if time.time() >= deadline:
            return False
        if first:
            print(f"  eval service unreachable — waiting up to {max_wait}s for it "
                  "to come back…")
            first = False
        time.sleep(poll)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=0,
                    help="stop after N records (0 = all remaining)")
    ap.add_argument("--force", action="store_true",
                    help="regenerate records that already have a stored preview")
    ap.add_argument("--retry-incomplete", action="store_true",
                    help="only redo stored records where some variant has no graph "
                         "(extraction failures — e.g. after switching GED model)")
    ap.add_argument("--dry-run", action="store_true",
                    help="list what would run, then exit")
    ap.add_argument("--stats", action="store_true",
                    help="print a coverage report (complete/partial/zero, failure "
                         "reasons ranked, sidecar size) and exit — no GPU calls, "
                         "works even if the eval service is unreachable")
    ap.add_argument("--abort-after", type=int, default=5, metavar="N",
                    help="stop after N consecutive record failures (default 5). "
                         "Guards a long unattended run against a dropped SSH "
                         "tunnel, which would otherwise burn through the whole "
                         "list failing instantly. 0 disables.")
    ap.add_argument("--service-wait", type=int, default=300, metavar="SEC",
                    help="before each record, if the shim is unreachable, wait up "
                         "to SEC for it to return before aborting (default 300)")
    args = ap.parse_args()

    if args.stats:
        stored = _graph_store_all()
        verified = [r for r in _read_dataset() if r.get("status") == STATUS_VERIFIED]
        print_stats(stored, verified)
        return 0

    probe = cot_eval.probe_eval()
    if not probe["reachable"]:
        print(f"Eval service unreachable: {probe['error']}", file=sys.stderr)
        print("Is the SSH tunnel open? (./start.sh opens it)", file=sys.stderr)
        return 1
    if not probe.get("ged_ready"):
        print("WARNING: the shim reports ged_ready=false — DAG extraction is "
              "disabled there, so every variant will come back with an error.",
              file=sys.stderr)

    stored = _graph_store_all()
    verified = [r for r in _read_dataset() if r.get("status") == STATUS_VERIFIED]

    def incomplete(pid):
        """Stored, but some variant produced no graph (extraction failed)."""
        rec = stored.get(pid)
        return bool(rec) and any(not (v or {}).get("compressed")
                                 for v in (rec.get("variants") or {}).values())

    if args.retry_incomplete:
        todo = [r for r in verified if incomplete(r.get("problem_id"))]
    else:
        todo = [r for r in verified
                if args.force or r.get("problem_id") not in stored]
    if args.limit:
        todo = todo[:args.limit]

    print(f"Verified records: {len(verified)} | already stored: {len(stored)} "
          f"| to process now: {len(todo)}")
    print(f"Sidecar: {GRAPH_STORE_FILE}")
    if args.dry_run:
        print("problem_ids:", [r.get("problem_id") for r in todo])
        return 0
    if not todo:
        print("Nothing to do.")
        return 0
    print(f"Estimated ~{len(todo) * 105 / 60:.0f} min of remote GPU time. Ctrl-C to stop "
          "(finished records are already saved).\n")

    ok = failed = streak = 0
    started = time.time()
    for i, rec in enumerate(todo, start=1):
        pid = rec.get("problem_id")
        # Pre-flight: a 5s health probe beats discovering the shim is gone via
        # three 900s POST timeouts (~45 min of nothing, per record). Ride out a
        # brief blip, then give up rather than burn the rest of the list.
        if not _wait_for_service(args.service_wait):
            print(f"\nAborting at [{i}/{len(todo)}]: eval service unreachable for "
                  f"{args.service_wait}s (dropped SSH tunnel?). Re-run when it's "
                  "back — completed records are saved and will be skipped.")
            break
        t0 = time.time()
        try:
            # _run_graph_job publishes progress onto the job dict; a throwaway one
            # is fine here since nothing is polling it.
            payload = _run_graph_job(pid, rec, {})
        except KeyboardInterrupt:
            print("\nInterrupted — records completed so far are saved.")
            break
        except Exception as e:  # noqa: BLE001 - one bad record must not end the run
            failed += 1
            streak += 1
            print(f"[{i}/{len(todo)}] id={pid} FAILED after {time.time()-t0:.0f}s: {e}")
            if args.abort_after and streak >= args.abort_after:
                print(f"\nAborting: {streak} consecutive failures — the eval service "
                      "is probably unreachable (dropped SSH tunnel?). Fix it and "
                      "re-run; completed records are saved and will be skipped.")
                break
            continue
        warns = payload.get("warnings") or []
        drew = sum(1 for v in payload["variants"].values() if v.get("compressed"))
        ok += 1
        print(f"[{i}/{len(todo)}] id={pid} {time.time()-t0:.0f}s "
              f"{drew}/3 variants graphed"
              + (f" | warnings: {'; '.join(warns)[:160]}" if warns else ""))

        # _run_graph_job absorbs per-variant errors, so an unreachable shim comes
        # back as a "successful" 0/3 record — which is exactly what a dropped SSH
        # tunnel looks like. Count that toward the abort streak, or the guard
        # sails straight through an outage burning the whole list at ~12s each.
        if drew == 0:
            streak += 1
            if args.abort_after and streak >= args.abort_after:
                print(f"\nAborting: {streak} consecutive records produced NO graphs — "
                      "the eval service is probably unreachable (dropped SSH tunnel?). "
                      "Fix it and re-run with --retry-incomplete; nothing is lost.")
                break
        else:
            streak = 0

    mins = (time.time() - started) / 60
    print(f"\nDone: {ok} stored, {failed} failed, {mins:.1f} min elapsed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
