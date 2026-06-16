import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./command_runner";
import { CbduelConfig } from "./types";
import {
  copyFileIfMissing,
  ensureDir,
  readTextFileIfExists,
  resolveTemplatePath,
  safeJsonStringify,
  writeFileIfMissing,
  writeTextFile
} from "./utils";
import { validateConfig } from "./validator";

export const CONFIG_FILE = "cbduel.config.json";

export const DEFAULT_FINAL_REQUIREMENTS = [
  "必须可运行，不是 MVP，也不能只交设计文档。",
  "必须包含清晰 README、配置、日志、错误处理和最终报告。",
  "能测试就必须测试；如果测试或构建不可用，必须说明原因并留下可复现命令。",
  "不得把 TODO、demo、伪实现当作完成。",
  "不得读取、打印、提交或上传 .env、token、密钥、私钥等敏感内容。"
].join("\n");

export const DEFAULT_CONFIG: CbduelConfig = {
  defaultRounds: 5,
  defaultMinRounds: 1,
  defaultTimeLimitMin: 60,
  defaultMinRuntimeMin: 0,
  mode: "tui",
  landing: "soft",
  refreshIntervalSec: 2,
  autoCommit: true,
  push: false,
  createBranch: true,
  testCommand: "",
  buildCommand: "",
  finalRequirements: DEFAULT_FINAL_REQUIREMENTS,
  claude: {
    command: "claude",
    outputFormat: "json",
    allowedTools: [
      "Read",
      "Write",
      "Edit",
      "MultiEdit",
      "Glob",
      "Grep",
      "LS",
      "Bash(git status*)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(npm *)",
      "Bash(node *)",
      "Bash(pnpm *)",
      "Bash(yarn *)",
      "Bash(deno *)",
      "Bash(tsc *)"
    ],
    maxRetries: 1,
    timeoutMs: 15 * 60 * 1000,
    permissionMode: "auto"
  },
  qualityBar:
    "生产可用：直接改代码、能运行、能测试、有 README、有日志、有错误处理、有最终报告；禁止只给建议。"
};

export interface LoadConfigResult {
  config: CbduelConfig;
  configPath: string;
  warnings: string[];
  errors: string[];
}

function mergeConfig(base: CbduelConfig, partial: unknown): CbduelConfig {
  const incoming = (partial && typeof partial === "object" ? partial : {}) as Partial<CbduelConfig>;
  return {
    ...base,
    ...incoming,
    claude: {
      ...base.claude,
      ...(incoming.claude ?? {})
    }
  };
}

export function loadConfig(cwd: string): LoadConfigResult {
  const configPath = path.join(cwd, CONFIG_FILE);
  const warnings: string[] = [];
  const errors: string[] = [];
  let parsed: unknown;

  if (fs.existsSync(configPath)) {
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
      errors.push(`Config is damaged and defaults were used: ${(error as Error).message}`);
    }
  } else {
    warnings.push(`${CONFIG_FILE} not found; in-memory defaults will be used. Run cbduel init to create it.`);
  }

  const config = mergeConfig(DEFAULT_CONFIG, parsed);
  const validation = validateConfig(config);
  warnings.push(...validation.warnings);
  errors.push(...validation.errors);
  return { config, configPath, warnings, errors };
}

export async function checkCommandAvailable(command: string, cwd: string): Promise<{ ok: boolean; message: string }> {
  const result = await runProcess(command, ["--version"], { cwd, timeoutMs: 15_000 });
  if (result.ok) {
    return { ok: true, message: result.stdout.trim() || result.stderr.trim() || `${command} is available.` };
  }
  return {
    ok: false,
    message: result.errorMessage || result.stderr.trim() || result.stdout.trim() || `${command} is not available.`
  };
}

export async function checkGitRepository(cwd: string): Promise<{ gitAvailable: boolean; isRepo: boolean; message: string }> {
  const git = await runProcess("git", ["--version"], { cwd, timeoutMs: 15_000 });
  if (!git.ok) {
    return { gitAvailable: false, isRepo: false, message: git.errorMessage || "git command is not available." };
  }
  const repo = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 15_000 });
  return {
    gitAvailable: true,
    isRepo: repo.ok && repo.stdout.trim() === "true",
    message: repo.ok && repo.stdout.trim() === "true" ? "Git repository detected." : "Current directory is not a Git repository."
  };
}

function projectReadmeContent(): string {
  return [
    "# Project",
    "",
    "This repository is initialized for ClaudeBrainDuel runs.",
    "",
    "Run `cbduel run \"your goal\"` to start an automated Master/Worker development loop.",
    "Runtime logs and final reports are written under `.cbduel/runs/`."
  ].join("\n");
}

function ensureGitignore(cwd: string): boolean {
  const gitignorePath = path.join(cwd, ".gitignore");
  const current = readTextFileIfExists(gitignorePath);
  const entries = [".cbduel/runs/", ".cbduel/logs/", ".env", ".env.*", "*.pem", "*.key"];
  const missing = entries.filter((entry) => !current.split(/\r?\n/).includes(entry));
  if (!missing.length) return false;
  const next = `${current}${current && !current.endsWith("\n") ? "\n" : ""}\n# ClaudeBrainDuel runtime and secrets\n${missing.join("\n")}\n`;
  writeTextFile(gitignorePath, next);
  return true;
}

export async function initProject(cwd: string): Promise<{
  created: string[];
  skipped: string[];
  checks: string[];
  warnings: string[];
}> {
  const created: string[] = [];
  const skipped: string[] = [];
  const checks: string[] = [];
  const warnings: string[] = [];

  const configPath = path.join(cwd, CONFIG_FILE);
  if (writeFileIfMissing(configPath, `${safeJsonStringify(DEFAULT_CONFIG)}\n`)) {
    created.push(configPath);
  } else {
    skipped.push(configPath);
  }

  const cbduelDir = path.join(cwd, ".cbduel");
  const logsDir = path.join(cbduelDir, "logs");
  const templatesDir = path.join(cbduelDir, "templates");
  ensureDir(logsDir);
  ensureDir(templatesDir);
  created.push(logsDir, templatesDir);

  for (const template of ["master_plan.md", "worker_task.md", "master_review.md", "final_report.md"]) {
    const from = resolveTemplatePath(template);
    const to = path.join(templatesDir, template);
    if (fs.existsSync(from) && copyFileIfMissing(from, to)) {
      created.push(to);
    } else if (fs.existsSync(to)) {
      skipped.push(to);
    } else {
      warnings.push(`Template source not found: ${from}`);
    }
  }

  const readmePath = path.join(cwd, "README.md");
  if (writeFileIfMissing(readmePath, `${projectReadmeContent()}\n`)) {
    created.push(readmePath);
  } else {
    skipped.push(readmePath);
  }

  if (ensureGitignore(cwd)) {
    created.push(path.join(cwd, ".gitignore"));
  } else {
    skipped.push(path.join(cwd, ".gitignore"));
  }

  const claude = await checkCommandAvailable(DEFAULT_CONFIG.claude.command, cwd);
  checks.push(`Claude: ${claude.ok ? "ok" : "unavailable"} - ${claude.message}`);
  if (!claude.ok) warnings.push("Claude command is unavailable; cbduel will use manual prompt fallback.");

  const git = await checkGitRepository(cwd);
  checks.push(`Git: ${git.gitAvailable ? "ok" : "unavailable"} - ${git.message}`);
  if (!git.gitAvailable || !git.isRepo) warnings.push("Git repository check failed; branch/commit automation will be disabled.");

  return { created, skipped, checks, warnings };
}
