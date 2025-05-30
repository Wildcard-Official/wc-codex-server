import fs from "fs";
import path from "path";
import { simpleGit } from "simple-git";
import { Octokit } from "@octokit/rest";
import { env } from "./config.js";

interface PrResult {
  url: string;
  number: number;
}

function injectTokenIntoGitHubUrl(repoUrl: string, token: string): string {
  // Convert https://github.com/owner/repo(.git) → https://x-access-token:TOKEN@github.com/owner/repo(.git)
  if (!token) return repoUrl;
  if (!repoUrl.startsWith("https://"))
    throw new Error("Only https:// Git URLs are supported for token injection");
  return repoUrl.replace("https://", `https://x-access-token:${token}@`);
}

export async function cloneRepository(githubUrl: string): Promise<string> {
  const workspace = "/workspace";
  const repoDir = path.join(workspace, "repo");
  fs.mkdirSync(workspace, { recursive: true });

  const authUrl =
    env.GIT_PROVIDER === "GITHUB" && env.GITHUB_ACCESS_TOKEN
      ? injectTokenIntoGitHubUrl(githubUrl, env.GITHUB_ACCESS_TOKEN)
      : githubUrl;

  console.log(`Cloning ${githubUrl} into ${repoDir} …`);
  await simpleGit().clone(authUrl, repoDir, ["--depth", "1"]);

  // Update origin to authenticated url for future pushes if token provided
  if (authUrl !== githubUrl) {
    const git = simpleGit(repoDir);
    await git.remote(["set-url", "origin", authUrl]);
  }

  return repoDir;
}

function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } {
  // Handles https://github.com/owner/repo(.git)
  const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!match) throw new Error(`Unable to parse owner/repo from ${repoUrl}`);
  return { owner: match[1], repo: match[2] };
}

export async function commitPushAndCreatePr(
  repoDir: string,
  sessionId?: string,
): Promise<PrResult | null> {
  if (env.GIT_PROVIDER !== "GITHUB") {
    console.warn(
      "Only GitHub provider is supported currently. Skipping PR creation.",
    );
    return null;
  }

  if (!env.GITHUB_ACCESS_TOKEN) {
    console.warn("GITHUB_ACCESS_TOKEN not present – cannot push or create PR.");
    return null;
  }

  const git = simpleGit(repoDir);

  // Ensure git user config is set
  await git.addConfig("user.name", "Codex Bot");
  await git.addConfig("user.email", "codex-bot@example.com");

  // Check for changes
  const status = await git.status();
  if (status.isClean()) {
    console.log("No changes detected – no PR will be created.");
    return null;
  }

  const branchName = `codex/${sessionId ?? Date.now().toString()}`;

  await git.checkoutLocalBranch(branchName);
  await git.add("./*");
  await git.commit("Codex automated code changes");

  // Push branch to origin (already authenticated url)
  await git.push(["-u", "origin", branchName]);

  const { owner, repo } = parseGitHubRepo(env.GITHUB_URL as string);
  const octokit = new Octokit({ auth: env.GITHUB_ACCESS_TOKEN });

  // Determine base branch (default branch)
  const repoInfo = await octokit.rest.repos.get({ owner, repo });
  const base = repoInfo.data.default_branch;

  const prTitle = `Codex changes (${new Date().toISOString()})`;
  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    head: branchName,
    base,
    title: prTitle,
    draft: true,
  });

  console.log(`Created draft PR #${pr.number}: ${pr.html_url}`);
  return { url: pr.html_url, number: pr.number };
}
