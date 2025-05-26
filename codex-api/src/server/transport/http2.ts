import type {
  Http2ServerRequest,
  Http2ServerResponse,
  ServerHttp2Stream,
} from "http2";
import type { ClientFrame, ServerFrame } from "../types/protocol";
import { decodeClientFrame, encodeServerFrame } from "../types/protocol";

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const NDJSON_CONTENT_TYPE = "application/x-ndjson";
const LENGTH_PREFIXED_JSON_CONTENT_TYPE = "application/length-prefixed-json"; // Custom type

interface FrameTransportOptions {
  useLengthPrefix?: boolean;
  heartbeatIntervalMs?: number;
}

export async function* readFrames(
  stream: ServerHttp2Stream,
  req: Http2ServerRequest,
): AsyncGenerator<ClientFrame, void, undefined> {
  let buffer = Buffer.alloc(0);
  let readingLength = true;
  let expectedLength = 0;
  const useLengthPrefix =
    req.headers["content-type"] === LENGTH_PREFIXED_JSON_CONTENT_TYPE;

  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);

    if (useLengthPrefix) {
      while (buffer.length > 0) {
        if (readingLength) {
          if (buffer.length >= 4) {
            expectedLength = buffer.readUInt32BE(0);
            buffer = buffer.subarray(4);
            readingLength = false;
          } else {
            break; // Not enough data for length
          }
        }

        if (!readingLength) {
          if (buffer.length >= expectedLength) {
            const messageBuffer = buffer.subarray(0, expectedLength);
            buffer = buffer.subarray(expectedLength);
            readingLength = true;
            try {
              yield decodeClientFrame(messageBuffer.toString("utf-8"));
            } catch (err: any) {
              console.error(
                "[codex-api:http2] Error decoding length-prefixed client frame:",
                err,
              );
              // Optionally, send an error frame back to the client or terminate
              stream.end(
                encodeServerFrame({
                  type: "error",
                  message: `Frame decoding error: ${err.message}`,
                }),
              );
              return;
            }
          } else {
            break; // Not enough data for message
          }
        }
      }
    } else {
      // NDJSON
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.subarray(0, newlineIndex).toString("utf-8");
        buffer = buffer.subarray(newlineIndex + 1);
        if (line.trim() === "") continue;
        try {
          yield decodeClientFrame(line);
        } catch (err: any) {
          console.error(
            "[codex-api:http2] Error decoding NDJSON client frame:",
            err,
          );
          stream.end(
            encodeServerFrame({
              type: "error",
              message: `Frame decoding error: ${err.message}`,
            }),
          );
          return;
        }
      }
    }
  }
  // Handle any remaining data in buffer if stream ends unexpectedly (optional)
  if (buffer.length > 0 && !useLengthPrefix) {
    const line = buffer.toString("utf-8");
    if (line.trim() !== "") {
      try {
        yield decodeClientFrame(line);
      } catch (err: any) {
        console.error(
          "[codex-api:http2] Error decoding final NDJSON client frame:",
          err,
        );
        // Don't try to write to stream if it might be closed
      }
    }
  }
}

export function writeFrame(
  stream: ServerHttp2Stream,
  frame: ServerFrame,
  res: Http2ServerResponse, // Pass res to check content-type for sending
  options?: FrameTransportOptions,
): boolean {
  if (stream.destroyed || stream.closed) {
    console.warn(
      "[codex-api:http2] Attempted to write to a closed/destroyed stream. Frame:",
      frame.type,
    );
    return false;
  }
  const useLengthPrefix =
    res.getHeader("content-type") === LENGTH_PREFIXED_JSON_CONTENT_TYPE;

  try {
    const jsonPayload = encodeServerFrame(frame);
    if (useLengthPrefix) {
      const lengthBuffer = Buffer.alloc(4);
      lengthBuffer.writeUInt32BE(Buffer.byteLength(jsonPayload, "utf-8"), 0);
      return stream.write(
        Buffer.concat([lengthBuffer, Buffer.from(jsonPayload, "utf-8")]),
      );
    } else {
      return stream.write(`${jsonPayload}\n`);
    }
  } catch (err: any) {
    console.error(
      "[codex-api:http2] Error encoding server frame:",
      err,
      "Frame:",
      frame,
    );
    // Avoid sending error frame if this itself fails, could loop
    return false;
  }
}

export function startHeartbeat(
  stream: ServerHttp2Stream,
  res: Http2ServerResponse,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): NodeJS.Timeout {
  return setInterval(() => {
    if (stream.destroyed || stream.closed) {
      // The main interval will be cleared by stopHeartbeat when the stream closes.
      // This check is an additional safeguard.
      return;
    }
    writeFrame(
      stream,
      { type: "heartbeat", timestamp: new Date().toISOString() },
      res,
    );
  }, intervalMs);
}

// stopHeartbeat is implicitly handled by stream.on('close') in the route handler, which should clear the interval.
