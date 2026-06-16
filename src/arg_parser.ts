import path from "node:path";
import { CliOptions, LandingMode, Mode } from "./types";
import { coerceBoolean } from "./utils";
import { isLandingMode, isMode } from "./validator";

export function parseCliArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const first = args[0];
  const options: CliOptions = {};
  let positionals: string[] = [];
  let startIndex = 0;

  if (first === "init" || first === "run" || first === "help" || first === "--help" || first === "-h") {
    options.command = first === "--help" || first === "-h" ? "help" : (first as CliOptions["command"]);
    startIndex = 1;
  } else if (first) {
    positionals = [];
  }

  for (let i = startIndex; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const next = args[i + 1];
    const hasValue = next !== undefined && !next.startsWith("--");
    const value = hasValue ? next : "true";
    if (hasValue) i += 1;

    switch (key) {
      case "rounds":
        options.rounds = Number.parseInt(value, 10);
        break;
      case "min-rounds":
        options.minRounds = Number.parseInt(value, 10);
        break;
      case "time-limit-min":
        options.timeLimitMin = Number.parseFloat(value);
        break;
      case "min-runtime-min":
        options.minRuntimeMin = Number.parseFloat(value);
        break;
      case "mode":
        if (isMode(value)) options.mode = value;
        else options.mode = value as Mode;
        break;
      case "landing":
        if (isLandingMode(value)) options.landing = value;
        else options.landing = value as LandingMode;
        break;
      case "refresh-interval-sec":
        options.refreshIntervalSec = Number.parseFloat(value);
        break;
      case "auto-commit":
        options.autoCommit = coerceBoolean(value, true);
        break;
      case "no-auto-commit":
        options.autoCommit = false;
        if (hasValue) i -= 1;
        break;
      case "push":
        options.push = coerceBoolean(value, true);
        break;
      case "no-push":
        options.push = false;
        if (hasValue) i -= 1;
        break;
      case "branch":
        options.createBranch = coerceBoolean(value, true);
        break;
      case "no-branch":
        options.createBranch = false;
        if (hasValue) i -= 1;
        break;
      case "test-command":
        options.testCommand = value;
        break;
      case "build-command":
        options.buildCommand = value;
        break;
      case "final-requirements":
        options.finalRequirements = value;
        break;
      case "dry-run":
        options.dryRun = true;
        if (hasValue) i -= 1;
        break;
      case "no-interactive":
        options.noInteractive = true;
        if (hasValue) i -= 1;
        break;
      case "help":
        options.command = "help";
        if (hasValue) i -= 1;
        break;
      default:
        positionals.push(arg);
        if (hasValue) positionals.push(value);
        break;
    }
  }

  if (positionals.length) {
    options.goal = positionals.join(" ").trim();
  }
  return options;
}

export function splitCommandLine(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoteEnd = "";
  const chars = Array.from(input);

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    const next = chars[i + 1];

    if (quoteEnd) {
      if (char === "\\" && next === quoteEnd) {
        current += next;
        i += 1;
      } else if (char === quoteEnd) {
        quoteEnd = "";
      } else {
        current += char;
      }
      continue;
    }

    const startQuote = quoteCloseFor(char);
    if (startQuote) {
      quoteEnd = startQuote;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);
  return args;
}

export function parsePastedCbduelCommand(input: string): CliOptions | undefined {
  const args = splitCommandLine(input.trim());
  if (!args.length) return undefined;

  const commandName = path.basename(args[0]).toLowerCase();
  if (!["cbduel", "cbduel.cmd", "cbduel.ps1", "cbduel.exe"].includes(commandName)) {
    return undefined;
  }

  return parseCliArgs(args.slice(1));
}

function quoteCloseFor(char: string): string | undefined {
  switch (char) {
    case '"':
      return '"';
    case "'":
      return "'";
    case "“":
      return "”";
    case "‘":
      return "’";
    default:
      return undefined;
  }
}
