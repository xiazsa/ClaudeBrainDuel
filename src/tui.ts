import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parsePastedCbduelCommand } from "./arg_parser";
import { CbduelConfig, CliOptions, EventRecord, LandingMode, RunState } from "./types";
import { Orchestrator } from "./orchestrator";
import { resolveRunOptions } from "./validator";
import { formatDurationMs, readTextFileIfExists, tailLines, truncateText } from "./utils";

type ViewName = "master" | "worker" | "events" | "git" | "tests" | "report";

interface JsonLineRecord {
  timestamp?: string;
  level?: string;
  type?: string;
  message?: string;
  role?: string;
  iteration?: number;
  channel?: string;
  kind?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  data?: unknown;
}

export class Tui {
  private rl?: readline.Interface;
  private orchestrator?: Orchestrator;
  private state?: RunState;
  private currentView: ViewName = "events";
  private goal = "";
  private runCliOverrides: CliOptions = {};
  private running = false;
  private lastNotice = "输入一句目标会直接开始；参数写法见下方，或输入 /help。";
  private renderTimer?: NodeJS.Timeout;
  private refreshInterval?: NodeJS.Timeout;
  private readonly events: EventRecord[] = [];
  private readonly live: Record<string, string[]> = {
    master: [],
    worker: [],
    tests: [],
    build: []
  };
  private refreshIntervalSec: number;
  private refreshIntervalMs: number;
  private lastRenderAt = 0;

  constructor(
    private readonly cwd: string,
    private readonly config: CbduelConfig,
    private readonly baseCli: CliOptions
  ) {
    this.goal = baseCli.goal ?? "";
    this.refreshIntervalSec = 2;
    this.refreshIntervalMs = 2000;
    this.configureRefreshInterval(baseCli.refreshIntervalSec ?? config.refreshIntervalSec);
  }

