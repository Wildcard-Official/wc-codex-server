import type {
  Http2ServerRequest,
  Http2ServerResponse,
  ServerHttp2Stream,
} from "http2";
import { constants as http2constants } from "http2";
import { SessionManager } from "../../core/session-manager";
import { ConfirmationQueue } from "../../core/confirmation-queue";
import { AgentWrapper } from "../../core/agent-wrapper";
import { readFrames, writeFrame, startHeartbeat } from "../transport/http2";
import type {
  ClientFrame,
  ServerFrame,
  UserMessageFrame,
} from "../../types/protocol";
import { loadConfig, type AppConfig } from "@openai/codex-cli/utils/config"; // Use AppConfig directly
import {
  AgentLoop,
  type AgentLoopParams,
} from "@openai/codex-cli/utils/agent/agent-loop"; // For creating instance and params type
import { randomUUID } from "crypto";
import chalk from "chalk";
import { ReviewDecision } from "@openai/codex-cli/utils/agent/review.js";

// Initialize shared services
const sessionManager = new SessionManager();
const confirmationQueue = new ConfirmationQueue();

// AppConfig will hold the loaded configuration (e.g. API keys, default model, etc.)
// It serves a similar purpose to what I previously called LoadedConfig.
let globalDefaultAppConfig: AppConfig;

async function initializeConfig() {
  try {
    // loadConfig likely returns the core AppConfig directly or an object containing it.
    // Assuming loadConfig() returns AppConfig directly based on typical utility patterns.
    // If it returns { config: AppConfig, ... }, adjust accordingly.
    const loaded = await loadConfig(); // This should provide AppConfig
    if (
      loaded &&
      typeof loaded === "object" &&
      ("apiKey" in loaded || "model" in loaded)
    ) {
      // Basic check for AppConfig shape
      globalDefaultAppConfig = loaded as AppConfig;
    } else if (
      loaded &&
      (loaded as any).config &&
      typeof (loaded as any).config === "object"
    ) {
      // Handles if it's a LoadedConfig like {config: AppConfig, ...}
      globalDefaultAppConfig = (loaded as any).config as AppConfig;
    } else {
      throw new Error("Invalid config structure loaded");
    }

    console.log(
      chalk.blue(
        "[codex-api:agentHandler] Global default AppConfig loaded successfully.",
      ),
    );
    if (!globalDefaultAppConfig.apiKey && !process.env.OPENAI_API_KEY) {
      console.warn(
        chalk.yellow(
          "[codex-api:agentHandler] OPENAI_API_KEY is not set in env or config. AgentLoop may fail.",
        ),
      );
    }
  } catch (error) {
    console.error(
      chalk.red(
        "[codex-api:agentHandler] CRITICAL: Failed to load global default AppConfig. Agent will not function.",
      ),
      error,
    );
    globalDefaultAppConfig = {
      apiKey: process.env.OPENAI_API_KEY,
    } as AppConfig; // Minimal fallback
  }
}

// Call initializeConfig at the module level. Execution will pause here until it completes.
await initializeConfig();

const {
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_CONTENT_TYPE,
  HTTP2_HEADER_STATUS,
} = http2constants;

