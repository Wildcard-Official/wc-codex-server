import express from "express";
import { spawn } from "child_process";
// Node 18+ ships with a global `fetch`; no need for external lib.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import simpleGit from "simple-git";

// Resolve __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Env vars
// ---------------------------------------------------------------------------
const {
  GITHUB_URL,
  INITIAL_QUERY,
  OPENAI_API_KEY,
  CALLBACK_URL,
  SESSION_ID,
  PORT = 8080,
} = process.env;

if (!GITHUB_URL || !INITIAL_QUERY || !OPENAI_API_KEY) {
  // eslint-disable-next-line no-console
  console.error(
    "Missing one of required env vars: GITHUB_URL, INITIAL_QUERY, OPENAI_API_KEY",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
const app = express();

let sseClients = [];

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.get("/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.flushHeaders(); // flush the headers to establish SSE with client

  res.write("\n"); // heartbeat
  sseClients.push(res);

  req.on("close", () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

function broadcast(eventObj) {
  const payload = JSON.stringify(eventObj);
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

async function postCallback(eventObj) {
  if (!CALLBACK_URL) return;
  try {
    await fetch(CALLBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventObj),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to post to callback:", err);
    console.log(JSON.stringify(eventObj));
  }
}

function handleEventLine(line) {
  if (!line.trim()) return; // skip empty lines
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Non-JSON line from codex:", line);
    return;
  }
  if (SESSION_ID) obj.session_id = SESSION_ID;

  broadcast(obj);
  postCallback(obj);

  if (obj.type === "finished") {
    // Allow some time for final events to flush
    setTimeout(() => process.exit(obj.exit_code ?? 0), 500);
  }
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------
async function main() {
  // 1. Clone repository
  const workspace = "/workspace";
  const repoDir = path.join(workspace, "repo");
  fs.mkdirSync(workspace, { recursive: true });

  // eslint-disable-next-line no-console
  console.log(`Cloning ${GITHUB_URL} into ${repoDir}…`);
  try {
    await simpleGit().clone(GITHUB_URL, repoDir, ["--depth", "1"]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("git clone failed:", err);
    process.exit(1);
  }

  // 2. Spawn Codex CLI in quiet mode
  //    We intentionally run CLI as a child process for isolation & stability.
  const codexArgs = ["-q", "--json", "-a", "full-auto", INITIAL_QUERY];

  // eslint-disable-next-line no-console
  console.log(`Running: codex ${codexArgs.join(" ")}`);
  const child = spawn("codex", codexArgs, {
    cwd: repoDir,
    env: { ...process.env, OPENAI_API_KEY },
  });

  // Buffer stdout to ensure we split on newlines correctly
  let stdoutBuf = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    let newlineIdx;
    while ((newlineIdx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, newlineIdx);
      stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
      handleEventLine(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    // Forward stderr lines as "log" events
    const msg = chunk.toString();
    broadcast({ type: "log", level: "error", message: msg });
  });

  child.on("exit", (code) => {
    handleEventLine(
      JSON.stringify({ type: "finished", exit_code: code ?? null }),
    );
  });
}

// Start Express server first so that control plane can connect immediately
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Codex agent listening on :${PORT}`);
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
});