  async start(autoStart = false): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "cbduel> "
    });

    this.rl.on("line", (line) => {
      void this.handleLine(line.trim());
    });
    this.rl.on("close", () => {
      if (this.running) this.orchestrator?.stop("hard");
      if (this.renderTimer) clearTimeout(this.renderTimer);
      if (this.refreshInterval) clearInterval(this.refreshInterval);
      process.stdout.write("\n");
    });

    this.refreshInterval = setInterval(() => {
      if (this.running) this.scheduleRender();
    }, this.refreshIntervalMs);

    this.scheduleRender(true);
    if (autoStart && this.goal) {
      await this.startRun();
    }

    return new Promise((resolve) => {
      this.rl?.once("close", resolve);
    });
  }

  private async handleLine(line: string): Promise<void> {
    if (!line) {
      this.scheduleRender();
      return;
    }

    if (!line.startsWith("/")) {
      const pasted = parsePastedCbduelCommand(line);
      if (pasted) {
        if (this.running) {
          this.lastNotice = "检测到完整 cbduel run 命令，但当前已有运行。请先输入 /stop soft 或 /stop hard，停止后再粘贴这条命令。";
          this.scheduleRender(true);
          return;
        }
        if (pasted.command && pasted.command !== "run") {
          this.lastNotice = "主控窗口里只支持粘贴 cbduel run ... 命令；cbduel init 请在外部命令行运行。";
          this.scheduleRender(true);
          return;
        }
        this.runCliOverrides = pasted;
        this.configureRefreshInterval(pasted.refreshIntervalSec ?? this.baseCli.refreshIntervalSec ?? this.config.refreshIntervalSec);
        this.goal = pasted.goal ?? "";
        this.lastNotice = "已识别并解析完整 cbduel run 命令，正在按其中的参数启动。";
        await this.startRun();
        return;
      }
      this.runCliOverrides = {};
      this.configureRefreshInterval(this.baseCli.refreshIntervalSec ?? this.config.refreshIntervalSec);
      this.goal = line;
      this.lastNotice = "Goal set. Starting run.";
      await this.startRun();
      return;
    }

    const [commandRaw, ...rest] = line.slice(1).split(" ");
    const command = commandRaw.toLowerCase();
    const arg = rest.join(" ").trim();

    switch (command) {
      case "goal":
        if (!arg) this.lastNotice = "用法：/goal 你现在从零开始制作一个“想象力不设限”的贪吃蛇游戏。";
        else {
          this.goal = arg;
          this.lastNotice = "目标已更新。输入 /start 开始。";
        }
        break;
      case "start":
        await this.startRun();
        break;
      case "pause":
        this.orchestrator?.pause();
        this.lastNotice = "Pause requested.";
        break;
      case "resume":
        this.orchestrator?.resume();
        this.lastNotice = "Resumed.";
        break;
      case "stop":
        {
          const landing = parseLandingArg(arg);
          if (arg && !landing) {
            this.lastNotice = "用法：/stop soft 或 /stop hard";
          } else {
            const mode = landing ?? this.defaultLandingMode();
            this.orchestrator?.stop(mode);
            this.lastNotice =
              mode === "hard"
                ? "已请求硬着陆：当前 Claude 进程会被中断。"
                : "已请求软着陆：当前轮完成后停止。";
          }
        }
        break;
      case "params":
        this.lastNotice = renderParameterGuide(this.refreshIntervalSec);
        break;
      case "master":
      case "m":
        this.currentView = "master";
        this.lastNotice = "正在查看 Master 主脑：规划、验收和是否继续。";
        break;
      case "worker":
      case "w":
        this.currentView = "worker";
        this.lastNotice = "正在查看 Worker 副脑：读文件、改代码、跑测试的具体过程。";
        break;
      case "events":
      case "e":
        this.currentView = "events";
        this.lastNotice = "Showing readable event timeline.";
        break;
      case "git":
      case "g":
        this.currentView = "git";
        this.lastNotice = "Showing Git status and diff.";
        break;
      case "tests":
      case "t":
        this.currentView = "tests";
        this.lastNotice = "Showing test/build logs.";
        break;
      case "report":
      case "r":
        this.currentView = "report";
        this.lastNotice = "Showing final report.";
        break;
      case "help":
      case "?":
        this.lastNotice = renderParameterGuide(this.refreshIntervalSec);
        break;
      case "exit":
      case "quit":
      case "q":
        this.orchestrator?.stop("hard");
        this.rl?.close();
        return;
      default:
        this.lastNotice = `Unknown command: /${command}. Type /help.`;
        break;
    }
    this.scheduleRender(true);
  }

  private async startRun(): Promise<void> {
    if (this.running) {
      this.lastNotice = "A run is already active. Use /stop first, or wait for completion.";
      this.scheduleRender(true);
      return;
    }

    const resolved = resolveRunOptions(this.config, {
      ...this.baseCli,
      ...this.runCliOverrides,
      goal: this.goal,
      mode: "tui"
    });
    if (!resolved.ok || !resolved.value) {
      this.lastNotice = resolved.errors.join("\n");
      this.scheduleRender(true);
      return;
    }

    this.running = true;
    this.currentView = "events";
    for (const key of Object.keys(this.live)) this.live[key] = [];

    this.orchestrator = new Orchestrator(this.cwd, this.config, resolved.value, {
      onState: (state) => {
        this.state = state;
        this.autoFocusActiveAgent(state);
        this.scheduleRender();
      },
      onEvent: (event) => {
        this.events.push(event);
        this.lastNotice = `${event.level}: ${event.message}`;
        this.scheduleRender();
      },
      onChunk: (role, chunk) => {
        this.pushLiveChunk(role, chunk);
        this.scheduleRender();
      }
    });
    this.state = this.orchestrator.getState();
    this.scheduleRender(true);

    this.orchestrator
      .run()
      .then((state) => {
        this.state = state;
        this.running = false;
        this.currentView = "report";
        this.lastNotice = `Run finished. final_report: ${state.reportPath ?? "(none)"}`;
        this.scheduleRender();
      })
      .catch((error) => {
        this.running = false;
        this.lastNotice = `Run failed: ${error instanceof Error ? error.message : String(error)}`;
        this.scheduleRender();
      });
  }

  private autoFocusActiveAgent(state: RunState): void {
    if (!this.running) return;
    if (state.masterStatus === "planning" || state.masterStatus === "reviewing") this.currentView = "master";
    else if (state.workerStatus === "working") this.currentView = "worker";
  }

  private pushLiveChunk(role: string, chunk: string): void {
    const key = role === "build" || role === "tests" || role === "worker" || role === "master" ? role : "events";
    if (!this.live[key]) this.live[key] = [];
    this.live[key].push(chunk);
    if (this.live[key].length > 80) this.live[key] = this.live[key].slice(-80);
  }

  private scheduleRender(force = false): void {
    if (this.renderTimer) {
      if (!force) return;
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    const elapsed = Date.now() - this.lastRenderAt;
    const delay = force ? 0 : Math.max(100, this.refreshIntervalMs - elapsed);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, delay);
  }

  private render(): void {
    this.lastRenderAt = Date.now();
    const out = process.stdout;
    out.write("\x1Bc");
    out.write("ClaudeBrainDuel 主控窗口\n");
    out.write("=".repeat(88) + "\n");
    out.write(`cwd:  ${this.cwd}\n`);
    out.write(`goal: ${this.goal || "(not set)"}\n`);

    const state = this.state;
    if (state) {
      out.write(`run:  ${state.runId} | ${state.mode} | ${state.status} | view=${this.currentView}\n`);
      out.write(
        `time: elapsed=${formatDurationMs(Date.now() - Date.parse(state.startedAt))} | left=${formatDurationMs(Math.max(0, Date.parse(state.deadlineAt) - Date.now()))}\n`
      );
      out.write(
        `round: ${state.iteration}/${state.maxRounds} | min=${state.minRounds} | remaining=${state.remainingRounds} | branch=${state.branch}\n`
      );
      out.write(`landing: ${state.landing} | minRuntime=${state.minRuntimeMin}m | refresh=${state.refreshIntervalSec}s\n`);
      out.write(`agents: Master=${state.masterStatus} | Worker=${state.workerStatus}\n`);
      out.write(`checks: Git=${state.gitStatus} | Tests=${state.testStatus} | Build=${state.buildStatus}\n`);
      out.write(`logs: ${state.logPath}\n`);
      if (state.reportPath) out.write(`report: ${state.reportPath}\n`);
    } else {
      out.write("run:  idle\n");
    }

    out.write("-".repeat(88) + "\n");
    out.write(`${this.lastNotice}\n`);
    out.write("-".repeat(88) + "\n");
    out.write(this.renderCurrentView());
    out.write("\n" + "-".repeat(88) + "\n");
    out.write("Commands: /master /worker /events /git /tests /report /pause /resume /stop [soft|hard] /params /help /exit\n");
    this.rl?.prompt();
  }

  private defaultLandingMode(): LandingMode {
    return this.runCliOverrides.landing ?? this.baseCli.landing ?? this.config.landing ?? "soft";
  }

  private configureRefreshInterval(value: unknown): void {
    this.refreshIntervalSec = normalizeRefreshInterval(value);
    this.refreshIntervalMs = this.refreshIntervalSec * 1000;
    if (!this.rl) return;
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.refreshInterval = setInterval(() => {
      if (this.running) this.scheduleRender();
    }, this.refreshIntervalMs);
  }

  private renderCurrentView(): string {
    const state = this.state;
    if (!state) return renderStartupGuide(this.refreshIntervalSec);
    switch (this.currentView) {
      case "master":
        return this.renderAgentView("master");
      case "worker":
        return this.renderAgentView("worker");
      case "events":
        return this.renderEventsView();
      case "git":
        return this.tailIterationFiles(["git_status.txt", "git_diff.patch"]);
      case "tests":
        return this.renderTestsView();
      case "report":
        return tailLines(readTextFileIfExists(path.join(state.runDir, "final_report.md")), 100) || "Final report is not ready yet.";
      default:
        return "";
    }
  }

  private renderAgentView(agent: "master" | "worker"): string {
    if (!this.state) return "";
    const iter = this.currentIterationDir();
    const live = this.live[agent].join("");
    const sections: string[] = [];

    if (agent === "master") {
      sections.push("MASTER: plans tasks, reviews Worker output, and decides pass/partial/fail.");
      sections.push(this.renderLatestArtifact("Current prompt sent to Master", path.join(iter, "master_prompt.md"), 45));
      sections.push(this.renderPrettyBus("Latest Master messages", "master_out.jsonl", 6));
      sections.push(this.renderLatestArtifact("Latest Master review", path.join(iter, "review.md"), 60));
    } else {
      sections.push("WORKER: reads the project, edits files, runs checks, and reports concrete changes.");
      sections.push(this.renderLatestArtifact("Current task sent to Worker", path.join(iter, "worker_prompt.md"), 45));
      sections.push(this.renderPrettyBus("Latest Worker messages", "worker_out.jsonl", 6));
      sections.push(this.renderLatestArtifact("Worker raw output artifact", path.join(iter, "worker_output.md"), 70));
    }

    if (live.trim()) {
      sections.push(["Live Claude stream", tailLines(truncateText(live, 12000), 60)].join("\n"));
    } else {
      sections.push("Live Claude stream\n(waiting for output)");
    }

    return sections.filter(Boolean).join("\n\n");
  }

  private renderEventsView(): string {
    if (!this.state) return "";
    const filePath = path.join(this.state.runDir, "bus", "events.jsonl");
    const records = readJsonLines(filePath).slice(-24);
    if (!records.length) return "No events yet.";
    return records.map(formatEventRecord).join("\n");
  }

  private renderPrettyBus(title: string, fileName: string, count: number): string {
    if (!this.state) return `${title}\n(no run)`;
    const filePath = path.join(this.state.runDir, "bus", fileName);
    const records = readJsonLines(filePath).slice(-count);
    if (!records.length) return `${title}\n(no messages yet)`;
    return [title, ...records.map(formatBusRecord)].join("\n");
  }

  private renderTestsView(): string {
    const text = this.tailIterationFiles(["test_log.txt", "build_log.txt"]);
    const live = [this.live.tests.join(""), this.live.build.join("")].filter((item) => item.trim()).join("\n");
    if (!live.trim()) return text;
    return `${text}\n\nLive test/build stream\n${tailLines(truncateText(live, 12000), 60)}`;
  }

  private renderLatestArtifact(title: string, filePath: string, maxLines: number): string {
    const content = readTextFileIfExists(filePath);
    if (!content.trim()) return `${title}\n(not written yet)`;
    return `${title}\n${tailLines(truncateText(content, 14000), maxLines)}`;
  }

  private currentIterationDir(): string {
    if (!this.state || this.state.iteration < 1) return "";
    const iter = String(this.state.iteration).padStart(3, "0");
    return path.join(this.state.runDir, "iterations", iter);
  }

  private tailIterationFiles(fileNames: string[]): string {
    const dir = this.currentIterationDir();
    if (!dir || !fs.existsSync(dir)) return "No iteration artifacts yet.";
    return fileNames
      .map((name) => {
        const filePath = path.join(dir, name);
        return [`# ${name}`, tailLines(readTextFileIfExists(filePath), 80) || "(empty)"].join("\n");
      })
      .join("\n\n");
  }
}

