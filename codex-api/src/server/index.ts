import { createSecureServer, Http2SecureServer, Http2Server } from "http2";
import { readFileSync } from "fs";
import { resolve as pathResolve } from "path";
import { handleAgentStream } from "./routes/agent";
import chalk from "chalk";

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const HOST = process.env.HOST || "localhost";

// For TLS, you need a key and certificate.
// For local development, you can generate self-signed certificates.
// Example using mkcert: `mkcert localhost` then update paths.
const useTls = process.env.CODEX_API_USE_TLS === "true";

// Define a type for server options that can hold key and cert
interface ServerOptions {
  key?: Buffer;
  cert?: Buffer;
  allowHTTP1?: boolean;
}

let serverOptions: ServerOptions = {};
let tlsInitialized = false;

if (useTls) {
  try {
    const keyPath = pathResolve(
      process.env.CODEX_API_TLS_KEY_PATH || "./certs/localhost-key.pem",
    );
    const certPath = pathResolve(
      process.env.CODEX_API_TLS_CERT_PATH || "./certs/localhost.pem",
    );

    serverOptions = {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
      allowHTTP1: true,
    };
    tlsInitialized = true;
    console.log(
      chalk.green(
        "[codex-api:server] TLS enabled. Certificates loaded successfully.",
      ),
    );
  } catch (err: any) {
    console.error(
      chalk.red("[codex-api:server] Error loading TLS certificates:"),
      err.message,
    );
    console.error(
      chalk.yellow(
        "[codex-api:server] Falling back to HTTP/2 Cleartext (h2c). Set CODEX_API_USE_TLS=false to silence this, or provide valid cert paths via CODEX_API_TLS_KEY_PATH and CODEX_API_TLS_CERT_PATH.",
      ),
    );
    serverOptions = { allowHTTP1: true }; // Fallback to allowHTTP1 even if certs fail to load
  }
} else {
  serverOptions = { allowHTTP1: true }; // For h2c, allowHTTP1 might be useful for some client setups or proxies
}

// The native http2 module in Node.js does not have a createServer that directly
// supports h2c (HTTP/2 Cleartext) in the same way as createSecureServer for h2 (TLS).
// For h2c, you typically rely on client's knowledge (e.g. Upgrade header or prior knowledge)
// or use a library that wraps this. However, createSecureServer with allowHTTP1 can serve as a base
// and some clients might negotiate h2c if TLS handshake fails, or they are configured for it.
// For robust h2c, you might need a more specialized setup or a reverse proxy like Nginx.

// For this implementation, we'll use createSecureServer and if TLS is not configured,
// it will effectively operate over TCP without encryption, relying on client to initiate h2c.
// Or, if you have a specific h2c server library, you would use that here.

// Using createSecureServer. If key/cert are not provided, it can still create an http2 server,
// but it won't be encrypted (TLS). Some clients might require `http://` for this, not `https://`.
const server: Http2SecureServer | Http2Server =
  createSecureServer(serverOptions);

server.on("error", (err) =>
  console.error(chalk.red("[codex-api:server] Server error:"), err),
);

server.on("sessionError", (err) =>
  console.error(chalk.red("[codex-api:server] Session error:"), err),
);

server.on("socketError", (err) =>
  console.error(chalk.red("[codex-api:server] Socket error:"), err),
);

server.on("timeout", () =>
  console.warn(chalk.yellow("[codex-api:server] Server timeout event")),
);

server.on("stream", (stream, headers, flags) => {
  // Delegate to the agent stream handler
  handleAgentStream(stream, headers, flags).catch((err) => {
    console.error(
      chalk.red("[codex-api:server] Unhandled error in handleAgentStream:"),
      err,
    );
    if (!stream.destroyed && !stream.closed) {
      try {
        stream.respond({ ":status": 500 });
        stream.end("Internal Server Error");
      } catch (respondError) {
        console.error(
          chalk.red("[codex-api:server] Error sending 500 response:"),
          respondError,
        );
      }
    }
  });
});

// Graceful Shutdown
const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGQUIT"];
signals.forEach((signal) => {
  process.on(signal, () => {
    console.log(
      chalk.blue(
        `\n[codex-api:server] ${signal} received. Shutting down gracefully...`,
      ),
    );
    server.close(async (err) => {
      if (err) {
        console.error(
          chalk.red("[codex-api:server] Error during server close:"),
          err,
        );
        process.exit(1);
      }
      console.log(chalk.green("[codex-api:server] Server closed. Exiting."));
      // Add any other cleanup here, e.g. sessionManager.disconnectRedis();
      process.exit(0);
    });

    // Force shutdown if server hasn't closed in time
    setTimeout(() => {
      console.warn(
        chalk.yellow(
          "[codex-api:server] Graceful shutdown timed out. Forcing exit.",
        ),
      );
      process.exit(1);
    }, 10000); // 10 seconds timeout
  });
});

server.listen(PORT, HOST, () => {
  const protocol = tlsInitialized ? "https" : "http";
  const effectiveHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(
    chalk.bold.cyan(`
🚀 Codex API Server listening on ${protocol}://${effectiveHost}:${PORT}/agent/stream
    Mode: ${tlsInitialized ? "HTTP/2 with TLS (h2)" : "HTTP/2 Cleartext (h2c) or unencrypted TCP"}
    Press Ctrl+C to stop.
    `),
  );
});

// Handle top-level unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error(
    chalk.red("[codex-api:server] Unhandled Rejection at:"),
    promise,
    chalk.red("reason:"),
    reason,
  );
  // Optionally, exit or log to an error reporting service
});

process.on("uncaughtException", (error) => {
  console.error(chalk.red("[codex-api:server] Uncaught Exception:"), error);
  // For uncaught exceptions, it's often recommended to exit gracefully after logging
  process.exit(1);
});
