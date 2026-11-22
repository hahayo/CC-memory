#!/usr/bin/env python3
"""Local BAAI/bge-m3 dense embedding service (stdlib HTTP).

Endpoints:
  GET  /health  -> {"ok": true, "model": "BAAI/bge-m3", "dimensions": 1024, "device": "cuda"|"cpu"}
  POST /embed   body {"inputs": [str, ...]} ->
       {"model": "BAAI/bge-m3", "dimensions": 1024, "embeddings": [[...], ...]}

Bind: 127.0.0.1 only. Port: env CC_EMBED_PORT (default 8790).
Never logs request bodies or input text — only counts and durations.
"""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_NAME = "BAAI/bge-m3"
MAX_SEQ = 1024
BATCH = 32
MAX_INPUTS = 64
MAX_BODY_BYTES = 2 * 1024 * 1024  # 2 MiB

PORT = int(os.environ.get("CC_EMBED_PORT", "8790"))

# ---------------------------------------------------------------------------
# Model load (mirrors embed-test-20261122/scripts/embed_corpus.py: CUDA fp16 via
# model_kwargs dtype, max_seq_length=1024, normalized dense embeddings)
# ---------------------------------------------------------------------------
import torch
from sentence_transformers import SentenceTransformer

if torch.cuda.is_available():
    DEVICE = "cuda"
    MODEL = SentenceTransformer(MODEL_NAME, device="cuda",
                                model_kwargs={"dtype": "float16"})
else:
    DEVICE = "cpu"
    MODEL = SentenceTransformer(MODEL_NAME, device="cpu")
MODEL.max_seq_length = MAX_SEQ
DIMENSIONS = int(MODEL.get_sentence_embedding_dimension())
MODEL_LOCK = threading.Lock()


def encode(texts):
    with MODEL_LOCK:
        return MODEL.encode(texts, batch_size=BATCH, normalize_embeddings=True,
                            convert_to_numpy=True, show_progress_bar=False)


class Handler(BaseHTTPRequestHandler):
    server_version = "cc-embed-bge-m3/1.0"
    protocol_version = "HTTP/1.1"
    # StreamRequestHandler 把它套成 socket timeout，擋 stalled client。
    timeout = 30

    # 永不記錄 request line／path／parser 訊息（可能含敏感內容）。
    # log_request 只記固定 route label + 數字 status；log_error 只記固定字串。
    def log_request(self, code="-", size="-"):
        # request line 解析失敗時 self.path 尚未設定（send_error 仍會呼叫 log_request）
        path = getattr(self, "path", None)
        if path == "/health":
            route = "health"
        elif path == "/embed":
            route = "embed"
        else:
            route = "other"
        status = code if isinstance(code, int) else 0
        self.server.log(f"request route={route} status={status}")

    def log_error(self, fmt, *args):  # noqa: A002 - stdlib signature
        self.server.log("request error")

    def log_message(self, fmt, *args):  # noqa: A002 - stdlib signature
        # 不格式化請求相關的 args：http.server 內部呼叫只剩 log_request/log_error
        # 會走到這裡，皆已在上面的 override 處理掉內容。
        self.server.log("request logged")

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        if status >= 400:
            # 錯誤回應可能發生在 body 尚未讀完時；關閉連線，避免殘留 body 被當成下一個 request
            self.close_connection = True
        self.send_response(status)
        if status >= 400:
            self.send_header("Connection", "close")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - stdlib signature
        if self.path != "/health":
            self._send_json(404, {"error": "not found"})
            return
        self._send_json(200, {
            "ok": True,
            "model": MODEL_NAME,
            "dimensions": DIMENSIONS,
            "device": DEVICE,
        })

    def do_POST(self):  # noqa: N802 - stdlib signature
        if self.path != "/embed":
            self._send_json(404, {"error": "not found"})
            return
        length_raw = self.headers.get("Content-Length")
        if length_raw is None:
            self._send_json(411, {"error": "content-length required"})
            return
        try:
            length = int(length_raw)
        except ValueError:
            self._send_json(400, {"error": "invalid content-length"})
            return
        if length < 0 or length > MAX_BODY_BYTES:
            self._send_json(413, {"error": "payload too large"})
            return
        body = self.rfile.read(length)
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {"error": "invalid JSON"})
            return
        inputs = payload.get("inputs") if isinstance(payload, dict) else None
        if not isinstance(inputs, list) or len(inputs) == 0:
            self._send_json(400, {"error": "inputs must be a non-empty list"})
            return
        if len(inputs) > MAX_INPUTS:
            self._send_json(400, {"error": f"inputs exceeds max {MAX_INPUTS}"})
            return
        if not all(isinstance(t, str) for t in inputs):
            self._send_json(400, {"error": "inputs must be strings"})
            return

        t0 = time.time()
        try:
            emb = encode(inputs)
        except Exception as exc:  # model errors must not leak input text
            self.server.log(f"encode failed ({type(exc).__name__}) n={len(inputs)}")
            self._send_json(500, {"error": "encode failed"})
            return
        elapsed_ms = (time.time() - t0) * 1000
        self.server.log(f"embed n={len(inputs)} {elapsed_ms:.1f}ms")
        self._send_json(200, {
            "model": MODEL_NAME,
            "dimensions": DIMENSIONS,
            "embeddings": emb.tolist(),
        })


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._log_lock = threading.Lock()

    def log(self, message):
        with self._log_lock:
            print(f"[embed] {message}", flush=True)


def main():
    server = Server(("127.0.0.1", PORT), Handler)
    server.log(f"listening on 127.0.0.1:{PORT} model={MODEL_NAME} "
               f"dim={DIMENSIONS} device={DEVICE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
