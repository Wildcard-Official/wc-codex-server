# Streaming Agent Module – Design & Architecture

## 1. Objective

Provide a head-less, HTTP/2 **bidirectional streaming** service that exposes the same capabilities as the interactive Codex CLI. This lets any backend (e.g. a Fastify app) drive Codex sessions programmatically while still receiving real-time token/tool events.

Key goals:

- Re-use the existing **AgentLoop** engine without modification.
- Rely on raw HTTP/2 streams (no gRPC) to minimise binary size and avoid the need for a protobuf tool-chain on constrained compute.
- Keep transport and business logic separate so the same core can later be exposed via WebSockets or gRPC if required.

## 2. High-level Architecture

```
+--------------+        h2 bidirectional         +---------------------------+
| Fastify App  |  ─────────────────────────────► |   Streaming Agent Server  |
| (client)     |                                 |  (this module)            |
|              | ◄────────────────────────────── |                           |
+--------------+        real-time events         |  • HTTP/2 server          |
                                                |  • wraps AgentLoop        |
                                                +---------------------------+
```

1. Client opens a single HTTP/2 **POST /agent/stream** stream.
2. Client writes JSON frames containing user input, control commands, or approval decisions.
3. Server instantiates/recovers an **AgentLoop** for that session and streams back JSON frames for each `ResponseItem`, plus synthetic events (heartbeat, errors, etc.).
4. Either side may half-close the stream to finish the session; the other side receives a final `terminate` frame and closes its end.

## 3. Directory / File Layout

```
codex-api/                # ← new workspace package
├─ package.json
├─ tsconfig.json
├─ src/
│  ├─ server/
│  │  ├─ index.ts              # bootstrap an h2 server (h2c + TLS)
│  │  ├─ routes/
│  │  │  └─ agent.ts           # implements POST /agent/stream handler
│  │  └─ transport/
│  │     └─ http2.ts           # codec for length-prefixed JSON frames
│  ├─ core/
│  │  ├─ agent-wrapper.ts      # thin wrapper around AgentLoop
│  │  ├─ session-manager.ts    # in-memory & file-backed store for sessions
│  │  └─ confirmation-queue.ts # resolves approval promises
│  ├─ types/
│  │  └─ protocol.ts           # shared JSON schema for frames
│  ├─ utils/
│  │  └─ serializer.ts         # converts ResponseItem ↔ transport form
│  └─ cli/
│     └─ demo-client.ts        # example h2 client (for local testing)
└─ README.md                    # usage & curl examples
```

**Rationale**

- `server/transport/http2.ts` holds _all_ framing details so we can swap in a websocket transport later.
- `core/agent-wrapper.ts` is the only file that imports `AgentLoop` – the rest of the server talks via the frame protocol.

## 4. Frame Protocol (JSON)

All frames are newline-delimited JSON objects (`NDJSON`) written/read on the same h2 stream.

| Direction | `type`           | Payload fields                             |
| --------- | ---------------- | ------------------------------------------ |
| C → S     | `user_message`   | `id`, `content`, `imagePaths?`             |
| C → S     | `approve`        | `commandId`, `decision`, `explanation?`    |
| C → S     | `cancel`         | —                                          |
| S → C     | `item`           | `ResponseItem` (encoded)                   |
| S → C     | `command_prompt` | details of shell cmd or patch, `commandId` |
| S → C     | `status`         | arbitrary text                             |
| S → C     | `error`          | `message`, `retryable`                     |
| S ↔ C    | `heartbeat`      | ISO timestamp                              |
| S → C     | `terminate`      | final reason                               |

_Length Prefix_: to avoid needing NDJSON parsing on strict environments, each frame MAY be prefixed with a 32-bit big-endian length. The `transport/http2.ts` codec decides which variant based on `Content-Type`.

## 5. End-to-End Flow

1. **Session start** – client opens stream, sends an initial `user_message` with optional `sessionId`. Server creates or restores an `AgentWrapper`.
2. **Agent run** – wrapper calls `agent.run()`; each emitted `ResponseItem` is serialized and streamed back as an `item` frame.
3. **Tool-call pause** – if `AgentLoop` hits a shell/patch call and `approvalMode !== full-auto`, wrapper emits `command_prompt` and waits. The pending `Promise` is stored in `confirmation-queue.ts` keyed by a `commandId`.
4. **Client decision** – client sends `approve` with `decision` = `allow` / `deny`. The queue resolves, AgentLoop continues. If the decision never arrives before `APPROVAL_TIMEOUT_MS`, the server cancels that generation.
5. **Cancellation** – either side can send `cancel`; the server aborts current generation via `agent.cancel()` and emits `status`+`terminate`.
6. **Session end** – when client is done it half-closes. Server flushes pending events, stores transcript (if configured), and ends stream.

## 6. Key Implementation Details

- **HTTP/2 library** – use `undici`'s `@fastify/http2-server` for server and `@fastify/http2-client` on the Fastify side. They share the same API shape and support plaintext h2c for local dev.
- **Back-pressure** – each `onStreamData` chunk is only pushed when `stream.write()` returns `true` or after its `'drain'` event to avoid unbounded buffering.
- **Plural compute instances** – include an opt-in Redis (or KV) session store so any stateless pod can pick up the next frame for an existing session.
- **Security** – the existing sandbox (Seatbelt, etc.) still applies because we spawn shell commands on the server. In addition, we:
  - Authenticate client with a JWT in the `:authority` header when opening the stream.
  - Limit concurrency per client via a semaphore in `session-manager.ts`.
- **Observability** – stream `status` frames for client-side UX, and emit structured logs to stdout for Loki/Datadog.

## 7. Future Extensions

- **WebSocket transport** – add `transport/websocket.ts`, register with the same codec and expose `/agent/ws`.
- **gRPC** – a `proto/agent.proto` file could mirror `protocol.ts`; then layer on @bufbuild/connect.
- **Delta patches** – evolve `serializer.ts` to support binary delta frames for large diffs.

---

## 8. Minimal Server Bootstrap (outline)

```ts
// src/server/index.ts
import { createServer } from "http2";
import { handleAgentStream } from "./routes/agent";

const server = createServer();
server.on("stream", handleAgentStream);
server.listen(8080, () => console.log("🧩 codex-api running"));
```

## 9. Example Client (Fastify)

```ts
// fastify plugin (rough sketch)
import fp from "fastify-plugin";
import { ClientHttp2Session, connect } from "http2";

export default fp(async (fastify) => {
  let session: ClientHttp2Session;
  fastify.decorate("codex", async (prompt: string) => {
    if (!session) session = connect("http://codex-api:8080");

    const req = session.request({
      ":method": "POST",
      ":path": "/agent/stream",
    });
    req.setEncoding("utf8");
    req.write(JSON.stringify({ type: "user_message", content: prompt }));

    for await (const chunk of req) {
      const frame = JSON.parse(chunk.toString());
      // …handle ResponseItem / command_prompt etc.
    }
  });
});
```

_(Full implementation will live inside the new `codex-api/` package.)_
