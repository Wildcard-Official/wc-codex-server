import { env } from "./config.js";

export async function postCallback(eventObj: unknown): Promise<void> {
  if (!env.CALLBACK_URL) return;
  try {
    await fetch(env.CALLBACK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": env.INTERNAL_DOCKER_SHARED_SECRET ?? "",
      },
      body: JSON.stringify(eventObj),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to post to callback:", err);
    console.log(JSON.stringify(eventObj));
  }
}
