import { Response } from "express";

interface SseClient extends Response {}

export class SseHub {
  private clients: SseClient[] = [];

  addClient(res: SseClient): void {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    // @ts-ignore flushHeaders exists when using http.ServerResponse
    res.flushHeaders();
    res.write("\n");

    this.clients.push(res);

    res.on("close", () => {
      this.clients = this.clients.filter((c) => c !== res);
    });
  }

  broadcast(eventObj: unknown): void {
    const payload = JSON.stringify(eventObj);
    for (const client of this.clients) {
      client.write(`data: ${payload}\n\n`);
    }
  }
}
