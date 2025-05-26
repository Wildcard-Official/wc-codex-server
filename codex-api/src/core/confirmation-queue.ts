import type { ApproveFrameSchema } from "../types/protocol"; // For Decision type
import { z } from "zod";

export type Decision = z.infer<typeof ApproveFrameSchema>["decision"];
export type ConfirmationResult = { decision: Decision; explanation?: string };

const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface PendingConfirmation {
  resolve: (value: ConfirmationResult) => void;
  reject: (reason?: any) => void;
  timer: NodeJS.Timeout;
}

export class ConfirmationQueue {
  private pending: Map<string, PendingConfirmation> = new Map();
  private readonly approvalTimeoutMs: number;

  constructor(approvalTimeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS) {
    this.approvalTimeoutMs = approvalTimeoutMs;
  }

  /**
   * Registers a command that requires confirmation and returns a Promise that will be
   * resolved or rejected when the client sends an approval/denial, or if it times out.
   * @param commandId A unique identifier for the command awaiting confirmation.
   * @returns A Promise that resolves with the client's decision or rejects on timeout/error.
   */
  register(commandId: string): Promise<ConfirmationResult> {
    if (this.pending.has(commandId)) {
      // This shouldn't happen if commandIds are unique per active command
      console.warn(
        `[codex-api:ConfirmationQueue] Command ID ${commandId} already pending. Overwriting.`,
      );
      const existing = this.pending.get(commandId)!;
      clearTimeout(existing.timer);
    }

    return new Promise<ConfirmationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(commandId)) {
          // Check if not already resolved/rejected
          this.pending.delete(commandId);
          console.log(
            `[codex-api:ConfirmationQueue] Command ${commandId} timed out after ${this.approvalTimeoutMs}ms.`,
          );
          reject(new Error(`Confirmation for command ${commandId} timed out.`));
        }
      }, this.approvalTimeoutMs);

      this.pending.set(commandId, { resolve, reject, timer });
      console.log(
        `[codex-api:ConfirmationQueue] Command ${commandId} registered, awaiting confirmation.`,
      );
    });
  }

  /**
   * Resolves a pending confirmation with the client's decision.
   * @param commandId The ID of the command that was approved or denied.
   * @param decision The client's decision ('allow' or 'deny').
   * @param explanation Optional explanation, especially for 'deny' decisions.
   * @returns True if the command was found and resolved, false otherwise.
   */
  resolve(
    commandId: string,
    decision: Decision,
    explanation?: string,
  ): boolean {
    const pendingConfirmation = this.pending.get(commandId);
    if (pendingConfirmation) {
      clearTimeout(pendingConfirmation.timer);
      pendingConfirmation.resolve({ decision, explanation });
      this.pending.delete(commandId);
      console.log(
        `[codex-api:ConfirmationQueue] Confirmation received for command ${commandId}: ${decision}`,
      );
      return true;
    }
    console.warn(
      `[codex-api:ConfirmationQueue] No pending confirmation found for command ID ${commandId}. Decision: ${decision}`,
    );
    return false;
  }

  /**
   * Rejects a specific pending command, e.g. if the agent itself decides to cancel it.
   * @param commandId The command ID to reject.
   * @param reason The reason for rejection.
   */
  reject(commandId: string, reason?: any): boolean {
    const pendingConfirmation = this.pending.get(commandId);
    if (pendingConfirmation) {
      clearTimeout(pendingConfirmation.timer);
      pendingConfirmation.reject(reason);
      this.pending.delete(commandId);
      console.log(
        `[codex-api:ConfirmationQueue] Pending command ${commandId} rejected. Reason: ${reason}`,
      );
      return true;
    }
    return false;
  }

  /**
   * Clears all pending confirmations. Useful for session cleanup.
   */
  clearAllForSession(prefixOrMatcher: string | RegExp): void {
    let clearedCount = 0;
    for (const commandId of this.pending.keys()) {
      const match =
        typeof prefixOrMatcher === "string"
          ? commandId.startsWith(prefixOrMatcher)
          : prefixOrMatcher.test(commandId);

      if (match) {
        const pendingConfirmation = this.pending.get(commandId)!;
        clearTimeout(pendingConfirmation.timer);
        pendingConfirmation.reject(
          new Error(
            `Session ended while awaiting confirmation for ${commandId}.`,
          ),
        );
        this.pending.delete(commandId);
        clearedCount++;
      }
    }
    if (clearedCount > 0) {
      console.log(
        `[codex-api:ConfirmationQueue] Cleared ${clearedCount} pending confirmations.`,
      );
    }
  }
}
