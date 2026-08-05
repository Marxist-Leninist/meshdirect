# MeshDirect

Native Qwen 3.8 chat and agent harness for `zqx.lat/qwen38`. It talks directly to
the Alibaba OpenAI-compatible endpoint, executes model-requested work through
the SG1 and SG2 MCP servers, and streams safe activity/result events to browser
clients over SSE.

## Runtime

- `server/modelclient.js` — warm streaming provider client and key failover.
- `server/agentloop.js` — model → tool → model loop with native function calls,
  live steering, safe textual-call recovery, and no arbitrary round cap by default.
- `server/sgtools.js` — built-in `sg1` and `sg2` catalog/search/call gateways.
- `server/agentcaps.js` — native goals, memories, skills, durable self-wakes,
  detached subagents, and runtime MCP-server registration.
- `server/mcpclient.js` — dual-era MCP HTTP client: current per-request metadata,
  legacy initialized sessions, SSE/JSON responses, authenticated headers, and
  stateless compatibility fallback.
- `server/jobs.js` — one running job per model lane, bounded queue, abort, live
  tool activity, idempotent client turn IDs, and transcript persistence.
- `server/images.js` — PNG/JPEG/WebP/GIF validation for multimodal turns (four
  images maximum, 5 MB each, 12 MB total).
- `server/app.js` — authenticated JSON API, CSRF/origin checks, SSE, and static
  frontend delivery.
- `scripts/meshdirect-healthguard.sh` plus `deploy/meshdirect-healthguard.*`
  — a systemd timer that verifies the private health route and repairs an
  accidentally stopped or unhealthy service after two failed probes.

Provider keys are never stored in this repository or environment files. The
primary key is resolved into memory by `/usr/local/libexec/meshdirect-key-resolver`.
An optional fallback key is read once from the root-owned, mode-0600 file
`/etc/meshdirect-fallback-key`. Provider errors and SG results are secret-redacted.

## API

The production base is `/qwen38/api`; development also mounts `/api`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/session` | Authentication state and CSRF token |
| POST | `/login`, `/logout` | Account session |
| GET | `/history?model=preview|stable` | Shared model history |
| GET | `/state` | Lane, model, token, and tool progress |
| POST | `/chat` | Queue a text and/or image turn with a required `clientTurnId`; returns HTTP 202 |
| GET | `/chat/by-client/:clientTurnId` | Recover a turn after reload or reconnect |
| POST | `/chat/by-client/:clientTurnId/abort` | Stop a turn even if its enqueue response was lost |
| GET | `/chat/:jobId` | Poll a turn |
| GET | `/chat/:jobId/stream` | SSE `status`, `activity`, `delta`, `done`, `error` |
| POST | `/chat/:jobId/abort` | Stop a queued or running turn |

## Limits and behavior

- Messages: 12,000 characters.
- Images: four, 5 MB each, 12 MB total; PNG, JPEG, WebP, or GIF.
- Agent loop: no arbitrary provider-round or tool-call cap by default; explicit service configuration can restore finite limits.
- SG results: 60,000 characters after credential redaction.
- Failed user turns remain visible but are excluded from later model context.
- The most recent prior image turn is supplied again for visual follow-up questions.
- Client turn IDs and completion tombstones are durable, preventing SG side-effect
  replay after a browser or service restart.
- Session JSONL files are mode 0600 under a mode-0700 directory.
- Capability state is atomically persisted under private `state/` storage.
  Long-range schedules are polled rather than held in one giant timer, and stale
  detached subagents are marked interrupted after a service restart.
- Runtime MCP credentials should be referenced by environment variable or by a
  file under `/etc/meshdirect-secrets` or `/run/secrets`; secret values are not
  returned by the registry and sensitive literal headers are rejected.
- The installed healthguard checks every 30 seconds. A healthy process is left
  untouched; two consecutive failed probes cause the stopped service to be
  started or an unhealthy active service to be restarted and verified.
- Active queues are in memory; the browser recovers them across reloads and safely
  closes interrupted jobs after a service restart. Login sessions persist only as
  token digests in a private mode-0600 state file and slide forward while in use.

## Verification

```sh
npm run check
bash scripts/selftest.sh <dev-password>
node scripts/vision-smoke.js <image-file> stable
```

`npm run check` performs syntax checks and focused tests for native fragmented
function calls, textual-call recovery, current and legacy MCP HTTP, secret
redaction, self-scheduling, detached-subagent recovery, concurrent model lanes,
image validation/follow-up, durable idempotency, and restart reconciliation.