function readJsonLines(filePath: string): JsonLineRecord[] {
  const text = readTextFileIfExists(filePath);
  if (!text.trim()) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as JsonLineRecord;
      } catch {
        return { message: line };
      }
    });
}

function formatEventRecord(record: JsonLineRecord): string {
  const time = formatTime(record.timestamp);
  const level = (record.level ?? "info").toUpperCase().padEnd(5);
  const type = record.type ? ` ${record.type}` : "";
  const data = summarizeData(record.data);
  return `${time} ${level}${type}: ${record.message ?? "(no message)"}${data}`;
}

function formatBusRecord(record: JsonLineRecord): string {
  const time = formatTime(record.timestamp);
  const iter = record.iteration ? `iter ${record.iteration}` : "iter ?";
  const kind = record.kind ?? "message";
  const metadata = record.metadata ? summarizeData(record.metadata) : "";
  const content = cleanContent(record.content ?? record.message ?? "");
  return [`${time} ${iter} ${kind}${metadata}`, indent(tailLines(truncateText(content, 9000), 40))].join("\n");
}

function cleanContent(content: string): string {
  const parsed = tryParseObject(content);
  if (!parsed) return content.trim() || "(empty)";
  const lines: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "id" || key === "timestamp") continue;
    lines.push(`${key}: ${formatValue(value)}`);
  }
  return lines.join("\n") || content.trim();
}

