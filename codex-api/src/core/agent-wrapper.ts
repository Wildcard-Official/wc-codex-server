import type {
  ResponseItem,
  ResponseInputItem,
  // ResponseFunctionToolCall, // If needed for deeper inspection
} from "@openai/codex-cli/typings"; // Adjust path if necessary
import type {
  AgentLoop,
  CommandConfirmation,
} from "@openai/codex-cli/utils/agent/agent-loop"; // Adjust path
import type { AppConfig, LoadedConfig } from "@openai/codex-cli/utils/config"; // Adjust path
import type {
  ApplyPatchCommand,
  ApprovalPolicy,
} from "@openai/codex-cli/approvals"; // Adjust path

import type {
  ItemFrame,
  CommandPromptFrame,
  UserMessageFrame,
  ApproveFrame,
  CancelFrame,
  ServerFrame,
  StatusFrame,
  ErrorFrame,
} from "../types/protocol";
import {
  responseItemToItemFrame,
  commandPromptToFrame,
  userMessageFrameToResponseInputItems,
  extractMetadataFromUserMessage,
  AgentRunMetadata,
} from "../utils/serializer";
import { ConfirmationQueue, ConfirmationResult } from "./confirmation-queue";
import { Session } from "./session-manager";
import { randomUUID } from "crypto";

// Dynamically import AgentLoop constructor
let AgentLoopInternal: typeof AgentLoop;

interface AgentWrapperOptions {
  session: Session;
  confirmationQueue: ConfirmationQueue;
  onFrame: (frame: ServerFrame) => void; // Callback to send a frame to the client
  // Default AppConfig to be used if not overridden by client or session
  defaultAppConfig: LoadedConfig;
}

export class AgentWrapper {
  private agentLoop: AgentLoop;
  private session: Session;
  private confirmationQueue: ConfirmationQueue;
  private onFrame: (frame: ServerFrame) => void;
  private currentRunAbortController: AbortController | null = null;
  private defaultAppConfig: LoadedConfig;
  private lastResponseId: string | undefined = undefined; // Track last response ID for conversational context

  constructor(options: AgentWrapperOptions) {
    this.session = options.session;
    this.confirmationQueue = options.confirmationQueue;
    this.onFrame = options.onFrame;
    this.agentLoop = options.session.agentLoop; // AgentLoop is now passed via Session
    this.defaultAppConfig = options.defaultAppConfig;
  }

  private getEffectiveConfig(
    userOverrides?: UserMessageFrame["configOverrides"],
  ): AppConfig {
    // Start with a deep copy of the session's initial AppConfig or the global default
    const baseConfig = JSON.parse(
      JSON.stringify(this.session.appConfig || this.defaultAppConfig.config),
    );

    if (userOverrides) {
      if (userOverrides.model) baseConfig.model = userOverrides.model;
      // Add other AppConfig fields here that AgentLoop uses and can be overridden
      // e.g., baseConfig.approvalPolicy = userOverrides.approvalPolicy if that's an AppConfig field
    }
    // Ensure API key is present if needed, or other essential fields
    if (!baseConfig.apiKey && this.defaultAppConfig.config.apiKey) {
      baseConfig.apiKey = this.defaultAppConfig.config.apiKey;
    }
    return baseConfig as AppConfig;
  }

  private async getCommandConfirmation(
    command: string[],
    applyPatch: ApplyPatchCommand | undefined,
    commandId: string, // Generated internally for this prompt
  ): Promise<CommandConfirmation> {
    const promptFrame = commandPromptToFrame(commandId, command, applyPatch);
    this.onFrame(promptFrame);

    try {
      const result: ConfirmationResult =
        await this.confirmationQueue.register(commandId);
      return {
        review: result.decision === "allow" ? "approved" : "denied",
        applyPatch: result.decision === "allow" ? applyPatch : undefined, // Only pass patch if allowed
        customDenyMessage: result.explanation, // Sent back to agent if denied with explanation
      } as CommandConfirmation; // Cast needed due to review type difference potentially
    } catch (error: any) {
      console.warn(
        `[codex-api:AgentWrapper] Confirmation for ${commandId} failed or timed out:`,
        error.message,
      );
      this.onFrame({
        type: "error",
        message: `Approval timed out or failed for command ${commandId}`,
        code: "APPROVAL_TIMEOUT",
      } as ErrorFrame);
      // Deny by default on timeout/error
      return {
        review: "denied",
        customDenyMessage: `Approval timed out or was cancelled: ${error.message}`,
      } as CommandConfirmation;
    }
  }

