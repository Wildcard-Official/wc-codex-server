import { spawn } from "child_process";
import { EventEmitter } from "events";
import { env } from "./config.js";

interface LogEvent {
  type: "log";
  level: "error" | "info" | "warn";
  message: string;
}

export interface RunnerEvent {
  session_id?: string;
  content: unknown; // Could be narrowed with proper protocol types
}

export declare interface CodexRunner {
  on(event: "event", listener: (evt: RunnerEvent) => void): this;
  on(event: "log", listener: (evt: LogEvent) => void): this;
}

export class CodexRunner extends EventEmitter {
  private repoDir: string;

  constructor(repoDir: string) {
    super();
    this.repoDir = repoDir;
  }

  run(): void {
    const codexArgs = [
      "-q",
      "--json",
      "-a",
      "full-auto",
      env.INITIAL_QUERY ?? "",
    ];

    // eslint-disable-next-line no-console
    console.log(`Running: codex ${codexArgs.join(" ")}`);

    const child = spawn("codex", codexArgs, {
      cwd: this.repoDir,
      env: { ...process.env, OPENAI_API_KEY: env.OPENAI_API_KEY },
    });

    let stdoutBuf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, newlineIdx);
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        this.#handleLine(line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString();
      this.emit("log", {
        type: "log",
        level: "error",
        message: msg,
      } as LogEvent);
    });

    child.on("exit", (code) => {
      this.#handleLine(
        JSON.stringify({ type: "finished", exit_code: code ?? null }),
      );
    });
  }

  #handleLine(line: string): void {
    if (!line.trim()) return;
    let obj: RunnerEvent = { content: {} };
    try {
      obj.content = JSON.parse(line);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Non-JSON line from codex:", line);
      return;
    }
    if (env.SESSION_ID) obj.session_id = env.SESSION_ID;
    this.emit("event", obj);
  }
}
