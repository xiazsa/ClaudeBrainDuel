import fs from "node:fs";
import path from "node:path";
import { BusMessage, EventLevel, EventRecord, IterationArtifacts, Role, RunState } from "./types";
import { appendTextFile, ensureDir, makeId, nowIso, readTextFileIfExists, safeJsonStringify, writeTextFile } from "./utils";

export class MessageBus {
  readonly cwd: string;
  readonly runId: string;
  readonly runDir: string;
  readonly busDir: string;
  readonly iterationsDir: string;
  readonly statePath: string;

  constructor(cwd: string, runId: string) {
    this.cwd = cwd;
    this.runId = runId;
    this.runDir = path.join(cwd, ".cbduel", "runs", runId);
    this.busDir = path.join(this.runDir, "bus");
    this.iterationsDir = path.join(this.runDir, "iterations");
    this.statePath = path.join(this.busDir, "state.json");
  }

  initialize(): void {
    ensureDir(this.busDir);
    ensureDir(this.iterationsDir);
    for (const name of ["master_in.jsonl", "master_out.jsonl", "worker_in.jsonl", "worker_out.jsonl", "events.jsonl"]) {
      const filePath = path.join(this.busDir, name);
      if (!fs.existsSync(filePath)) writeTextFile(filePath, "");
    }
  }

  appendMessage(input: Omit<BusMessage, "id" | "timestamp">): BusMessage {
    const message: BusMessage = {
      id: makeId("msg"),
      timestamp: nowIso(),
      ...input
    };
    const fileName =
      input.role === "master"
        ? input.channel === "in"
          ? "master_in.jsonl"
          : "master_out.jsonl"
        : input.role === "worker"
          ? input.channel === "in"
            ? "worker_in.jsonl"
            : "worker_out.jsonl"
          : "events.jsonl";
    appendTextFile(path.join(this.busDir, fileName), `${safeJsonStringify(message, 0)}\n`);
    return message;
  }

  event(level: EventLevel, type: string, message: string, data?: unknown): EventRecord {
    const record: EventRecord = {
      id: makeId("evt"),
      timestamp: nowIso(),
      level,
      type,
      message,
      data
    };
    appendTextFile(path.join(this.busDir, "events.jsonl"), `${safeJsonStringify(record, 0)}\n`);
    return record;
  }

  writeState(state: RunState): void {
    writeTextFile(this.statePath, `${safeJsonStringify(state)}\n`);
  }

  readState(): RunState | undefined {
    try {
      if (!fs.existsSync(this.statePath)) return undefined;
      return JSON.parse(fs.readFileSync(this.statePath, "utf8")) as RunState;
    } catch {
      return undefined;
    }
  }

  iterationArtifacts(iteration: number): IterationArtifacts {
    const name = String(iteration).padStart(3, "0");
    const dir = path.join(this.iterationsDir, name);
    ensureDir(dir);
    return {
      iteration,
      dir,
      masterPromptPath: path.join(dir, "master_prompt.md"),
      masterOutputPath: path.join(dir, "master_output.md"),
      workerPromptPath: path.join(dir, "worker_prompt.md"),
      workerOutputPath: path.join(dir, "worker_output.md"),
      gitStatusPath: path.join(dir, "git_status.txt"),
      gitDiffPath: path.join(dir, "git_diff.patch"),
      testLogPath: path.join(dir, "test_log.txt"),
      buildLogPath: path.join(dir, "build_log.txt"),
      reviewPath: path.join(dir, "review.md"),
      commitPath: path.join(dir, "commit.txt"),
      iterationLogPath: path.join(dir, "iteration_log.txt")
    };
  }

  pathForView(view: string): string | undefined {
    switch (view) {
      case "master":
        return path.join(this.busDir, "master_out.jsonl");
      case "worker":
        return path.join(this.busDir, "worker_out.jsonl");
      case "events":
        return path.join(this.busDir, "events.jsonl");
      case "report":
        return path.join(this.runDir, "final_report.md");
      default:
        return undefined;
    }
  }

  readView(view: string): string {
    const filePath = this.pathForView(view);
    return filePath ? readTextFileIfExists(filePath) : "";
  }

  writeArtifact(filePath: string, content: string): void {
    writeTextFile(filePath, content);
  }
}
