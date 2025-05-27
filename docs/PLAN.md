“turn the Codex CLI experience into an on-demand, per-repo API service”.

────────────────────────────────────────────────────────

1. High-level architecture
   ────────────────────────────────────────────────────────
1. Your control plane (a small Go/TS/Python service) receives a
   “natural-language job” → `{ repo_url, prompt, openai_key }`.
1. It spins up an **ephemeral worker VM / container** (Firecracker,
   gVisor-hardened Docker, AWS CodeBuild, etc.).
1. The worker:
   a. `git clone` → `/workspace`.
   b. Sets `OPENAI_API_KEY=<userKey>` in the env.
   c. Launches **Codex in headless mode** with the user's prompt.
   d. Streams Codex events back to the control plane over stdout (or pipes).
1. Control plane multiplexes that stream to your Web-socket/SSE endpoint.
1. When the Codex process exits, you snapshot artefacts (commit/push,
   test reports, etc.) and tear the worker down.

Nothing in that flow requires you to host a multi-tenant Codex server or
introduce your own auth layer; the isolation boundary is the VM/container.

──────────────────────────────────────────────────────── 2. Picking the "headless Codex" flavour
────────────────────────────────────────────────────────
You have two ready-made options inside this repo.

A. TypeScript CLI (today's production path)
• Invoke: `codex -q --json -a full-auto "<prompt>"`
• Behaviour: non-interactive, streams JSON lines to stdout.
• Pros: matches 100 % of the interactive CLI feature set right now.
• Cons: needs Node 22 inside the worker; startup time a few 100 ms.

B. Rust "exec" crate (`codex-rs/exec`)
• Invoke: `codex-exec "<prompt>" --approval-policy never …`
• Behaviour: purposely headless; prints structured JSON to stdout.
• Pros: one self-contained static binary, starts instantly, easier to
cross-compile for minimal images.
• Cons: still catching up with the TS feature set (check README for gaps).

Most MVPs start with option A (minimum code change) and switch to B when they
care about cold-start latency or shipping a slimmer container.

──────────────────────────────────────────────────────── 3. What the JSON stream looks like
────────────────────────────────────────────────────────
The TS CLI's quiet-mode writer lives in `src/cli.tsx → runQuietMode()`.

Each line is a single JSON object, e.g.:

```json
{"type":"assistant_message","content":"Let's rename foo → bar…"}
{"type":"patch","files":[{"path":"src/foo.js","diff":"@@…"}]}
{"type":"command","cmd":"npm test","sandboxed":true}
{"type":"command_output","stream":"stdout","data":"…"}
{"type":"finished","exit_code":0}
```

That format is intentionally stable: the Rust exec crate emits the _same_
schema so your control plane only needs one parser.

──────────────────────────────────────────────────────── 4. Container recipe (example with Docker + TS CLI)
────────────────────────────────────────────────────────
Dockerfile:

```dockerfile
FROM node:22-bullseye-slim

# 1. Install codex CLI once
RUN corepack enable && \
    npm install -g @openai/codex

# 2. Create a non-root user for the sandbox
RUN useradd -ms /bin/bash worker
USER worker
WORKDIR /home/worker

# entrypoint expects: repo URL, prompt, OPENAI_API_KEY
ENTRYPOINT ["/usr/local/bin/bash", "-c", "\
  git clone --depth 1 $1 repo && \
  cd repo && \
  codex -q --json -a full-auto \"$2\" \
"]
```

Your control plane builds / runs that with:

```
docker run --rm \
  -e OPENAI_API_KEY=sk-… \
  codex-worker "<repo_url>" "<prompt>"
```

and attaches STDOUT to your WebSocket publisher.

If you prefer Rust:

```dockerfile
FROM debian:bookworm-slim
COPY codex-exec /usr/local/bin/codex-exec   # static binary
ENTRYPOINT ["codex-exec"]
```

──────────────────────────────────────────────────────── 5. Streaming from worker → frontend
────────────────────────────────────────────────────────
• The worker writes JSONL to stdout.
• Control plane reads each line, tags it with a job-id, and pushes it to:
– WebSocket room, or
– SSE `/api/jobs/:id/stream`, or
– Redis Stream / NATS subject — whatever you already run.

Because Codex emits incremental patches _and_ command output, your UI can
live-update diffs, progress bars, unit-test output, etc., almost identical to
the local CLI experience.

──────────────────────────────────────────────────────── 6. Handling approvals
────────────────────────────────────────────────────────
For an MVP you likely want zero human blocking:

• Pass `-a full-auto` (TS) / `--approval-policy never` (Rust exec).
• The sandbox still prevents network and outside-CWD writes so damage is
limited.
• Later you can switch to `auto-edit` and surface "command about to run" events
to the frontend for manual approve/deny.

──────────────────────────────────────────────────────── 7. GitHub write-back (after MVP)
────────────────────────────────────────────────────────

1. At end of the job, worker commits changes:
   `git commit -am "[codex] $prompt"`
2. Push with a temporary deploy key or GitHub App token supplied by _your_
   backend (not by the user).
3. Optionally open a PR via the GitHub API.

──────────────────────────────────────────────────────── 8. Next steps in this codebase
────────────────────────────────────────────────────────
If you stick with the TypeScript CLI:
• Copy `src/cli.tsx::runQuietMode()` into a tiny wrapper file so you can
`import { runQuietMode } from "@openai/codex/dist/cli-dev.js"` and call it
directly from an Express/Fastify handler instead of spawning a sub-process
(handy for unit tests).

If you adopt Rust:
• Start in `codex-rs/exec/src/lib.rs → run_main()` — it already exposes a
`run_main(cli_args).await` you can call from your own tokio web handler.

Either way: no fork-specific patches are required until you want exotic
behaviour (e.g. extra JSON event types). Maintain a thin overlay rather than a
deep fork so you can fast-forward to upstream releases easily.

────────────────────────────────────────────────────────
TL;DR
────────────────────────────────────────────────────────

1. Use CLI quiet-mode (`codex -q --json …`) or the Rust `codex-exec` binary.
2. Run it inside a short-lived, repo-cloned container / VM.
3. Stream stdout lines to your backend → frontend.
4. Start with `full-auto` approval; rely on the sandbox.
5. Commit/push results when the process exits.

This yields a streaming API that feels 95 % like the local Codex experience,
with very little bespoke code. Let me know when you're ready to dive into any
of those implementation slices!

────────────────────────────────────────────────────────
2024-05-27 — Revised Plan (Codex Agent as per-repo micro-service)
────────────────────────────────────────────────────────

1. High-level flow
   • Control plane receives a job `{repo_url, prompt, openai_key, callback_url}`.
   • It spins up an _ephemeral_ container from the `codex-agent` image, one per (repo × job).
   • The container:

   a. Clones the target repo into `/workspace`.
   b. Bootstraps an Express server that immediately invokes `runQuietMode()` from `@openai/codex` **in-process**.
   – This yields a stream of JSON events identical to the CLI, without having to spawn a child process.
   c. Forwards each event to:
   • an internal Server-Sent Events (SSE) endpoint `/stream` (used by the control-plane), **and**
   • an HTTP `POST` to the provided `callback_url` in the control plane (used to persist into Postgres from the control plane).
   d. After the `finished` event the container can optionally commit / push back to GitHub (MVP skips auth).
   e. The process exits which lets the orchestration layer tear the container down.

2. Container image (`codex-agent`)
   • Base: `node:22-slim`
   • Global deps: `corepack enable && pnpm add -g @openai/codex`
   • App deps (local): `express`, `eventsource-parser`, `simple-git`, etc.
   • `ENTRYPOINT ["node","/app/index.js"]`
   • Exposes port 8080.

   Environment variables:
   – `GIT_REPO_URL` (required)
   – `INITIAL_PROMPT` (required)
   – `OPENAI_API_KEY` (required)
   – `CALLBACK_URL` (optional – falls back to SSE only)
   – `JOB_ID` (optional, echoed in every event)

3. Express API inside the container
   • `GET /health` → `200 OK` for readiness / liveness probes.
   • `GET /stream` → SSE stream of Codex JSON events (Content-Type `text/event-stream`).
   • (No multi-user endpoints; one job == one container.)

4. Control-plane responsibilities
   • Build/pull the `codex-agent` image and run:
   `docker run --rm -p 0.0.0.0:0 \`
   `-e OPENAI_API_KEY=… -e GIT_REPO_URL=… -e PROMPT=… -e CALLBACK_URL=… codex-agent`
   • Subscribe to `/stream` for real-time updates; persist events to Postgres under `job_id`.
   • Terminate the container on job cancellation or after `finished`.

5. Future-proofing
   • Swap the `@openai/codex` CLI for the Rust `codex-exec` binary when you care about cold-start latency.
   • Add GitHub deploy-key auth + `git push` step after MVP.
   • Introduce an approval gateway by switching to `auto-edit` and exposing the approval events via the same SSE channel.

────────────────────────────────────────────────────────
Why diverge from the original plan?
────────────────────────────────────────────────────────
Sticking the Express layer _inside_ the worker simplifies networking (one port) and
removes the need for the control plane to parse Docker logs. It also opens the
door to additional runtime controls (cancel, pause, approve) without changing
the container contract.