export async function handleAgentStream(
  stream: ServerHttp2Stream,
  headers: Record<string, string | string[] | undefined>,
  flags: number,
) {
  const path = headers[HTTP2_HEADER_PATH] as string;
  const method = headers[HTTP2_HEADER_METHOD] as string;

  if (path !== "/agent/stream" || method !== "POST") {
    stream.respond({ [HTTP2_HEADER_STATUS]: 404 });
    stream.end("Not Found");
    return;
  }

  // Authentication is now handled by the infrastructure (e.g., VM access, network rules)
  // The "client" is the trusted backend service.
  console.log(
    chalk.dim(
      "[codex-api:agentHandler] Incoming stream request from backend service.",
    ),
  );

  const requestContentType = headers[HTTP2_HEADER_CONTENT_TYPE] as string;
  const responseContentType =
    requestContentType === "application/length-prefixed-json"
      ? "application/length-prefixed-json"
      : "application/x-ndjson";

  stream.respond({
    [HTTP2_HEADER_STATUS]: 200,
    [HTTP2_HEADER_CONTENT_TYPE]: responseContentType,
  });

  let agentWrapper: AgentWrapper | null = null;
  const heartbeatInterval = startHeartbeat(
    stream,
    stream.session as unknown as Http2ServerResponse,
    30000,
  );
  let currentSessionId: string | null = null; // The backend service can dictate this ID

  stream.on("close", () => {
    clearInterval(heartbeatInterval);
    if (agentWrapper) {
      agentWrapper.cleanup();
    }
    if (currentSessionId) {
      sessionManager
        .destroy(currentSessionId)
        .catch((err) =>
          console.error(
            chalk.red(
              `[codex-api:agentHandler] Error destroying session ${currentSessionId} on close:`,
            ),
            err,
          ),
        );
      console.log(
        chalk.blue(
          `[codex-api:agentHandler] Stream closed for session: ${currentSessionId}`,
        ),
      );
    } else {
      console.log(
        chalk.blue(
          "[codex-api:agentHandler] Stream closed (no session established or ID known).",
        ),
      );
    }
  });

  stream.on("error", (err) => {
    console.error(chalk.red("[codex-api:agentHandler] Stream error:"), err);
  });

  try {
    for await (const clientFrame of readFrames(
      stream,
      stream.session as unknown as Http2ServerRequest,
    )) {
      if (stream.destroyed || stream.closed) break;

      try {
        if (clientFrame.type === "user_message") {
          const userMessage = clientFrame as UserMessageFrame;
          // Backend service provides the session ID for the user-repo context.
          // If not provided in the first message, we could generate one, but it's better if backend controls this.
          if (!userMessage.sessionId) {
            const errMsg =
              "Session ID must be provided by the backend service in the first user_message frame.";
            console.error(chalk.red(`[codex-api:agentHandler] ${errMsg}`));
            writeFrame(
              stream,
              { type: "error", message: errMsg, code: "SESSION_ID_REQUIRED" },
              stream.session as unknown as Http2ServerResponse,
            );
            stream.end(); // Terminate if critical info is missing
            return;
          }
          currentSessionId = userMessage.sessionId;

          if (!agentWrapper) {
            console.log(
              chalk.green(
                `[codex-api:agentHandler] Initializing session: ${currentSessionId}`,
              ),
            );
            // Construct AgentLoopParams based on global config and potential overrides from the client
            // This is a simplified construction. Actual AgentLoopParams structure from codex-cli is key.
            const agentLoopParams: AgentLoopParams = {
              model:
                userMessage.configOverrides?.model ||
                globalDefaultAppConfig.model ||
                "gpt-4o", // Example model
              provider: globalDefaultAppConfig.provider || "openai",
              instructions: globalDefaultAppConfig.instructions,
              approvalPolicy:
                userMessage.configOverrides?.approvalPolicy ||
                globalDefaultAppConfig.approvalMode ||
                "suggest",
              disableResponseStorage:
                globalDefaultAppConfig.disableResponseStorage === undefined
                  ? true
                  : globalDefaultAppConfig.disableResponseStorage,
              config: {
                ...globalDefaultAppConfig,
                ...(userMessage.configOverrides || {}),
              }, // Merge configs
              additionalWritableRoots: [], // Default to empty array since this is a server context
              // These callbacks will be set by AgentWrapper itself when it instantiates AgentLoop
              onItem: () => {},
              onLoading: () => {},
              getCommandConfirmation: async () => ({
                review: ReviewDecision.NO_CONTINUE,
              }),
              onLastResponseId: () => {},
            };

            let tempAgentLoop: AgentLoop;
            try {
              tempAgentLoop = new AgentLoop(agentLoopParams);
            } catch (e: any) {
              console.error(
                chalk.red(
                  "[codex-api:agentHandler] Failed to instantiate AgentLoop:",
                ),
                e,
              );
              writeFrame(
                stream,
                {
                  type: "error",
                  message: `Failed to create agent instance: ${e.message}`,
                  code: "AGENT_INIT_FAILED",
                },
                stream.session as unknown as Http2ServerResponse,
              );
              stream.end();
              return;
            }

            const session = await sessionManager.createOrGet(
              tempAgentLoop,
              globalDefaultAppConfig, // Pass the base AppConfig for the session
              currentSessionId,
            );
            agentWrapper = new AgentWrapper({
              session,
              confirmationQueue,
              onFrame: (serverFrame: ServerFrame) =>
                writeFrame(
                  stream,
                  serverFrame,
                  stream.session as unknown as Http2ServerResponse,
                ),
              defaultAppConfig: {
                config: globalDefaultAppConfig,
                GITOID_VERSION: "unknown",
                source: "loaded",
              }, // Reconstruct LoadedConfig structure if AgentWrapper expects it
            });
            writeFrame(
              stream,
              {
                type: "status",
                message: `Session ${currentSessionId} initialized.`,
              },
              stream.session as unknown as Http2ServerResponse,
            );
          }
          await agentWrapper.handleUserMessage(userMessage);
        } else if (agentWrapper && clientFrame.type === "approve") {
          if (clientFrame.sessionId !== currentSessionId) {
            writeFrame(
              stream,
              {
                type: "error",
                message: "Session ID mismatch in approve frame.",
                code: "SESSION_ID_MISMATCH",
              },
              stream.session as unknown as Http2ServerResponse,
            );
            continue;
          }
          agentWrapper.handleApprove(clientFrame);
        } else if (agentWrapper && clientFrame.type === "cancel") {
          if (clientFrame.sessionId !== currentSessionId) {
            writeFrame(
              stream,
              {
                type: "error",
                message: "Session ID mismatch in cancel frame.",
                code: "SESSION_ID_MISMATCH",
              },
              stream.session as unknown as Http2ServerResponse,
            );
            continue;
          }
          agentWrapper.handleCancel(clientFrame);
        } else if (!agentWrapper && clientFrame.type !== "user_message") {
          writeFrame(
            stream,
            {
              type: "error",
              message:
                "Session not initialized. Send user_message first with sessionId.",
              code: "SESSION_NOT_INIT",
            },
            stream.session as unknown as Http2ServerResponse,
          );
        }
      } catch (innerError: any) {
        console.error(
          chalk.red("[codex-api:agentHandler] Error processing client frame:"),
          innerError,
          "Frame type:",
          clientFrame?.type,
        );
        if (!stream.destroyed && !stream.closed) {
          writeFrame(
            stream,
            {
              type: "error",
              message: `Error processing frame ${clientFrame?.type || "unknown"}: ${innerError.message}`,
              code: "FRAME_PROCESSING_ERROR",
            },
            stream.session as unknown as Http2ServerResponse,
          );
        }
      }
    }
  } catch (error: any) {
    console.error(
      chalk.red(
        "[codex-api:agentHandler] Unhandled error in stream processing loop:",
      ),
      error,
    );
    if (!stream.destroyed && !stream.closed) {
      try {
        writeFrame(
          stream,
          {
            type: "error",
            message: `Fatal stream error: ${error.message}`,
            code: "FATAL_STREAM_ERROR",
          },
          stream.session as unknown as Http2ServerResponse,
        );
      } finally {
        stream.end(); // Ensure stream is closed on fatal error
      }
    }
  } finally {
    if (!stream.destroyed && !stream.closed) {
      // Avoid sending terminate if it was already closed by an error handler above
      writeFrame(
        stream,
        { type: "terminate", reason: "Stream ended from server side." },
        stream.session as unknown as Http2ServerResponse,
      );
      stream.end();
    }
    console.log(
      chalk.blue(
        `[codex-api:agentHandler] Finished handling stream for session: ${currentSessionId || "unknown"}`,
      ),
    );
  }
}
