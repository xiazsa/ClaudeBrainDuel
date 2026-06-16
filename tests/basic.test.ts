import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePastedCbduelCommand } from "../src/arg_parser";
import { parseCliArgs } from "../src/cli";
import { DEFAULT_CONFIG } from "../src/config";
import { MessageBus } from "../src/message_bus";
import { resolveRunOptions } from "../src/validator";

test("parseCliArgs parses run options", () => {
  const parsed = parseCliArgs([
    "run",
    "build a useful tool",
    "--rounds",
    "8",
    "--mode",
    "headless",
    "--test-command",
    "npm test",
    "--auto-commit",
    "false",
    "--min-rounds",
    "3",
    "--min-runtime-min",
    "5",
    "--landing",
    "hard",
    "--refresh-interval-sec",
    "4"
  ]);

  assert.equal(parsed.command, "run");
  assert.equal(parsed.goal, "build a useful tool");
  assert.equal(parsed.rounds, 8);
  assert.equal(parsed.mode, "headless");
  assert.equal(parsed.testCommand, "npm test");
  assert.equal(parsed.autoCommit, false);
  assert.equal(parsed.minRounds, 3);
  assert.equal(parsed.minRuntimeMin, 5);
  assert.equal(parsed.landing, "hard");
  assert.equal(parsed.refreshIntervalSec, 4);
});

test("parsePastedCbduelCommand parses full command pasted into TUI", () => {
  const parsed = parsePastedCbduelCommand(
    'cbduel.cmd run "imaginary snake" --mode tui --rounds 50 --min-rounds 50 --time-limit-min 480 --min-runtime-min 420 --landing soft --refresh-interval-sec 5 --auto-commit true --branch true'
  );

  assert.equal(parsed?.command, "run");
  assert.equal(parsed?.goal, "imaginary snake");
  assert.equal(parsed?.rounds, 50);
  assert.equal(parsed?.minRounds, 50);
  assert.equal(parsed?.timeLimitMin, 480);
  assert.equal(parsed?.minRuntimeMin, 420);
  assert.equal(parsed?.landing, "soft");
  assert.equal(parsed?.refreshIntervalSec, 5);
  assert.equal(parsed?.autoCommit, true);
  assert.equal(parsed?.createBranch, true);
});

test("resolveRunOptions rejects empty goals and invalid rounds", () => {
  const resolved = resolveRunOptions(DEFAULT_CONFIG, { goal: "", rounds: 0 });
  assert.equal(resolved.ok, false);
  assert.match(resolved.errors.join("\n"), /Goal is empty/);
  assert.match(resolved.errors.join("\n"), /rounds/);
});

test("MessageBus creates required bus files and state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cbduel-test-"));
  const bus = new MessageBus(dir, "run-test");
  bus.initialize();
  bus.event("info", "test", "hello");
  bus.writeState({
    runId: "run-test",
    goal: "goal",
    mode: "headless",
    status: "running",
    currentView: "events",
    iteration: 1,
    maxRounds: 5,
    minRounds: 1,
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    deadlineAt: new Date(1).toISOString(),
    minRuntimeMin: 0,
    landing: "soft",
    refreshIntervalSec: 2,
    remainingRounds: 4,
    branch: "main",
    masterStatus: "ok",
    workerStatus: "ok",
    gitStatus: "ok",
    testStatus: "ok",
    buildStatus: "ok",
    runDir: bus.runDir,
    logPath: path.join(bus.busDir, "events.jsonl")
  });

  assert.equal(fs.existsSync(path.join(bus.busDir, "master_in.jsonl")), true);
  assert.equal(fs.existsSync(path.join(bus.busDir, "worker_out.jsonl")), true);
  assert.equal(fs.existsSync(path.join(bus.busDir, "events.jsonl")), true);
  assert.equal(bus.iterationArtifacts(1).iterationLogPath.endsWith(path.join("001", "iteration_log.txt")), true);
  assert.equal(bus.readState()?.runId, "run-test");
});
