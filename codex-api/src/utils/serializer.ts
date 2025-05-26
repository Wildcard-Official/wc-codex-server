// This file will bridge ResponseItem and other complex types from @openai/codex-cli
// to the serializable frame types defined in ../types/protocol.ts

import type {
  ResponseItem,
  ResponseInputItem,
} from "@openai/codex-cli/typings"; // Adjust path as needed
import type { ApplyPatchCommand } from "@openai/codex-cli/approvals"; // Adjust path as needed

import type {
  ClientFrame,
  ItemFrame,
  CommandPromptFrame,
  UserMessageFrame,
  ApproveFrame,
} from "../types/protocol";

export function responseItemToItemFrame(
  responseItem: ResponseItem,
  sessionId?: string,
): ItemFrame {
  // WARNING: This is a placeholder. The actual ResponseItem structure needs to be known
  // and then mapped to a serializable format if it contains non-serializable parts (e.g., functions, complex objects).
  // For now, we assume responseItem is directly serializable or its relevant parts are.
  // If ResponseItem itself is defined via Zod and serializable, this can be simpler.
  const serializableItem = JSON.parse(JSON.stringify(responseItem)); // Basic sanitization
  return {
    type: "item",
    responseItem: serializableItem,
    id: sessionId ? `${sessionId}-${Date.now()}` : undefined, // Example ID generation
  };
}

export function commandPromptToFrame(
  commandId: string,
  command: string[],
  applyPatch?: ApplyPatchCommand,
  explanation?: string,
): CommandPromptFrame {
  // WARNING: Similar to ResponseItem, ApplyPatchCommand might need serialization logic.
  const serializablePatch = applyPatch
    ? JSON.parse(JSON.stringify(applyPatch))
    : undefined;
  return {
    type: "command_prompt",
    commandId,
    command,
    applyPatch: serializablePatch,
    explanation,
  };
}

export function userMessageFrameToResponseInputItems(
  frame: UserMessageFrame,
): ResponseInputItem[] {
  // This might be more complex depending on how codex-cli expects images or other inputs.
  // For now, assuming a simple text conversion. ResponseInputItem structure from codex-cli is key here.
  const items: ResponseInputItem[] = [];

  if (frame.content) {
    items.push({
      type: "input_text",
      text: frame.content,
    } as ResponseInputItem); // Cast needed if type is stricter
  }

  // TODO: Handle frame.imagePaths if AgentLoop supports them directly as paths or if they need to be converted
  // e.g., to base64 data URLs or other ResponseInputItem types.

  return items;
}

export interface AgentRunMetadata {
  sessionId?: string;
  configOverrides?: UserMessageFrame["configOverrides"];
  // Potentially other metadata extracted from the first UserMessageFrame
}

export function extractMetadataFromUserMessage(
  frame: UserMessageFrame,
): AgentRunMetadata {
  return {
    sessionId: frame.sessionId,
    configOverrides: frame.configOverrides,
  };
}

// Add more mappers as needed, for example, to convert parts of ApproveFrame to arguments for AgentLoop methods.
