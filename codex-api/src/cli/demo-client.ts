import {
  connect,
  constants as http2constants,
  ClientHttp2Session,
} from "http2";
import { randomUUID } from "crypto";
import readline from "readline";
import chalk from "chalk";
import type { ClientFrame, ServerFrame } from "../types/protocol";
import { encodeClientFrame, decodeServerFrame } from "../types/protocol";

const { HTTP2_HEADER_PATH, HTTP2_HEADER_METHOD, HTTP2_HEADER_CONTENT_TYPE } =
  http2constants;

const SERVER_URL = process.env.CODEX_API_URL || "http://localhost:8080"; // Use http for h2c by default
const SESSION_ID = process.argv[2] || `client-session-${randomUUID()}`;
const INITIAL_PROMPT =
  process.argv[3] || "Explain the theory of relativity in simple terms.";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

let h2Session: ClientHttp2Session | null = null;

function connectToServer(): Promise<ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    console.log(chalk.yellow(`Connecting to ${SERVER_URL}...`));
    const clientSession = connect(SERVER_URL, (session) => {
      console.log(chalk.green("Successfully connected to HTTP/2 server."));
      resolve(session);
    });

    clientSession.on("error", (err) => {
      console.error(chalk.red("HTTP/2 session error:"), err);
      reject(err);
      process.exit(1);
    });

    clientSession.on("close", () => {
      console.log(chalk.blue("HTTP/2 session closed."));
      h2Session = null; // Clear the session
      rl.close();
      process.exit(0);
    });
  });
}

async function sendFrame(frame: ClientFrame) {
  if (!h2Session || h2Session.destroyed || h2Session.closed) {
    console.error(chalk.red("Session is not active. Cannot send frame."));
    return;
  }
  try {
    const stream = h2Session.request({
      [HTTP2_HEADER_PATH]: "/agent/stream",
      [HTTP2_HEADER_METHOD]: "POST",
      [HTTP2_HEADER_CONTENT_TYPE]: "application/x-ndjson", // Or 'application/length-prefixed-json'
    });
    stream.setEncoding("utf8");

    stream.on("response", (headers) => {
      console.log(chalk.cyan("Response Headers:"), headers);
    });

    stream.on("data", (chunk) => {
      const chunkStr = chunk.toString();
      // Assuming NDJSON, split by newline. Length-prefix would need different buffering.
      chunkStr.split("\n").forEach((line: string) => {
        if (line.trim() === "") return;
        try {
          const serverFrame = decodeServerFrame(line);
          handleServerFrame(serverFrame);
        } catch (e: any) {
          console.error(
            chalk.red("Error decoding server frame:"),
            e.message,
            "Raw line:",
            line,
          );
        }
      });
    });

    stream.on("end", () => {
      console.log(chalk.blue("Stream ended by server."));
      // For this demo, we might not want to close the whole session on individual stream end,
      // if the protocol implies the main h2 session stays open for multiple POST /agent/stream requests.
      // However, our current server design is one stream per session interaction.
      if (h2Session && !h2Session.closed) {
        // h2Session.close(); // Decide if client should close session or server controls it fully
      }
    });

    stream.on("error", (err) => {
      console.error(chalk.red("Stream error:"), err);
    });

    const payload = encodeClientFrame(frame);
    stream.write(payload + "\n"); // Add newline for NDJSON
    // For length-prefix, you would calculate length and send that first.

    // For this simple client, we send one frame and then potentially end the stream from client side
    // or wait for server to end it. A more interactive client would keep the stream open.
    // If the stream is meant to be long-lived for multiple back-and-forth on the SAME stream:
    // stream.end(); // Do not end if more client frames are to be sent on this stream.
  } catch (error) {
    console.error(chalk.red("Error sending frame:"), error);
  }
}

