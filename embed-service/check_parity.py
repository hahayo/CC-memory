#!/usr/bin/env python3
"""Parity check: live /embed service vs precomputed bge_m3_corpus.npy.

Samples --n ids from results/bge_m3_ids.json (seeded), POSTs the corpus text to
/embed in batches of <=64, compares cosine similarity against the stored float16
vectors. Prints n/min/median/mean cosine, the 3 lowest-scoring ids, and PASS if
min >= 0.999 (else FAIL, exit 1). Then measures median latency of a fixed
generic query (1 warmup + 5 timed calls).

Never prints corpus text — only ids, counts, and numbers.
"""
import argparse
import json
import os
import random
import statistics
import time
import urllib.error
import urllib.request

import numpy as np

MODEL_DIM = 1024
LATENCY_QUERY = "embedding 服務延遲測試"


def post_embed(url, inputs, timeout=120):
    body = json.dumps({"inputs": inputs}).encode("utf-8")
    req = urllib.request.Request(
        f"{url.rstrip('/')}/embed", data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def main():
    parser = argparse.ArgumentParser(description="bge-m3 service parity check")
    parser.add_argument("--url", default="http://127.0.0.1:8790")
    parser.add_argument("--data-dir",
                        default="/home/haha/.cache/cc-memory/embed-test-20261122")
    parser.add_argument("--n", type=int, default=300)
    parser.add_argument("--seed", type=int, default=20261122)
    args = parser.parse_args()

    results_dir = os.path.join(args.data_dir, "results")
    corpus_path = os.path.join(args.data_dir, "data", "corpus.jsonl")

    with open(os.path.join(results_dir, "bge_m3_ids.json")) as f:
        ids = json.load(f)
    stored = np.load(os.path.join(results_dir, "bge_m3_corpus.npy"))

    texts = {}
    with open(corpus_path, encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            texts[row["id"]] = row["text"]

    n = min(args.n, len(ids))
    sample_ids = random.Random(args.seed).sample(ids, n)
    idx_of = {i: k for k, i in enumerate(ids)}

    cosines = []
    for start in range(0, n, 64):
        batch_ids = sample_ids[start:start + 64]
        payload = post_embed(args.url, [texts[i] for i in batch_ids])
        live = np.asarray(payload["embeddings"], dtype=np.float32)
        ref = stored[[idx_of[i] for i in batch_ids]].astype(np.float32)
        live /= np.linalg.norm(live, axis=1, keepdims=True)
        ref /= np.linalg.norm(ref, axis=1, keepdims=True)
        cosines.extend((live * ref).sum(axis=1).tolist())

    lowest = sorted(range(n), key=lambda i: cosines[i])[:3]
    print(f"n={n} min={min(cosines):.6f} median={statistics.median(cosines):.6f} "
          f"mean={statistics.mean(cosines):.6f}")
    print("lowest-3 ids:", [sample_ids[i] for i in lowest])

    # Latency: 1 warmup + 5 timed calls of a fixed generic query.
    post_embed(args.url, [LATENCY_QUERY])
    lat = []
    for _ in range(5):
        t0 = time.perf_counter()
        post_embed(args.url, [LATENCY_QUERY])
        lat.append((time.perf_counter() - t0) * 1000)
    print(f"latency median={statistics.median(lat):.1f}ms")

    if min(cosines) >= 0.999:
        print("PASS")
    else:
        print("FAIL")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
