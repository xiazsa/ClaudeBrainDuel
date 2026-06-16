import { CliOptions, CbduelConfig, LandingMode, Mode, ResolvedRunOptions } from "./types";
import { coerceBoolean } from "./utils";

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
  warnings: string[];
}

export function isMode(value: string): value is Mode {
  return value === "tui" || value === "headless" || value === "manual";
}

export function isLandingMode(value: string): value is LandingMode {
  return value === "hard" || value === "soft";
}

export function validateConfig(config: CbduelConfig): ValidationResult<CbduelConfig> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!Number.isInteger(config.defaultRounds) || config.defaultRounds < 1) {
    errors.push("defaultRounds must be a positive integer.");
  }
  if (!Number.isInteger(config.defaultMinRounds) || config.defaultMinRounds < 0) {
    errors.push("defaultMinRounds must be a non-negative integer.");
  }
  if (
    Number.isInteger(config.defaultRounds) &&
    Number.isInteger(config.defaultMinRounds) &&
    config.defaultMinRounds > config.defaultRounds
  ) {
    errors.push("defaultMinRounds cannot be greater than defaultRounds.");
  }
  if (!Number.isFinite(config.defaultTimeLimitMin) || config.defaultTimeLimitMin < 1) {
    errors.push("defaultTimeLimitMin must be at least 1.");
  }
  if (!Number.isFinite(config.defaultMinRuntimeMin) || config.defaultMinRuntimeMin < 0) {
    errors.push("defaultMinRuntimeMin must be zero or greater.");
  }
  if (
    Number.isFinite(config.defaultTimeLimitMin) &&
    Number.isFinite(config.defaultMinRuntimeMin) &&
    config.defaultMinRuntimeMin > config.defaultTimeLimitMin
  ) {
    errors.push("defaultMinRuntimeMin cannot be greater than defaultTimeLimitMin.");
  }
  if (!isMode(config.mode)) {
    errors.push("mode must be one of tui, headless, manual.");
  }
  if (!isLandingMode(config.landing)) {
    errors.push("landing must be hard or soft.");
  }
  if (!Number.isFinite(config.refreshIntervalSec) || config.refreshIntervalSec < 1 || config.refreshIntervalSec > 60) {
    errors.push("refreshIntervalSec must be from 1 to 60 seconds.");
  }
  if (!config.claude?.command) {
    errors.push("claude.command is required.");
  }
  if (!["json", "stream-json", "text"].includes(config.claude?.outputFormat)) {
    errors.push("claude.outputFormat must be json, stream-json, or text.");
  }
  if (!Array.isArray(config.claude?.allowedTools)) {
    errors.push("claude.allowedTools must be an array.");
  }
  if (!Number.isInteger(config.claude?.maxRetries) || config.claude.maxRetries < 0) {
    errors.push("claude.maxRetries must be a non-negative integer.");
  }
  if (!Number.isFinite(config.claude?.timeoutMs) || config.claude.timeoutMs < 1000) {
    errors.push("claude.timeoutMs must be at least 1000.");
  }
  if (!config.finalRequirements.trim()) {
    warnings.push("finalRequirements is empty; using a concrete quality bar is recommended.");
  }

  return { ok: errors.length === 0, value: config, errors, warnings };
}

export function resolveRunOptions(config: CbduelConfig, cli: CliOptions): ValidationResult<ResolvedRunOptions> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const goal = (cli.goal ?? "").trim();

  if (!goal) {
    errors.push("Goal is empty. Provide a goal, for example: cbduel run \"build a production-ready plugin\".");
  }

  const rounds = cli.rounds ?? config.defaultRounds;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) {
    errors.push("rounds must be an integer from 1 to 50.");
  }

  const minRounds = cli.minRounds ?? config.defaultMinRounds;
  if (!Number.isInteger(minRounds) || minRounds < 0 || minRounds > 50) {
    errors.push("min-rounds must be an integer from 0 to 50.");
  } else if (Number.isInteger(rounds) && minRounds > rounds) {
    errors.push("min-rounds cannot be greater than rounds.");
  }

  const timeLimitMin = cli.timeLimitMin ?? config.defaultTimeLimitMin;
  if (!Number.isFinite(timeLimitMin) || timeLimitMin < 1 || timeLimitMin > 24 * 60) {
    errors.push("time-limit-min must be from 1 to 1440.");
  }

  const minRuntimeMin = cli.minRuntimeMin ?? config.defaultMinRuntimeMin;
  if (!Number.isFinite(minRuntimeMin) || minRuntimeMin < 0 || minRuntimeMin > 24 * 60) {
    errors.push("min-runtime-min must be from 0 to 1440.");
  } else if (Number.isFinite(timeLimitMin) && minRuntimeMin > timeLimitMin) {
    errors.push("min-runtime-min cannot be greater than time-limit-min.");
  }

  const mode = cli.mode ?? config.mode;
  if (!isMode(mode)) {
    errors.push("mode must be one of tui, headless, manual.");
  }

  const landing = cli.landing ?? config.landing;
  if (!isLandingMode(landing)) {
    errors.push("landing must be hard or soft.");
  }

  const refreshIntervalSec = cli.refreshIntervalSec ?? config.refreshIntervalSec;
  if (!Number.isFinite(refreshIntervalSec) || refreshIntervalSec < 1 || refreshIntervalSec > 60) {
    errors.push("refresh-interval-sec must be from 1 to 60.");
  }

  const testCommand = cli.testCommand ?? config.testCommand;
  const buildCommand = cli.buildCommand ?? config.buildCommand;

  if ((cli.dryRun ?? false) && (cli.autoCommit ?? config.autoCommit)) {
    warnings.push("dry-run disables automatic commit for this run.");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    value: errors.length
      ? undefined
      : {
          goal,
          rounds,
          minRounds,
          timeLimitMin,
          minRuntimeMin,
          mode,
          landing,
          refreshIntervalSec,
          autoCommit: (cli.dryRun ?? false) ? false : coerceBoolean(cli.autoCommit, config.autoCommit),
          push: coerceBoolean(cli.push, config.push),
          createBranch: coerceBoolean(cli.createBranch, config.createBranch),
          testCommand,
          buildCommand,
          finalRequirements: cli.finalRequirements ?? config.finalRequirements,
          dryRun: cli.dryRun ?? false,
          noInteractive: cli.noInteractive ?? false
        }
  };
}
