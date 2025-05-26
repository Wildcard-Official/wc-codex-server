import { z } from "zod";

// Common
export const BaseFrameSchema = z.object({
  id: z.string().uuid().optional(), // Optional client-generated ID for their own tracking
});

// C -> S Frames
export const UserMessageFrameSchema = BaseFrameSchema.extend({
  type: z.literal("user_message"),
  sessionId: z.string().optional(), // To resume a session
  content: z.string(),
  imagePaths: z.array(z.string()).optional(),
  // Configuration overrides for this specific run
  configOverrides: z
    .object({
      model: z.string().optional(),
      approvalPolicy: z.enum(["suggest", "auto-edit", "full-auto"]).optional(),
      // any other AppConfig fields relevant for AgentLoop
    })
    .optional(),
});
export type UserMessageFrame = z.infer<typeof UserMessageFrameSchema>;

export const ApproveFrameSchema = BaseFrameSchema.extend({
  type: z.literal("approve"),
  sessionId: z.string(),
  commandId: z.string(),
  decision: z.enum(["allow", "deny"]),
  explanation: z.string().optional(), // For 'deny' decision
});
export type ApproveFrame = z.infer<typeof ApproveFrameSchema>;

export const CancelFrameSchema = BaseFrameSchema.extend({
  type: z.literal("cancel"),
  sessionId: z.string(),
});
export type CancelFrame = z.infer<typeof CancelFrameSchema>;

export type ClientFrame = UserMessageFrame | ApproveFrame | CancelFrame;
export const ClientFrameSchema = z.union([
  UserMessageFrameSchema,
  ApproveFrameSchema,
  CancelFrameSchema,
]);

// S -> C Frames
// Assuming ResponseItem is too complex or from another module,
// we'll define a serializable version or use z.any() for now.
// Ideally, this would be a Zod schema mirroring openai/resources/responses/responses.mjs:ResponseItem
const SerializableResponseItemSchema = z.any();

export const ItemFrameSchema = BaseFrameSchema.extend({
  type: z.literal("item"),
  responseItem: SerializableResponseItemSchema, // This should be a Zod schema for ResponseItem
});
export type ItemFrame = z.infer<typeof ItemFrameSchema>;

export const CommandPromptFrameSchema = BaseFrameSchema.extend({
  type: z.literal("command_prompt"),
  commandId: z.string(),
  command: z.array(z.string()),
  applyPatch: z.any().optional(), // This should be a Zod schema for ApplyPatchCommand
  explanation: z.string().optional(), // Pre-generated explanation from the agent
});
export type CommandPromptFrame = z.infer<typeof CommandPromptFrameSchema>;

export const StatusFrameSchema = BaseFrameSchema.extend({
  type: z.literal("status"),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type StatusFrame = z.infer<typeof StatusFrameSchema>;

export const ErrorFrameSchema = BaseFrameSchema.extend({
  type: z.literal("error"),
  message: z.string(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
  details: z.record(z.unknown()).optional(),
});
export type ErrorFrame = z.infer<typeof ErrorFrameSchema>;

export const HeartbeatFrameSchema = BaseFrameSchema.extend({
  type: z.literal("heartbeat"),
  timestamp: z.string().datetime(),
});
export type HeartbeatFrame = z.infer<typeof HeartbeatFrameSchema>;

export const TerminateFrameSchema = BaseFrameSchema.extend({
  type: z.literal("terminate"),
  reason: z.string(),
  details: z.record(z.unknown()).optional(),
});
export type TerminateFrame = z.infer<typeof TerminateFrameSchema>;

export type ServerFrame =
  | ItemFrame
  | CommandPromptFrame
  | StatusFrame
  | ErrorFrame
  | HeartbeatFrame
  | TerminateFrame;

export const ServerFrameSchema = z.union([
  ItemFrameSchema,
  CommandPromptFrameSchema,
  StatusFrameSchema,
  ErrorFrameSchema,
  HeartbeatFrameSchema,
  TerminateFrameSchema,
]);

export type ProtocolFrame = ClientFrame | ServerFrame;

// Helper functions (simplified, actual implementation might involve more error handling)
export function encodeClientFrame(obj: ClientFrame): string {
  return JSON.stringify(ClientFrameSchema.parse(obj));
}

export function decodeClientFrame(jsonString: string): ClientFrame {
  return ClientFrameSchema.parse(JSON.parse(jsonString));
}

export function encodeServerFrame(obj: ServerFrame): string {
  return JSON.stringify(ServerFrameSchema.parse(obj));
}

export function decodeServerFrame(jsonString: string): ServerFrame {
  return ServerFrameSchema.parse(JSON.parse(jsonString));
}
