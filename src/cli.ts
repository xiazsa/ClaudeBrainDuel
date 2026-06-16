#!/usr/bin/env node
import { parseCliArgs } from "./arg_parser";
import { initProject, loadConfig } from "./config";
import { Orchestrator } from "./orchestrator";
import { Tui } from "./tui";
import { CliOptions } from "./types";
import { resolveRunOptions } from "./validator";

export { parseCliArgs } from "./arg_parser";

async function main(): Promise<void> {
  const cwd = process.cwd();
  const cli = parseCliArgs(process.argv.slice(2));

  if (cli.command === "help") {
    printHelp();
    return;
  }

  if (cli.command === "init") {
    const result = await initProject(cwd);
    console.log("ClaudeBrainDuel initialized.");
    printList("created", result.created);
    printList("skipped", result.skipped);
    printList("checks", result.checks);
    printList("warnings", result.warnings);
    return;
  }

  const loaded = loadConfig(cwd);
  for (const warning of loaded.warnings) console.warn(`warning: ${warning}`);
  for (const error of loaded.errors) console.warn(`config warning: ${error}`);

  const mode = cli.mode ?? loaded.config.mode;
  if (cli.command !== "run") {
    const tui = new Tui(cwd, loaded.config, cli);
    await tui.start(Boolean(cli.goal));
    return;
  }

  if (mode === "tui" && !cli.noInteractive) {
    const tui = new Tui(cwd, loaded.config, cli);
    await tui.start(Boolean(cli.goal));
    return;
  }

  const effectiveCli: CliOptions = cli.noInteractive && mode === "tui" ? { ...cli, mode: "headless" } : cli;
  const resolved = resolveRunOptions(loaded.config, effectiveCli);
  if (!resolved.ok || !resolved.value) {
    for (const error of resolved.errors) console.error(`error: ${error}`);
    process.exitCode = 1;
    return;
  }
  for (const warning of resolved.warnings) console.warn(`warning: ${warning}`);

  const orchestrator = new Orchestrator(cwd, loaded.config, resolved.value, {
    onEvent: (event) => {
      const prefix = event.level === "error" ? "error" : event.level;
      console.log(`[${event.timestamp}] ${prefix} ${event.type}: ${event.message}`);
    },
    onChunk: (role, chunk) => {
      const text = chunk.trim();
      if (text) console.log(`[${role}] ${text}`);
    }
  });
  const state = await orchestrator.run();
  console.log(`run_id: ${state.runId}`);
  console.log(`status: ${state.status}`);
  console.log(`run_dir: ${state.runDir}`);
  console.log(`final_report: ${state.reportPath ?? "(not generated)"}`);
  if (state.status === "failed") process.exitCode = 1;
}

function printList(label: string, values: string[]): void {
  if (!values.length) return;
  console.log(`${label}:`);
  for (const value of values) console.log(`  - ${value}`);
}

function printHelp(): void {
  console.log(`ClaudeBrainDuel

Usage:
  cbduel init
  cbduel
  cbduel run "goal" [options]

Options:
  --rounds <n>                 Default: 5
  --min-rounds <n>             Default: 1
  --time-limit-min <n>         Default: 60
  --min-runtime-min <n>        Default: 0
  --mode <tui|headless|manual> Default: tui
  --landing <soft|hard>        Default: soft
  --refresh-interval-sec <n>   Default: 2
  --auto-commit <true|false>   Default: true
  --push <true|false>          Default: false
  --branch <true|false>        Default: true
  --test-command <command>
  --build-command <command>
  --final-requirements <text>
  --dry-run
  --no-interactive

TUI commands:
  /goal <text>, /start, /pause, /resume, /stop [soft|hard]
  /master, /worker, /events, /git, /tests, /report, /help, /exit
`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