function tryParseObject(content: string): Record<string, unknown> | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => `\n  - ${formatValue(item)}`).join("");
  if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value ?? "");
}

function summarizeData(data: unknown): string {
  if (data === undefined) return "";
  if (typeof data === "string") return ` | ${data}`;
  if (Array.isArray(data)) return ` | ${data.join("; ")}`;
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const useful = Object.entries(record)
      .filter(([key]) => key !== "id" && key !== "runId")
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    return useful ? ` | ${useful}` : "";
  }
  return ` | ${String(data)}`;
}

function formatTime(timestamp: string | undefined): string {
  if (!timestamp) return "--:--:--";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString(undefined, { hour12: false });
}

function indent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function renderStartupGuide(refreshIntervalSec: number): string {
  return [
    "启动方式有两种：",
    "",
    "1. 直接在这里输入一句目标并回车，使用当前配置启动：",
    "   你现在从零开始制作一个“想象力不设限”的贪吃蛇游戏。不要只做普通版本，要尽最大可能发挥想象力：从玩法、视觉、音效、关卡、成长系统、AI敌人、地图机制、剧情、技能、道具、多人模式、物理效果、隐藏彩蛋等角度持续扩展。先实现一个可运行版本，再不断迭代成更有创意、更完整、更惊艳的作品。每次完成一轮开发后，必须输出：1）本轮实现了什么；2）还能如何继续发挥想象力；3）下一轮具体要做什么。无论当前版本多完善，都不允许停止思考下一步创意。",
    "",
    "2. 在命令行启动时带参数：",
    '   cbduel run "你现在从零开始制作一个“想象力不设限”的贪吃蛇游戏。不要只做普通版本，要尽最大可能发挥想象力：从玩法、视觉、音效、关卡、成长系统、AI敌人、地图机制、剧情、技能、道具、多人模式、物理效果、隐藏彩蛋等角度持续扩展。先实现一个可运行版本，再不断迭代成更有创意、更完整、更惊艳的作品。每次完成一轮开发后，必须输出：1）本轮实现了什么；2）还能如何继续发挥想象力；3）下一轮具体要做什么。无论当前版本多完善，都不允许停止思考下一步创意。" --rounds 8 --min-rounds 3 --time-limit-min 60 --min-runtime-min 10 --landing soft --refresh-interval-sec 3',
    "",
    renderParameterGuide(refreshIntervalSec)
  ].join("\n");
}