  public async handleUserMessage(frame: UserMessageFrame): Promise<void> {
    if (!AgentLoopInternal) {
      try {
        // ESM dynamic import
        const module = await import(
          "@openai/codex-cli/utils/agent/agent-loop.js"
        );
        AgentLoopInternal = module.AgentLoop;
      } catch (e) {
        console.error(
          "[codex-api:AgentWrapper] Failed to dynamically import AgentLoop:",
          e,
        );
        this.onFrame({
          type: "error",
          message: "Internal server error: Agent engine unavailable",
        } as ErrorFrame);
        return;
      }
    }

    if (this.currentRunAbortController) {
      console.warn(
        "[codex-api:AgentWrapper] A run is already in progress. Cancelling previous run.",
      );
      this.cancelCurrentRun("new_message_interrupt");
    }
    this.currentRunAbortController = new AbortController();
    const { signal: abortSignal } = this.currentRunAbortController;

    const metadata = extractMetadataFromUserMessage(frame);
    const effectiveConfig = this.getEffectiveConfig(metadata.configOverrides);
    const approvalPolicyFromFrame =
      frame.configOverrides?.approvalPolicy ||
      this.session.appConfig.approvalMode ||
      this.defaultAppConfig.config.approvalMode ||
      "suggest";

    // (Re)create or ensure AgentLoop instance is configured for this run
    // This logic might need to be more sophisticated if AgentLoop instances are not reusable across different configs.
    // For now, we assume the one in the session is either fresh or adaptable.
    // Or, create a new one if config significantly changes:
    // this.agentLoop = new AgentLoopInternal({...});

    const inputItems = userMessageFrameToResponseInputItems(frame);

    this.onFrame({
      type: "status",
      message: "Agent processing... ",
    } as StatusFrame);

    try {
      await this.agentLoop.run(
        inputItems,
        this.lastResponseId, // Pass previous response ID for conversation context
        {
          // Pass AgentLoop run-specific options from effectiveConfig or defaults
          model: effectiveConfig.model || this.defaultAppConfig.config.model,
          provider:
            effectiveConfig.provider ||
            this.defaultAppConfig.config.provider ||
            "openai",
          instructions:
            effectiveConfig.instructions ||
            this.defaultAppConfig.config.instructions,
          approvalPolicy: approvalPolicyFromFrame as ApprovalPolicy,
          disableResponseStorage:
            effectiveConfig.disableResponseStorage === undefined
              ? true
              : effectiveConfig.disableResponseStorage, // Example: default to true if not specified
          config: effectiveConfig, // Pass the whole effective config
          additionalWritableRoots:
            effectiveConfig.additionalWritableRoots || [],

          onItem: (item: ResponseItem) => {
            if (abortSignal.aborted) return;
            const itemFrame = responseItemToItemFrame(item, this.session.id);
            this.onFrame(itemFrame);
          },
          onLoading: (loading: boolean) => {
            if (abortSignal.aborted) return;
            this.onFrame({
              type: "status",
              message: loading ? "Agent thinking..." : "Agent idle...",
            } as StatusFrame);
          },
          getCommandConfirmation: (
            command: string[],
            applyPatch: ApplyPatchCommand | undefined,
          ) => {
            if (abortSignal.aborted)
              return Promise.reject(new Error("Run cancelled"));
            const commandId = `${this.session.id}-cmd-${randomUUID()}`;
            return this.getCommandConfirmation(command, applyPatch, commandId);
          },
          onLastResponseId: (id: string) => {
            if (abortSignal.aborted) return;
            this.lastResponseId = id; // Capture for next turn
          },
          signal: abortSignal, // Pass abort signal to AgentLoop
        },
      );
      if (abortSignal.aborted) {
        this.onFrame({
          type: "status",
          message: "Agent run cancelled by client.",
        } as StatusFrame);
      } else {
        this.onFrame({
          type: "status",
          message: "Agent run completed.",
        } as StatusFrame);
      }
    } catch (error: any) {
      if (abortSignal.aborted && error.name === "AbortError") {
        this.onFrame({
          type: "status",
          message: "Agent run successfully aborted.",
        } as StatusFrame);
      } else {
        console.error(
          "[codex-api:AgentWrapper] Error during agent run:",
          error,
        );
        this.onFrame({
          type: "error",
          message: `Agent run failed: ${error.message}`,
          code: "AGENT_ERROR",
        } as ErrorFrame);
      }
    } finally {
      if (this.currentRunAbortController?.signal === abortSignal) {
        // only clear if it's the same controller
        this.currentRunAbortController = null;
      }
    }
  }

  public handleApprove(frame: ApproveFrame): void {
    this.confirmationQueue.resolve(
      frame.commandId,
      frame.decision,
      frame.explanation,
    );
  }

  public handleCancel(frame: CancelFrame): void {
    this.cancelCurrentRun(`client_cancel_frame_session_${frame.sessionId}`);
    this.confirmationQueue.reject(
      `${frame.sessionId}-cmd-${randomUUID()}`,
      new Error("Client requested cancel for session"),
    ); // reject any pending specific command too if needed
  }

  public cancelCurrentRun(reason: string = "unknown_cancellation"): void {
    if (this.currentRunAbortController) {
      console.log(
        `[codex-api:AgentWrapper] Cancelling current agent run. Reason: ${reason}`,
      );
      this.currentRunAbortController.abort();
      this.currentRunAbortController = null;
      this.onFrame({
        type: "status",
        message: `Agent run cancelled: ${reason}`,
      } as StatusFrame);
    }
  }

  public cleanup(): void {
    this.cancelCurrentRun("session_cleanup");
    this.confirmationQueue.clearAllForSession(this.session.id); // Clear any pending confirmations for this session
    console.log(
      `[codex-api:AgentWrapper] Cleaned up wrapper for session ${this.session.id}`,
    );
  }
}
