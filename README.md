# meshdirect

OpenClaw-free, in-process, token-streaming chat backend — drop-in replacement for the
qwen38 mesh GUI stack (`zqx.lat/qwen38`). No per-turn process spawn: the model client is a
warm streaming HTTP client inside the Node process; browser clients get live token deltas
over SSE.

## Architecture

```
browser/Android-WebView
   │  https://zqx.lat/qwen38/ (nginx, unchanged) ──► 127.0.0.1:31838 (prod, later cutover)
   │  dev: http://127.0.0.1:31841 (meshdirect-dev.service)
   ▼
Express app (server/)
   ├─ auth.js        env creds + bcrypt, in-memory session Map, __Secure cookie, CSRF, Origin
   ├─ ratelimit.js   sliding-window limiters (express-rate-limit parity, no dep)
   ├─ jobs.js        per-model lanes: 1 running + ≤2 queued; job store (15 min retention)
   ├─ modelclient.js streaming chat/completions via HTTPS proxy CONNECT tunnel;
   │                 primary = token-plan (key resolved AT RUNTIME by
   │                 /usr/local/libexec/openclaw-sg1-vault-resolver, refreshed on 401),
   │                 fallback = free-pool (key read at boot from openclaw.json, memory only)
   ├─ sessions.js    JSONL transcripts in sessions/{model}-main.jsonl
   │                 + one-time OpenClaw transcript import (marker: sessions/.imported)
   └─ state.js       /state payload (same shape as the old bridge-sourced one)
```

Dependencies: **express 4 + bcryptjs only** (node_modules copied from the old app's
read-only tree because npm egress is policy-blocked; versions match the contract:
express 4.22.2, bcryptjs 3.0.3).

## Endpoints (base `/qwen38/api`, also mounted at `/api` on the dev port)

| Method | Path | Notes |
|---|---|---|
| GET | /health | `{"ok":true}` |
| GET | /session | `{"authenticated":false}` or SessionPayload |
| POST | /login | Origin + JSON; bcrypt; 8 fails/15 min → 429 |
| POST | /logout | Origin + CSRF; 204 |
| GET | /history?model=&sessionId=main&limit= | HistoryPayload |
| GET | /state | StatePayload (`openclawVersion: "meshdirect 1.0"`, `androidLink:{connectedClients:0,retired:true}`) |
| POST | /chat | 202 JobPublic + `attached:false`; lane full → 429 |
| GET | /chat/:jobId | poll fallback (owner-checked; 404 otherwise) |
| GET | /chat/:jobId/stream | **NEW** SSE: `status` / `delta` / `done` / `error`, `: ping` every 15 s |
| POST | /chat/:jobId/abort | **NEW** `{aborted:true\|false}` |

Static: `/qwen38/` and `/` serve `dist/` (built by the frontend pipeline); assets immutable,
`index.html` no-store. If `dist/` is absent → plain 404, backend still fully functional.

## Env (see /etc/meshdirect-dev.env)

`HOST PORT BASE_PATH ORIGIN_ALLOW SESSION_TTL_MS
APP_USERNAME APP_PASSWORD_HASH` (bcrypt `$2b$12$…`)
`COOKIE_SECURE` (`true` prod → cookie `__Secure-qwen_mesh_session`; `false` dev → `qwen_mesh_session`)
`COOKIE_PATH` — **env-configurable, default `/qwen38`**: prod must be `/qwen38` (cookie contract
with nginx/base path), dev uses `/` so the `/api` convenience mount works too. See `env.example`. `MODEL_LABEL PLAN_LABEL WORKSPACE_LABEL
TURN_TIMEOUT_MS(600000) CONNECT_TIMEOUT_MS(10000) STALL_TIMEOUT_MS(60000) SSE_PING_MS(15000)
HTTPS_PROXY NO_PROXY` (model egress goes via the corporate proxy through an HTTP CONNECT
tunnel; `/etc/hosts` pins the token-plan host to 127.0.0.1 so direct egress cannot work).
Optional overrides: `PRIMARY_BASE_URL FALLBACK_BASE_URL PREVIEW_MODEL_ID STABLE_MODEL_ID
SYSTEM_PROMPT SESSIONS_DIR DIST_DIR`.

**Secrets:** model keys are never on disk in this repo/env. Token-plan key is resolved in
memory at runtime (resolver requires root → service runs as root). Free-pool key is read
into memory at boot. All provider errors are sanitized (`sk-…`, `Bearer …`, absolute paths)
before hitting logs or clients.

## Dev service ops

```
systemctl status meshdirect-dev.service      # 127.0.0.1:31841
journalctl -u meshdirect-dev.service -f
systemctl restart meshdirect-dev.service     # in-memory sessions/jobs are dropped
bash /opt/meshdirect/scripts/selftest.sh <dev-password>   # full API+SSE+TTFT check
```

Hardening: `NoNewPrivileges, PrivateTmp, PrivateDevices, ProtectSystem=full,
ReadWritePaths=/opt/meshdirect/sessions, ProtectClock/Kernel*/ControlGroups, MemoryMax=1G,
Restart=always`. Root is required (vault resolver enforces vault owner root; one-time
transcript import reads `/root/.openclaw-qwen38/…`). No `ProtectHome` for that reason.

## Failover semantics

Primary (token-plan) → on 401: re-resolve key once and retry → on any 401/403/429/5xx or
pre-first-token stall >60 s: free-pool fallback → if that also fails: user-visible `error`
event/status mapped to 429/409/504/502 (legacy mapping). Failover only happens before the
first content delta; a mid-stream stall fails the turn instead of duplicating output.
Connect timeout 10 s; whole-turn cap 600 s; abort via POST aborts the in-flight request.
Failed/aborted user turns are tagged `{failed:true}` in the JSONL transcript and excluded
from future model context (history display is unchanged) — a failed instruction is never
silently re-answered by the next turn.

## Rollback

Old stack is untouched: `qwen38-mesh-gui.service` still serves 127.0.0.1:31838 behind
nginx; meshdirect-dev only listens on 31841. To back out: `systemctl disable --now
meshdirect-dev.service` and (optionally) `rm -rf /opt/meshdirect /etc/meshdirect-dev.env
/etc/systemd/system/meshdirect-dev.service`. Cutover later = point nginx `/qwen38/` at
31838's replacement or swap ports — nginx config is not modified by this project.

## Deviations from the legacy stack (dev service)

- Dev runs `COOKIE_SECURE=false` (cookie name `qwen_mesh_session`, Path=/) so plain-http
  loopback testing works; prod cutover uses `COOKIE_SECURE=true` → `__Secure-qwen_mesh_session`,
  Path=/qwen38 (exact parity).
- `androidLink` reports `{connectedClients:0, retired:true}` (Android WS relay path is
  separate and untouched).
- Jobs/sessions in memory only (parity): restart = everyone logged out, jobIds 404.