function handleServerFrame(frame: ServerFrame) {
  console.log(chalk.magenta("\n<- SERVER:"), chalk.magentaBright(frame.type));
  switch (frame.type) {
    case "item":
      // console.log(chalk.gray(JSON.stringify(frame.responseItem, null, 2)));
      // Attempt to find and print text content from ResponseItem
      const contentArray = frame.responseItem?.content;
      if (Array.isArray(contentArray)) {
        contentArray.forEach((contentItem: any) => {
          if (contentItem.type === "output_text" && contentItem.text) {
            process.stdout.write(chalk.green(contentItem.text));
          } else if (contentItem.type === "tool_code" && contentItem.code) {
            process.stdout.write(
              chalk.yellow(`\n[TOOL CODE]:\n${contentItem.code}\n`),
            );
          } else if (contentItem.type === "tool_output" && contentItem.output) {
            process.stdout.write(
              chalk.blueBright(`\n[TOOL OUTPUT]:\n${contentItem.output}\n`),
            );
          } else {
            // Fallback for other content types
            // console.log(chalk.gray(JSON.stringify(contentItem)));
          }
        });
      }
      break;
    case "command_prompt":
      console.log(
        chalk.yellow("Command requires approval:"),
        frame.command.join(" "),
      );
      if (frame.explanation)
        console.log(chalk.yellowBright("Explanation:"), frame.explanation);
      rl.question(chalk.cyan("Approve? (yes/no): "), (answer) => {
        const decision =
          answer.toLowerCase() === "yes" || answer.toLowerCase() === "y"
            ? "allow"
            : "deny";
        sendFrame({
          type: "approve",
          sessionId: SESSION_ID,
          commandId: frame.commandId,
          decision,
        });
      });
      return; // Don't prompt for new input until approval is done
    case "status":
      console.log(chalk.gray("Status:"), frame.message);
      break;
    case "error":
      console.error(
        chalk.red("Error from server:"),
        frame.message,
        frame.code ? `(Code: ${frame.code})` : "",
      );
      break;
    case "heartbeat":
      console.log(chalk.dim("Heartbeat received:", frame.timestamp));
      return; // Don't prompt for new input on heartbeat
    case "terminate":
      console.log(chalk.blueBright("Server terminated session:"), frame.reason);
      if (h2Session && !h2Session.closed) h2Session.close();
      return;
  }
  promptForInput(); // Prompt for next input unless it was a command_prompt or terminate
}

function promptForInput() {
  rl.question(chalk.cyan("\n-> USER: "), (input) => {
    if (input.toLowerCase() === "/quit" || input.toLowerCase() === "/exit") {
      if (h2Session && !h2Session.destroyed) h2Session.close();
      else rl.close();
      return;
    }
    if (input.toLowerCase() === "/cancel") {
      sendFrame({ type: "cancel", sessionId: SESSION_ID });
      promptForInput(); // Re-prompt after sending cancel
      return;
    }
    sendFrame({ type: "user_message", sessionId: SESSION_ID, content: input });
    // Server will respond, then handleServerFrame will call promptForInput again (unless it's a prompt)
  });
}

async function main() {
  try {
    h2Session = await connectToServer();
    console.log(chalk.blue(`Demo client started. Session ID: ${SESSION_ID}`));
    console.log(chalk.blue("Type /quit or /exit to end."));
    console.log(chalk.blue("Type /cancel to send a cancel frame."));

    // Send initial prompt
    if (INITIAL_PROMPT) {
      console.log(chalk.cyan("Sending initial prompt:"), INITIAL_PROMPT);
      // For the demo client, we'll make the first user_message trigger a new stream implicitly by calling sendFrame.
      // A more robust client might establish one stream and send multiple messages on it if the server supported that.
      // Our server currently expects one interaction per stream for /agent/stream, so this is fine.
      sendFrame({
        type: "user_message",
        sessionId: SESSION_ID,
        content: INITIAL_PROMPT,
      });
    } else {
      promptForInput();
    }
  } catch (error) {
    console.error(chalk.red("Failed to start demo client:"), error);
    process.exit(1);
  }
}

main();
