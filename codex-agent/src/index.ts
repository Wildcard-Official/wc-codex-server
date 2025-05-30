import { validateEnv, env } from "./config.js";
import { createServer } from "./server.js";
import { cloneRepository, commitPushAndCreatePr } from "./gitHelper.js";
import { CodexRunner } from "./codexRunner.js";
import { postCallback } from "./callback.js";

validateEnv();

(async function bootstrap() {
  const { app, hub } = createServer();

  app.listen(env.PORT, async () => {
    // eslint-disable-next-line no-console
    console.log(`Codex agent listening on :${env.PORT}`);

    try {
      const repoDir = await cloneRepository(env.GITHUB_URL as string);
      const runner = new CodexRunner(repoDir);

      runner.on("event", (evt) => {
        hub.broadcast(evt);
        postCallback(evt);
        const content: any = (evt as any).content;
        if (content?.type === "finished") {
          // After codex finishes, attempt to commit & create PR
          (async () => {
            try {
              const pr = await commitPushAndCreatePr(repoDir, env.SESSION_ID);
              if (pr) {
                const prEvent = {
                  session_id: env.SESSION_ID,
                  content: {
                    type: "pull_request",
                    url: pr.url,
                    number: pr.number,
                  },
                } as any;
                hub.broadcast(prEvent);
                postCallback(prEvent);
              }
            } catch (err) {
              console.error("Failed to create draft PR:", err);
            } finally {
              // Delay exit to allow flush
              setTimeout(() => process.exit(content?.exit_code ?? 0), 500);
            }
          })();
        }
      });

      runner.on("log", (logEvt) => hub.broadcast(logEvt));

      runner.run();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    }
  });
})();
