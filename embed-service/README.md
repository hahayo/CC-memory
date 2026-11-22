# embed-service

本機 BAAI/bge-m3 dense embedding（稠密向量）服務，供 CC-memory 以
`EMBEDDING_PROVIDER=local` 取代 Gemini embedding API。

## 為什麼是常駐服務

bge-m3 模型載入需數秒並佔用 GPU 記憶體；若每次 embedding 都重新載入，延遲與記憶體
成本都無法接受。常駐 HTTP 服務（bind 127.0.0.1，不對外）讓 worker 的每次呼叫只付
encode 時間，並讓多個 worker 共用同一份模型。

## 安裝

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 啟動

```bash
CC_EMBED_PORT=8790 .venv/bin/python server.py   # 8790 為預設值，可省略
```

有 CUDA 時以 fp16 載入；無 CUDA 退回 CPU fp32。輸出固定 1024 維、已 L2 normalize。

## API 範例

```bash
curl -s http://127.0.0.1:8790/health
# {"ok":true,"model":"BAAI/bge-m3","dimensions":1024,"device":"cuda"}

curl -s -X POST http://127.0.0.1:8790/embed \
  -H 'Content-Type: application/json' \
  -d '{"inputs":["hello","world"]}'
# {"model":"BAAI/bge-m3","dimensions":1024,"embeddings":[[...],[...]]}
```

限制：單次最多 64 筆輸入、request body 上限 2 MiB。

## 一致性驗證（parity check）

對照 `embed-test-20261122` 預先算好的 corpus embedding，抽樣比 cosine
similarity（餘弦相似度），min ≥ 0.999 才算 PASS：

```bash
.venv/bin/python check_parity.py                 # 預設 url / data-dir / n=300
.venv/bin/python check_parity.py --n 100 --seed 1
```

## 安裝成 systemd user service（使用者服務）

`cc-memory-embed.service` 是 systemd user unit（使用者層級服務單元）範本，
讓 embed-service 開機自動常駐、掛掉自動重啟（Restart=on-failure）。

```bash
mkdir -p ~/.config/systemd/user
cp cc-memory-embed.service ~/.config/systemd/user/
# 編輯 CC_EMBED_PYTHON（指向本機 venv 的 python）與 CC_EMBED_SERVER（指向 server.py）
$EDITOR ~/.config/systemd/user/cc-memory-embed.service
systemctl --user daemon-reload
systemctl --user enable --now cc-memory-embed.service
```

檢查：

```bash
systemctl --user status cc-memory-embed.service
journalctl --user -u cc-memory-embed -f   # 追蹤日誌（log）
curl -s http://127.0.0.1:8790/health
```

若要讓服務在「沒有登入 session（工作階段）」時也持續運作（例如 SSH 登出後、
開機即常駐），需開啟 linger（駐留）：

```bash
loginctl enable-linger "$USER"
```
