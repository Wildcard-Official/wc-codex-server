import express, { Application, Request, Response } from "express";
import { SseHub } from "./sseHub.js";

export function createServer(): { app: Application; hub: SseHub } {
  const app = express();
  const hub = new SseHub();

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).send("ok");
  });

  app.get("/stream", (req: Request, res: Response) => {
    hub.addClient(res);
  });

  return { app, hub };
}
