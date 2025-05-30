import process from "process";

export interface Env {
  GITHUB_URL: string | undefined;
  INITIAL_QUERY: string | undefined;
  OPENAI_API_KEY: string | undefined;
  CALLBACK_URL: string | undefined;
  SESSION_ID: string | undefined;
  PORT: number;
  INTERNAL_DOCKER_SHARED_SECRET: string | undefined;
  GITHUB_ACCESS_TOKEN: string | undefined;
  GIT_PROVIDER: string | undefined;
}

export const env: Env = {
  GITHUB_URL: process.env.GITHUB_URL,
  INITIAL_QUERY: process.env.INITIAL_QUERY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CALLBACK_URL: process.env.CALLBACK_URL,
  SESSION_ID: process.env.SESSION_ID,
  PORT: Number(process.env.PORT) || 8080,
  INTERNAL_DOCKER_SHARED_SECRET: process.env.INTERNAL_DOCKER_SHARED_SECRET,
  GITHUB_ACCESS_TOKEN: process.env.GITHUB_ACCESS_TOKEN,
  GIT_PROVIDER: process.env.GIT_PROVIDER ?? "GITHUB",
};

export function validateEnv(): void {
  const missing: string[] = [];
  if (!env.GITHUB_URL) missing.push("GITHUB_URL");
  if (!env.INITIAL_QUERY) missing.push("INITIAL_QUERY");
  if (!env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");

  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
}
