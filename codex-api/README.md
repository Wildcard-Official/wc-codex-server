# Codex API (`@openai/codex-api`)

This package provides an HTTP/2 bidirectional streaming server that exposes the capabilities of the interactive Codex CLI (from the `@openai/codex-cli` package) for programmatic use. It is designed to be run within a dedicated environment (e.g., a VM) per user/repository context, serving requests from a trusted backend service.

## Features

- **HTTP/2 Bidirectional Streaming:** Uses raw HTTP/2 streams (no gRPC overhead) for efficient, low-latency communication.
- **Framing Protocol:** Communicates via newline-delimited JSON (NDJSON) frames by default. Also supports length-prefixed JSON framing if specified by the client via `Content-Type` header.
- **Agent Interaction:** Allows a client (your backend service) to:
  - Send user messages/prompts.
  - Receive streamed responses from the Codex agent, including partial text, tool calls, and final outputs (`item` frames).
  - Handle command approval flows (`command_prompt` and `approve` frames).
  - Cancel ongoing agent operations (`cancel` frame).
- **Session Management:** Maintains in-memory session state for the duration of a client's connection for a given `sessionId` (provided by the client).
- **Configuration:** Inherits base agent configuration (e.g., OpenAI API key, default model) from the environment setup for `codex-cli` (via its `loadConfig()` utility). Allows per-request overrides for some parameters.
- **TLS Support:** Optional TLS (h2) via environment variables for key/cert paths. Falls back to unencrypted TCP (h2c) if not configured.

## Architecture Overview

```
+---------------------------------+      HTTP/2 Stream       +---------------------------------+
| Your Backend Service            |  ---------------------> | Codex API Server (this package) |
| (e.g., Fastify app in your VM)  |  <--------------------- | (runs AgentLoop from codex-cli) |
| - Manages user/repo contexts    |      (JSON Frames)      | - HTTP/2 Endpoint: /agent/stream  |
| - Provides `sessionId`          |                         | - Manages AgentLoop lifecycle   |
+---------------------------------+                         +---------------------------------+
```

- The `codex-api` server listens for HTTP/2 connections on `/agent/stream`.
- Your backend service initiates a single, long-lived HTTP/2 stream for each user-repo interaction context.
- Communication occurs via JSON frames defined in `src/types/protocol.ts`.
- The API server wraps the `AgentLoop` from `@openai/codex-cli`, adapting its event-driven nature to the streaming protocol.

## Getting Started

(These instructions assume `codex-api` is part of a PNPM monorepo alongside `codex-cli`.)

1.  **Build `@openai/codex-cli`:**
    Ensure that the `@openai/codex-cli` package is built and its compiled output (including type declarations) is available in its `dist` directory. This is crucial for `codex-api` to resolve type imports.

2.  **Install Dependencies for `codex-api`:**

    ```bash
    pnpm install
    ```

3.  **Configure Environment:**

    - `OPENAI_API_KEY`: Must be available in the environment for the `AgentLoop`.
    - (Optional) `PORT`, `HOST` for the API server.
    - (Optional) `CODEX_API_USE_TLS=true`, `CODEX_API_TLS_KEY_PATH`, `CODEX_API_TLS_CERT_PATH` for TLS.

4.  **Build `codex-api`:**

    ```bash
    pnpm run build
    ```

5.  **Run the Server:**

    ```bash
    pnpm run start
    # or for development with auto-restarting:
    pnpm run dev
    ```

6.  **Use the Demo Client (for testing):**
    In a separate terminal:
    ```bash
    node ./dist/cli/demo-client.js [your-session-id] ["Your initial prompt here"]
    # Example:
    node ./dist/cli/demo-client.js my-test-session "Write a python script to list files in a directory"
    ```

## Frame Protocol

See `docs/streaming-agent-module.md` and `src/types/protocol.ts` for details on the frame types exchanged between the client and server.

## Key Files

- `src/server/index.ts`: HTTP/2 server setup and bootstrap.
- `src/server/routes/agent.ts`: Main handler for the `/agent/stream` endpoint.
- `src/core/agent-wrapper.ts`: Bridges the `AgentLoop` with the streaming protocol.
- `src/core/session-manager.ts`: Manages active sessions (in-memory).
- `src/core/confirmation-queue.ts`: Handles promises for command approvals.
- `src/server/transport/http2.ts`: Logic for reading/writing HTTP/2 frames (NDJSON, length-prefixed).
- `src/types/protocol.ts`: Zod schemas and TypeScript types for all communication frames.
- `src/cli/demo-client.ts`: A command-line client for testing and demonstrating API usage.

## Important Integration Points & Current Limitations

- **`AgentLoop` Instantiation (`src/server/routes/agent.ts`):**
  The `AgentLoopParams` required by the `AgentLoop` constructor from `@openai/codex-cli` needs to be accurately populated. This includes how `AgentLoop` gets its working directory context (i.e., the path to the user's Git repository cloned in the VM). This context is essential for `AgentLoop` to perform file operations and is currently a placeholder in `agent.ts`.

- **Type Resolution for `@openai/codex-cli`:**
  The `codex-api` package relies on types (`AppConfig`, `AgentLoop`, `AgentLoopParams`, `CommandConfirmation`, etc.) being correctly exported and resolvable from the `@openai/codex-cli` package. You may need to:

  1.  Ensure `@openai/codex-cli` is built and emits valid type declaration files (`.d.ts`).
  2.  Adjust `paths` in `codex-api/tsconfig.json` or use PNPM workspace features to correctly link these packages for development and type resolution.
  3.  Modify `@openai/codex-cli` to export all necessary types (e.g., `AgentLoopParams`, `CommandConfirmation`).

- **Error Handling:** Basic error handling is in place, but may need to be enhanced for production scenarios, especially around `AgentLoop` failures.

- **Security:** The API server itself has minimal authentication as it's designed to be called by a trusted backend within a secured environment. The primary security relies on the sandboxing capabilities of `AgentLoop` itself when executing commands.
