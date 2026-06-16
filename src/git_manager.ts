import { runProcess } from "./command_runner";
import { CommandResult } from "./types";
import { isSensitivePath, redactSensitive, slugify } from "./utils";

const SAFE_PATHSPECS = [
  ".",
  ":(exclude).cbduel/runs",
  ":(exclude).cbduel/logs",
  ":(exclude).env",
  ":(exclude).env.*",
  ":(exclude,glob)**/.env",
  ":(exclude,glob)**/.env.*",
  ":(exclude,glob)**/*token*",
  ":(exclude,glob)**/*secret*",
  ":(exclude,glob)**/*credential*",
  ":(exclude,glob)**/*password*",
  ":(exclude,glob)**/*.pem",
  ":(exclude,glob)**/*.key",
  ":(exclude,glob)**/*.p12",
  ":(exclude,glob)**/*.pfx"
];

export interface GitCommitResult {
  ok: boolean;
  skipped: boolean;
  message: string;
  hash?: string;
  output: string;
}

export class GitManager {
  constructor(private readonly cwd: string) {}

  private git(args: string[], timeoutMs = 60_000): Promise<CommandResult> {
    return runProcess("git", args, { cwd: this.cwd, timeoutMs });
  }

  async isGitAvailable(): Promise<boolean> {
    const result = await this.git(["--version"], 15_000);
    return result.ok;
  }

  async isRepository(): Promise<boolean> {
    const result = await this.git(["rev-parse", "--is-inside-work-tree"], 15_000);
    return result.ok && result.stdout.trim() === "true";
  }

  async currentBranch(): Promise<string> {
    const result = await this.git(["branch", "--show-current"], 15_000);
    if (!result.ok || !result.stdout.trim()) return "(unknown)";
    return result.stdout.trim();
  }

  async createBranchForGoal(goal: string): Promise<{ ok: boolean; branch: string; output: string }> {
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const branch = `cbduel/${slugify(goal)}-${timestamp}`;
    const result = await this.git(["checkout", "-b", branch], 60_000);
    return {
      ok: result.ok,
      branch: result.ok ? branch : await this.currentBranch(),
      output: redactSensitive(result.combined)
    };
  }

  async status(): Promise<string> {
    const result = await this.git(["status", "--short", "--branch", "--", ...SAFE_PATHSPECS], 60_000);
    if (!result.ok) return redactSensitive(result.combined || result.errorMessage || "git status failed");
    return this.filterSensitiveStatus(result.stdout);
  }

  async diff(): Promise<string> {
    const result = await this.git(["diff", "--", ...SAFE_PATHSPECS], 120_000);
    if (!result.ok) return redactSensitive(result.combined || result.errorMessage || "git diff failed");
    return redactSensitive(result.stdout);
  }

  async hasSubstantiveChanges(): Promise<boolean> {
    const result = await this.git(["status", "--porcelain", "--", ...SAFE_PATHSPECS], 60_000);
    if (!result.ok) return false;
    return this.filterSensitiveStatus(result.stdout)
      .split(/\r?\n/)
      .some((line) => line.trim().length > 0);
  }

  async commit(iteration: number, summary: string): Promise<GitCommitResult> {
    const changed = await this.hasSubstantiveChanges();
    if (!changed) {
      return { ok: true, skipped: true, message: "No substantive changes to commit.", output: "" };
    }

    const add = await this.git(["add", "-A", "--", ...SAFE_PATHSPECS], 120_000);
    if (!add.ok) {
      return {
        ok: false,
        skipped: false,
        message: "git add failed",
        output: redactSensitive(add.combined || add.errorMessage || "")
      };
    }

    const commitMessage = `cbduel(iteration ${iteration}): ${this.sanitizeCommitSummary(summary)}`;
    const commit = await this.git(["commit", "-m", commitMessage], 120_000);
    if (!commit.ok) {
      return {
        ok: false,
        skipped: false,
        message: commitMessage,
        output: redactSensitive(commit.combined || commit.errorMessage || "")
      };
    }

    const hash = await this.git(["rev-parse", "--short", "HEAD"], 30_000);
    return {
      ok: true,
      skipped: false,
      message: commitMessage,
      hash: hash.ok ? hash.stdout.trim() : undefined,
      output: redactSensitive(commit.combined)
    };
  }

  async push(): Promise<CommandResult> {
    const branch = await this.currentBranch();
    return this.git(["push", "-u", "origin", branch], 5 * 60_000);
  }

  private sanitizeCommitSummary(summary: string): string {
    const cleaned = summary
      .replace(/\r?\n/g, " ")
      .replace(/[^\p{L}\p{N}\s._:;,+()/\-[\]]/gu, "")
      .trim();
    return (cleaned || "自动开发成果").slice(0, 80);
  }

  private filterSensitiveStatus(status: string): string {
    return status
      .split(/\r?\n/)
      .filter((line) => {
        const filePart = line.slice(3).trim();
        return filePart ? !isSensitivePath(filePart) : true;
      })
      .join("\n");
  }
}