function renderParameterGuide(refreshIntervalSec: number): string {
  return [
    "中文参数提示：",
    "--rounds 8              最多跑 8 轮，达到目标或用完轮数就结束。",
    "--min-rounds 3          最少跑 3 轮，Master 提前说 pass 也不会马上停。",
    "--time-limit-min 60     最长运行 60 分钟，到时间后不再开启新一轮。",
    "--min-runtime-min 10    最短运行 10 分钟，没到时间不会写最终报告。",
    "--landing soft          软着陆：收到停止请求后，当前这一轮做完再停。",
    "--landing hard          硬着陆：直接中断当前 Claude 调用，尽快保存日志退出。",
    `--refresh-interval-sec ${refreshIntervalSec}    TUI 每 ${refreshIntervalSec} 秒刷新一次，避免每秒刷屏。`,
    "",
    "运行中常用命令：",
    "/master 看主脑，/worker 看副脑，/events 看事件，/tests 看测试，/report 看报告。",
    "/stop soft 做完当前轮再停；/stop hard 立即中断；/params 重新显示本提示。"
  ].join("\n");
}

function normalizeRefreshInterval(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 2;
  return Math.min(60, Math.max(1, parsed));
}

function parseLandingArg(value: string): LandingMode | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized === "hard" || normalized === "soft" ? normalized : undefined;
}
