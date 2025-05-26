import { randomUUID } from "crypto";
import type { AgentLoop } from "@openai/codex-cli/utils/agent/agent-loop"; // Adjust if needed
import type { AppConfig } from "@openai/codex-cli/utils/config"; // Adjust if needed

// Placeholder for Redis client if you add it later
// import { createClient, RedisClientType } from 'redis';

const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60; // 1 day
const SINGLE_CLIENT_ID = "backend-service"; // Static ID for the single client (your backend)

export interface Session {
  id: string;
  agentLoop: AgentLoop; // The actual AgentLoop instance
  appConfig: AppConfig; // Configuration for this session's AgentLoop
  // clientId: string; // Not strictly needed if only one client
  lastActivity: number; // Timestamp of last activity
  // Add any other session-specific state you need to track
  // e.g., current approvalPolicy, model, etc. if they can change mid-session
}

interface SessionManagerOptions {
  sessionTtlSeconds?: number;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  // private redisClient?: RedisClientType; // Uncomment if using Redis
  private readonly sessionTtlMs: number;

  constructor(options?: SessionManagerOptions) {
    this.sessionTtlMs =
      (options?.sessionTtlSeconds || DEFAULT_SESSION_TTL_SECONDS) * 1000;
    console.log(
      "[codex-api:SessionManager] Using in-memory session storage for a single backend client.",
    );
    setInterval(() => this.cleanupExpiredSessions(), this.sessionTtlMs / 2);
  }

  async get(sessionId: string): Promise<Session | undefined> {
    // if (this.redisClient) {
    //     const sessionJson = await this.redisClient.get(`session:${sessionId}`);
    //     if (sessionJson) {
    //         const partialSession = JSON.parse(sessionJson) as Omit<Session, 'agentLoop'>;
    //         // AgentLoop is not serializable directly. It needs to be reconstructed or handled differently.
    //         // This is a major challenge for distributed sessions with AgentLoop.
    //         // For now, this Redis path will not fully work for AgentLoop state.
    //         console.warn('[codex-api:SessionManager] Retrieving AgentLoop from Redis is not fully supported.');
    //         // return { ...partialSession, agentLoop: new AgentLoop(...) }; // Placeholder
    //         return undefined;
    //     }
    //     return undefined;
    // }
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
      // await this.save(session); // If using Redis and want to update TTL on access
    }
    return session;
  }

  async createOrGet(
    agentLoopInstance: AgentLoop,
    initialAppConfig: AppConfig,
    requestedSessionId?: string, // Backend might want to manage/assign IDs
  ): Promise<Session> {
    const sessionId = requestedSessionId || randomUUID();

    if (this.sessions.has(sessionId)) {
      const existingSession = this.sessions.get(sessionId)!;
      // Potentially update agentLoop or appConfig if logic allows re-configuration
      existingSession.lastActivity = Date.now();
      console.log(
        `[codex-api:SessionManager] Re-using existing session: ${sessionId}`,
      );
      return existingSession;
    }

    const session: Session = {
      id: sessionId,
      agentLoop: agentLoopInstance,
      appConfig: initialAppConfig,
      lastActivity: Date.now(),
    };

    this.sessions.set(sessionId, session);
    console.log(`[codex-api:SessionManager] Session created: ${sessionId}`);
    return session;
  }

  // private async save(session: Session): Promise<void> {
  //     if (this.redisClient) {
  //         const { agentLoop, ...serializableSession } = session;
  //         // AgentLoop is not directly serializable. Only save metadata.
  //         await this.redisClient.set(`session:${session.id}`, JSON.stringify(serializableSession), {
  //             EX: Math.floor(this.sessionTtlMs / 1000),
  //         });
  //     }
  // }

  async destroy(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Attempt to gracefully terminate the agent loop if it has such a method
      if (typeof (session.agentLoop as any).terminate === "function") {
        try {
          await (session.agentLoop as any).terminate();
        } catch (e) {
          console.warn(
            `[codex-api:SessionManager] Error terminating agent loop for session ${sessionId}:`,
            e,
          );
        }
      }
    }
    this.sessions.delete(sessionId);
    // if (this.redisClient) {
    //     await this.redisClient.del(`session:${sessionId}`);
    // }
    console.log(`[codex-api:SessionManager] Session destroyed: ${sessionId}`);
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > this.sessionTtlMs) {
        console.log(
          `[codex-api:SessionManager] Cleaning up expired session: ${sessionId}`,
        );
        this.destroy(sessionId);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      console.log(
        `[codex-api:SessionManager] Cleaned up ${cleanedCount} expired sessions.`,
      );
    }
  }

  // public async disconnectRedis(): Promise<void> {
  //     if (this.redisClient && this.redisClient.isOpen) {
  //         await this.redisClient.quit();
  //         console.log('[codex-api:SessionManager] Disconnected from Redis.');
  //     }
  // }
}
