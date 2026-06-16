import path from "node:path";
import { ClaudeRunner } from "./claude_runner";
import { runProcess, runShellCommand } from "./command_runner";
import {
  CbduelConfig,
  EventRecord,
  IterationArtifacts,
  IterationSummary,
  LandingMode,
  ResolvedRunOptions,
  ReviewResult,
  RunState
} from "./types";
import { GitManager } from "./git_manager";
import { MessageBus } from "./message_bus";
import { PromptBuilder } from "./prompt_builder";
import {
  coerceBoolean,
  coerceString,
  formatDurationMs,
  makeId,
  nowIso,
  parseJsonObjectFromText,
  redactSensitive,
  safeJsonStringify,
  tailLines,
  truncateText,
  writeTextFile
} from "./utils";

export interface OrchestratorCallbacks {
  onEvent?: (event: EventRecord) => void;
  onState?: (state: RunState) => void;
  onChunk?: (role: string, chunk: string) => void;
}

export class Orchestrator {
  readonly runId: string;
  readonly bus: MessageBus;
  private readonly git: GitManager;
  private readonly prompts = new PromptBuilder();
  private readonly summaries: IterationSummary[] = [];
  private paused = false;
  private stopRequested = false;
  private requestedLandingMode: LandingMode;
  private state: RunState;
  private lastGitStatus = "";
  private lastGitDiff = "";
  private lastTestLog = "";
  private lastBuildLog = "";
  private previousSummary = "No previous iteration.";
  private commitOutputs: string[] = [];
  private abortController = new AbortController();

  constructor(
    private readonly cwd: string,
    private readonly config: CbduelConfig,
    private readonly options: ResolvedRunOptions,
    private readonly callbacks: OrchestratorCallbacks = {}
  ) {
    this.runId = makeId("run");
    this.requestedLandingMode = options.landing;
    this.bus = new MessageBus(cwd, this.runId);
    this.git = new GitManager(cwd);
    const startedAt = nowIso();
    const deadlineAt = new Date(Date.now() + options.timeLimitMin * 60_000).toISOString();
    this.state = {
      runId: this.runId,
      goal: options.goal,
      mode: options.mode,
      status: "idle",
      currentView: "events",
      iteration: 0,
      maxRounds: options.rounds,
      minRounds: options.minRounds,
      startedAt,
      updatedAt: startedAt,
      deadlineAt,
      minRuntimeMin: options.minRuntimeMin,
      landing: options.landing,
      refreshIntervalSec: options.refreshIntervalSec,
      remainingRounds: options.rounds,
      branch: "(unknown)",
      masterStatus: "idle",
      workerStatus: "idle",
      gitStatus: "idle",
      testStatus: "idle",
      buildStatus: "idle",
      runDir: this.bus.runDir,
      logPath: path.join(this.bus.busDir, "events.jsonl")
    };
  }

  getState(): RunState {
    return { ...this.state };
  }

  pause(): void {
    this.paused = true;
    this.updateState({ status: "paused" });
    this.emit("info", "run_paused", "Run paused.");
  }

  resume(): void {
    this.paused = false;
    this.updateState({ status: "running" });
    this.emit("info", "run_resumed", "Run resumed.");
  }

  stop(landing: LandingMode = this.options.landing): void {
    this.stopRequested = true;
    this.requestedLandingMode = landing;
    if (landing === "hard") {
      this.abortController.abort();
    }
    this.updateState({ status: "stopping" });
    this.emit(
      "warn",
      landing === "hard" ? "run_stopping_hard" : "run_stopping_soft",
      landing === "hard"
        ? "Hard stop requested; active Claude process will be aborted."
        : "Soft stop requested; current iteration will finish before exit."
    );
  }

  async run(): Promise<RunState> {
    this.bus.initialize();
    this.updateState({ status: this.options.mode === "manual" ? "manual" : "running" });
    this.emit("info", "run_started", "ClaudeBrainDuel run started.", {
      runId: this.runId,
      mode: this.options.mode,
      runDir: this.bus.runDir
    });

    try {
      await this.prepareGit();
      if (this.options.mode === "manual") {
        await this.manualFallback("manual mode requested");
        return this.state;
      }

      const claude = new ClaudeRunner(this.config.claude.command);
      if (this.options.dryRun) {
        this.emit("warn", "dry_run", "Dry run enabled; Claude, commits and push are disabled.");
      } else {
        const preflightOk = await this.preflightClaude();
        if (!preflightOk) {
          await this.manualFallback("Claude non-interactive preflight failed. Open this folder with interactive `claude` once, confirm workspace trust, verify login, then rerun cbduel.");
          return this.state;
        }
      }

      for (let iteration = 1; iteration <= this.options.rounds; iteration += 1) {
        if (this.stopRequested) break;
        if (Date.now() > Date.parse(this.state.deadlineAt)) {
          this.emit("warn", "time_limit", "Time limit reached before starting next iteration.");
          break;
        }
        await this.waitIfPaused();
        if (this.stopRequested) break;

        const summary = await this.runIteration(iteration, claude);
        this.summaries.push(summary);
        this.previousSummary = this.formatIterationSummary(summary);

        if (summary.errors.length) {
          this.emit("warn", "iteration_errors", `Iteration ${iteration} had recoverable errors.`, summary.errors);
        }
        if (summary.reviewDecision === "pass") {
          const unmetMinimums = this.unmetMinimums();
          if (!unmetMinimums.length) {
            this.emit("info", "goal_passed", `Master accepted the result at iteration ${iteration}.`);
            break;
          }
          this.emit("info", "minimums_not_met", "Master accepted the result, but minimum run requirements are not met yet.", {
            unmet: unmetMinimums,
            completedRounds: this.summaries.length,
            minRounds: this.options.minRounds,
            minRuntimeMin: this.options.minRuntimeMin
          });
        }
      }

      await this.waitForMinimumRuntimeIfNeeded();

      if (this.options.push && !this.options.dryRun) {
        await this.pushBranch();
      }

      const reportPath = await this.writeFinalReport(this.stopRequested ? "stopped" : "completed");
      this.updateState({ status: this.stopRequested ? "completed" : "completed", reportPath });
      this.emit("info", "run_completed", "Run completed.", { reportPath });
      return this.state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit("error", "run_failed", message);
      const reportPath = await this.writeFinalReport("failed", [message]);
      this.updateState({ status: "failed", lastError: message, reportPath });
      return this.state;
    }
  }

  private async prepareGit(): Promise<void> {
    this.updateState({ gitStatus: "checking" });
    const gitAvailable = await this.git.isGitAvailable();
    if (!gitAvailable) {
      this.updateState({ gitStatus: "git unavailable", branch: "(no git)" });
      this.emit("error", "git_unavailable", "git command is not available; branch and commit automation disabled.");
      return;
    }

    const isRepo = await this.git.isRepository();
    if (!isRepo) {
      this.updateState({ gitStatus: "not a git repo", branch: "(no repo)" });
      this.emit("error", "git_not_repo", "Current directory is not a Git repository; branch and commit automation disabled.");
      return;
    }

    if (this.options.createBranch && !this.options.dryRun) {
      const created = await this.git.createBranchForGoal(this.options.goal);
      this.updateState({ branch: created.branch, gitStatus: created.ok ? "branch created" : "branch create failed" });
      this.emit(created.ok ? "info" : "warn", "git_branch", created.ok ? `Created branch ${created.branch}.` : "Branch creation failed.", {
        output: created.output
      });
    } else {
      const branch = await this.git.currentBranch();
      this.updateState({ branch, gitStatus: "ready" });
    }
  }

  private async preflightClaude(): Promise<boolean> {
    this.emit("info", "claude_preflight_started", "Checking Claude Code non-interactive mode in this workspace.");
    const result = await runProcess(
      this.config.claude.command,
      ["-p", "--output-format", "json", "--permission-mode", "default", "--tools", "", "--no-session-persistence"],
      {
        cwd: this.cwd,
        timeoutMs: 45_000,
        input: "Reply exactly with: ok",
        signal: this.abortController.signal,
        onStdout: (chunk) => this.callbacks.onChunk?.("master", chunk),
        onStderr: (chunk) => this.callbacks.onChunk?.("master", chunk)
      }
    );

    if (result.ok && /"result"\s*:\s*"ok"|(^|\s)ok(\s|$)/i.test(result.combined)) {
      this.emit("info", "claude_preflight_done", "Claude Code non-interactive mode is available.", {
        durationMs: result.durationMs
      });
      return true;
    }

    const output = redactSensitive(result.combined || result.errorMessage || "");
    const likelyTrustOrAuth = /trust this folder|workspace|login|auth|authentication|api key|not authenticated/i.test(output);
    this.emit("error", "claude_preflight_failed", "Claude Code non-interactive preflight failed.", {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      likelyTrustOrAuth,
      output
    });
    return false;
  }

  private async runIteration(iteration: number, claude: ClaudeRunner): Promise<IterationSummary> {
    const artifacts = this.bus.iterationArtifacts(iteration);
    const iterationStartedAt = nowIso();
    const errors: string[] = [];
    this.updateState({
      iteration,
      remainingRounds: this.options.rounds - iteration,
      masterStatus: "planning",
      workerStatus: "waiting",
      testStatus: "waiting",
      buildStatus: "waiting"
    });
    this.emit("info", "iteration_started", `Iteration ${iteration} started.`);

    this.lastGitStatus = await this.safeGitStatus(errors);
    this.lastGitDiff = await this.safeGitDiff(errors);

    const masterPrompt = this.prompts.buildMasterPlan({
      goal: this.options.goal,
      iteration,
      maxRounds: this.options.rounds,
      finalRequirements: this.options.finalRequirements,
      qualityBar: this.config.qualityBar,
      previousSummary: this.previousSummary,
      gitStatus: truncateText(this.lastGitStatus),
      gitDiff: truncateText(this.lastGitDiff),
      testLog: truncateText(tailLines(this.lastTestLog, 200)),
      buildLog: truncateText(tailLines(this.lastBuildLog, 200))
    });
    this.bus.writeArtifact(artifacts.masterPromptPath, masterPrompt);
    this.bus.appendMessage({
      role: "master",
      iteration,
      channel: "in",
      kind: "master_plan_prompt",
      content: masterPrompt
    });

    this.emit("info", "claude_master_started", `Calling Claude Master for iteration ${iteration} planning.`);
    const masterHeartbeat = this.startStepHeartbeat("claude_master_progress", "Claude Master planning");
    const master = await claude.run({
      role: "master",
      prompt: masterPrompt,
      cwd: this.cwd,
      outputFormat: "stream-json",
      allowedTools: [],
      timeoutMs: Math.min(this.config.claude.timeoutMs, 90_000),
      maxRetries: this.config.claude.maxRetries,
      permissionMode: "default",
      dryRun: this.options.dryRun,
      signal: this.abortController.signal,
      onChunk: (chunk) => this.callbacks.onChunk?.("master", chunk)
    });
    clearInterval(masterHeartbeat);
    this.emit(master.ok ? "info" : "warn", master.ok ? "claude_master_done" : "claude_master_failed", master.ok ? "Claude Master planning returned." : `Claude Master planning failed: ${master.errorKind ?? "unknown"}.`, {
      durationMs: master.durationMs,
      attempts: master.attempts,
      error: master.errorMessage
    });
    this.bus.writeArtifact(artifacts.masterOutputPath, formatClaudeOutput(master.text, master.raw));
    this.bus.appendMessage({
      role: "master",
      iteration,
      channel: "out",
      kind: master.ok ? "master_plan" : "master_plan_error",
      content: master.text || master.raw,
      metadata: { ok: master.ok, errorKind: master.errorKind, errorMessage: master.errorMessage }
    });
    if (!master.ok) {
      errors.push(`Master planning failed: ${master.errorKind ?? "unknown"} ${master.errorMessage ?? ""}`.trim());
      this.emit("warn", "claude_master_error", `Master planning degraded: ${master.errorKind ?? "unknown"}.`, {
        error: master.errorMessage
      });
      if (master.errorKind === "missing_command" || master.errorKind === "auth") {
        await this.manualFallback(`Claude unavailable during Master planning: ${master.errorMessage ?? master.errorKind}`);
        const summary = this.emptySummary(iteration, errors, "fail");
        this.writeIterationLog(artifacts, summary, "", iterationStartedAt);
        return summary;
      }
    }

    if (this.shouldStopImmediately()) {
      errors.push("Hard stop requested during Master planning.");
      const summary = this.emptySummary(iteration, errors, "fail");
      this.writeIterationLog(artifacts, summary, "", iterationStartedAt);
      return summary;
    }

    const task = parseMasterPlan(master.text);
    this.updateState({ masterStatus: "planned", workerStatus: "working" });

    const workerPrompt = this.prompts.buildWorkerTask({
      goal: this.options.goal,
      iteration,
      maxRounds: this.options.rounds,
      task: task.workerTask,
      acceptanceCriteria: task.acceptanceCriteria.join("\n"),
      finalRequirements: this.options.finalRequirements,
      qualityBar: this.config.qualityBar
    });
    this.bus.writeArtifact(artifacts.workerPromptPath, workerPrompt);
    this.bus.appendMessage({
      role: "worker",
      iteration,
      channel: "in",
      kind: "worker_task_prompt",
      content: workerPrompt
    });

    this.emit("info", "claude_worker_started", `Calling Claude Worker for iteration ${iteration} implementation.`);
    const workerHeartbeat = this.startStepHeartbeat("claude_worker_progress", "Claude Worker implementation");
    const worker = await claude.run({
      role: "worker",
      prompt: workerPrompt,
      cwd: this.cwd,
      outputFormat: "stream-json",
      allowedTools: this.config.claude.allowedTools,
      timeoutMs: this.remainingStepTimeoutMs(),
      maxRetries: this.config.claude.maxRetries,
      permissionMode: this.config.claude.permissionMode,
      dryRun: this.options.dryRun,
      signal: this.abortController.signal,
      onChunk: (chunk) => this.callbacks.onChunk?.("worker", chunk)
    });
    clearInterval(workerHeartbeat);
    this.emit(worker.ok ? "info" : "warn", worker.ok ? "claude_worker_done" : "claude_worker_failed", worker.ok ? "Claude Worker returned." : `Claude Worker failed: ${worker.errorKind ?? "unknown"}.`, {
      durationMs: worker.durationMs,
      attempts: worker.attempts,
      error: worker.errorMessage
    });
    this.bus.writeArtifact(artifacts.workerOutputPath, formatClaudeOutput(worker.text, worker.raw));
    this.bus.appendMessage({
      role: "worker",
      iteration,
      channel: "out",
      kind: worker.ok ? "worker_result" : "worker_error",
      content: worker.text || worker.raw,
      metadata: { ok: worker.ok, errorKind: worker.errorKind, errorMessage: worker.errorMessage }
    });
    if (!worker.ok) {
      errors.push(`Worker failed: ${worker.errorKind ?? "unknown"} ${worker.errorMessage ?? ""}`.trim());
      this.emit("warn", "claude_worker_error", `Worker degraded: ${worker.errorKind ?? "unknown"}.`, {
        error: worker.errorMessage
      });
    }
    if (!(worker.text || worker.raw).trim()) {
      errors.push("Worker output was empty.");
    }

    if (this.shouldStopImmediately()) {
      errors.push("Hard stop requested during Worker implementation.");
      const summary: IterationSummary = {
        iteration,
        masterSummary: task.summary,
        workerSummary: parseWorkerSummary(worker.text || worker.raw),
        reviewDecision: "fail",
        reviewSummary: "Hard stop requested before Master review.",
        errors
      };
      this.writeIterationLog(artifacts, summary, "", iterationStartedAt);
      return summary;
    }

    this.updateState({ workerStatus: worker.ok ? "done" : "error", gitStatus: "collecting" });
    this.lastGitStatus = await this.safeGitStatus(errors);
    this.lastGitDiff = await this.safeGitDiff(errors);
    this.bus.writeArtifact(artifacts.gitStatusPath, this.lastGitStatus);
    this.bus.writeArtifact(artifacts.gitDiffPath, this.lastGitDiff);

    const testOk = await this.runConfiguredCommand("tests", this.options.testCommand, artifacts.testLogPath, errors);
    const buildOk = await this.runConfiguredCommand("build", this.options.buildCommand, artifacts.buildLogPath, errors);

    if (this.shouldStopImmediately()) {
      errors.push("Hard stop requested before Master review.");
      const summary: IterationSummary = {
        iteration,
        masterSummary: task.summary,
        workerSummary: parseWorkerSummary(worker.text || worker.raw),
        reviewDecision: "fail",
        reviewSummary: "Hard stop requested before Master review.",
        testOk,
        buildOk,
        errors
      };
      this.writeIterationLog(artifacts, summary, "", iterationStartedAt);
      return summary;
    }

    this.updateState({ masterStatus: "reviewing" });
    const reviewPrompt = this.prompts.buildMasterReview({
      goal: this.options.goal,
      iteration,
      maxRounds: this.options.rounds,
      workerOutput: truncateText(worker.text || worker.raw),
      gitStatus: truncateText(this.lastGitStatus),
      gitDiff: truncateText(this.lastGitDiff),
      testLog: truncateText(tailLines(this.lastTestLog, 240)),
      buildLog: truncateText(tailLines(this.lastBuildLog, 240)),
      finalRequirements: this.options.finalRequirements
    });

    this.emit("info", "claude_review_started", `Calling Claude Master for iteration ${iteration} review.`);
    const reviewHeartbeat = this.startStepHeartbeat("claude_review_progress", "Claude Master review");
    const review = await claude.run({
      role: "master",
      prompt: reviewPrompt,
      cwd: this.cwd,
      outputFormat: "stream-json",
      allowedTools: [],
      timeoutMs: Math.min(this.config.claude.timeoutMs, 90_000),
      maxRetries: this.config.claude.maxRetries,
      permissionMode: "default",
      dryRun: this.options.dryRun,
      signal: this.abortController.signal,
      onChunk: (chunk) => this.callbacks.onChunk?.("master", chunk)
    });
    clearInterval(reviewHeartbeat);
    this.emit(review.ok ? "info" : "warn", review.ok ? "claude_review_done" : "claude_review_failed", review.ok ? "Claude Master review returned." : `Claude Master review failed: ${review.errorKind ?? "unknown"}.`, {
      durationMs: review.durationMs,
      attempts: review.attempts,
      error: review.errorMessage
    });
    const reviewResult = parseReview(review.text, testOk, buildOk, worker.text || worker.raw);
    this.bus.writeArtifact(artifacts.reviewPath, formatClaudeOutput(review.text, review.raw));
    this.bus.appendMessage({
      role: "master",
      iteration,
      channel: "out",
      kind: review.ok ? "master_review" : "master_review_error",
      content: review.text || review.raw,
      metadata: { ok: review.ok, parsed: reviewResult, errorKind: review.errorKind, errorMessage: review.errorMessage }
    });
    if (!review.ok) {
      errors.push(`Master review degraded: ${review.errorKind ?? "unknown"} ${review.errorMessage ?? ""}`.trim());
    }

    if (this.shouldStopImmediately()) {
      errors.push("Hard stop requested during Master review.");
      const summary: IterationSummary = {
        iteration,
        masterSummary: task.summary,
        workerSummary: parseWorkerSummary(worker.text || worker.raw),
        reviewDecision: reviewResult.decision,
        reviewSummary: reviewResult.summary || "Hard stop requested during Master review.",
        testOk,
        buildOk,
        errors
      };
      this.writeIterationLog(artifacts, summary, "", iterationStartedAt);
      return summary;
    }

    const commit = await this.commitIfNeeded(iteration, reviewResult.summary || task.summary || "自动开发成果");
    this.bus.writeArtifact(artifacts.commitPath, commit);

    this.updateState({
      masterStatus: reviewResult.decision,
      gitStatus: commit.includes("commit ok") || commit.includes("No substantive") ? "ready" : "commit issue"
    });

    this.emit("info", "iteration_completed", `Iteration ${iteration} completed with decision ${reviewResult.decision}.`);
    if (reviewResult.severeError) {
      this.stopRequested = true;
      errors.push("Severe error reported by Master review.");
    }
    if (!reviewResult.continueNext && reviewResult.decision !== "pass") {
      this.stopRequested = true;
      this.emit("info", "master_stop", "Master requested no further iterations.");
    }

    const iterationSummary: IterationSummary = {
      iteration,
      masterSummary: task.summary,
      workerSummary: parseWorkerSummary(worker.text || worker.raw),
      reviewDecision: reviewResult.decision,
      reviewSummary: reviewResult.summary,
      testOk,
      buildOk,
      commitHash: parseCommitHash(commit),
      commitMessage: parseCommitMessage(commit),
      errors
    };
    this.writeIterationLog(artifacts, iterationSummary, commit, iterationStartedAt);
    return iterationSummary;
  }

  private async runConfiguredCommand(
    kind: "tests" | "build",
    command: string,
    logPath: string,
    errors: string[]
  ): Promise<boolean | undefined> {
    const label = kind === "tests" ? "test" : "build";
    if (!command.trim()) {
      const log = `No ${label} command configured. Configure ${kind === "tests" ? "testCommand" : "buildCommand"} or pass --${label}-command.\n`;
      writeTextFile(logPath, log);
      if (kind === "tests") this.lastTestLog = log;
      else this.lastBuildLog = log;
      this.updateState(kind === "tests" ? { testStatus: "not configured" } : { buildStatus: "not configured" });
      return undefined;
    }

    this.updateState(kind === "tests" ? { testStatus: "running" } : { buildStatus: "running" });
    this.emit("info", `${kind}_started`, `Running ${label} command: ${command}`);
    const result = await runShellCommand(command, this.cwd, 20 * 60_000, (chunk) => this.callbacks.onChunk?.(kind, chunk));
    const log = redactSensitive(
      [
        `$ ${command}`,
        `exitCode=${result.exitCode} timedOut=${result.timedOut} duration=${formatDurationMs(result.durationMs)}`,
        "",
        result.combined || result.errorMessage || ""
      ].join("\n")
    );
    writeTextFile(logPath, log);
    if (kind === "tests") this.lastTestLog = log;
    else this.lastBuildLog = log;
    this.updateState(kind === "tests" ? { testStatus: result.ok ? "pass" : "fail" } : { buildStatus: result.ok ? "pass" : "fail" });
    if (!result.ok) {
      errors.push(`${label} command failed: ${command}`);
      this.emit("warn", `${kind}_failed`, `${label} command failed.`, { command, exitCode: result.exitCode });
    }
    return result.ok;
  }

  private async commitIfNeeded(iteration: number, summary: string): Promise<string> {
    if (!this.options.autoCommit || this.options.dryRun) {
      return this.options.dryRun ? "Auto commit skipped: dry-run enabled.\n" : "Auto commit disabled.\n";
    }
    const isRepo = await this.git.isRepository();
    if (!isRepo) return "Auto commit skipped: not a Git repository.\n";

    const result = await this.git.commit(iteration, summary);
    const output = result.skipped
      ? `${result.message}\n`
      : result.ok
        ? `commit ok\nmessage=${result.message}\nhash=${result.hash ?? ""}\n${result.output}\n`
        : `commit failed\nmessage=${result.message}\n${result.output}\n`;

    if (result.ok && !result.skipped) {
      this.commitOutputs.push(output);
      this.emit("info", "git_commit", `Committed iteration ${iteration}: ${result.hash ?? result.message}`);
    } else if (!result.ok) {
      this.emit("warn", "git_commit_failed", "Git commit failed; continuing.", { output: result.output });
    }
    return output;
  }

  private async pushBranch(): Promise<void> {
    const isRepo = await this.git.isRepository();
    if (!isRepo) return;
    this.emit("info", "git_push_started", "Pushing branch.");
    const result = await this.git.push();
    if (result.ok) {
      this.emit("info", "git_push_ok", "Push completed.");
    } else {
      this.emit("warn", "git_push_failed", "Push failed; run continues.", { output: redactSensitive(result.combined) });
    }
  }

  private async safeGitStatus(errors: string[]): Promise<string> {
    try {
      const isRepo = await this.git.isRepository();
      if (!isRepo) return "Not a Git repository.";
      return await this.git.status();
    } catch (error) {
      const message = `git status failed: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(message);
      return message;
    }
  }

  private async safeGitDiff(errors: string[]): Promise<string> {
    try {
      const isRepo = await this.git.isRepository();
      if (!isRepo) return "Not a Git repository.";
      return await this.git.diff();
    } catch (error) {
      const message = `git diff failed: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(message);
      return message;
    }
  }

  private remainingStepTimeoutMs(): number {
    if (this.options.landing === "soft") {
      return this.config.claude.timeoutMs;
    }
    const remaining = Date.parse(this.state.deadlineAt) - Date.now() - 10_000;
    return Math.max(1_000, Math.min(this.config.claude.timeoutMs, remaining));
  }

  private shouldStopImmediately(): boolean {
    return this.stopRequested && this.requestedLandingMode === "hard";
  }

  private unmetMinimums(): string[] {
    const unmet: string[] = [];
    if (this.summaries.length < this.options.minRounds) {
      unmet.push(`rounds ${this.summaries.length}/${this.options.minRounds}`);
    }
    const elapsedMs = Date.now() - Date.parse(this.state.startedAt);
    const minRuntimeMs = this.options.minRuntimeMin * 60_000;
    if (elapsedMs < minRuntimeMs) {
      unmet.push(`runtime ${formatDurationMs(elapsedMs)}/${formatDurationMs(minRuntimeMs)}`);
    }
    return unmet;
  }

  private async waitForMinimumRuntimeIfNeeded(): Promise<void> {
    if (this.stopRequested || this.options.minRuntimeMin <= 0) return;
    let remainingMs = this.options.minRuntimeMin * 60_000 - (Date.now() - Date.parse(this.state.startedAt));
    if (remainingMs <= 0) return;

    this.updateState({ masterStatus: "waiting", workerStatus: "idle" });
    this.emit("info", "minimum_runtime_wait", "Minimum runtime is not reached; waiting before final report.", {
      remainingMs
    });
    while (remainingMs > 0 && !this.stopRequested) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, remainingMs)));
      remainingMs = this.options.minRuntimeMin * 60_000 - (Date.now() - Date.parse(this.state.startedAt));
    }
    if (!this.stopRequested) {
      this.emit("info", "minimum_runtime_satisfied", "Minimum runtime requirement satisfied.");
    }
  }

  private startStepHeartbeat(type: string, label: string): ReturnType<typeof setInterval> {
    const startedAt = Date.now();
    return setInterval(() => {
      this.emit("info", type, `${label} still running.`, {
        elapsedMs: Date.now() - startedAt,
        remainingMs: Math.max(0, Date.parse(this.state.deadlineAt) - Date.now())
      });
    }, 15_000);
  }

  private async manualFallback(reason: string): Promise<void> {
    this.stopRequested = true;
    const artifacts = this.bus.iterationArtifacts(Math.max(1, this.state.iteration || 1));
    const task = [
      `Manual fallback reason: ${reason}`,
      "",
      "Use these prompt files with Claude Code manually if needed:",
      `- ${artifacts.masterPromptPath}`,
      `- ${artifacts.workerPromptPath}`
    ].join("\n");
    const masterPrompt = this.prompts.buildMasterPlan({
      goal: this.options.goal,
      iteration: 1,
      maxRounds: this.options.rounds,
      finalRequirements: this.options.finalRequirements,
      qualityBar: this.config.qualityBar,
      previousSummary: task,
      gitStatus: this.lastGitStatus,
      gitDiff: this.lastGitDiff,
      testLog: this.lastTestLog,
      buildLog: this.lastBuildLog
    });
    const workerPrompt = this.prompts.buildWorkerTask({
      goal: this.options.goal,
      iteration: 1,
      maxRounds: this.options.rounds,
      task: "Claude was unavailable. Run this Worker prompt manually in Claude Code and then re-run cbduel.",
      acceptanceCriteria: this.options.finalRequirements,
      finalRequirements: this.options.finalRequirements,
      qualityBar: this.config.qualityBar
    });
    this.bus.writeArtifact(artifacts.masterPromptPath, masterPrompt);
    this.bus.writeArtifact(artifacts.workerPromptPath, workerPrompt);
    this.emit("warn", "manual_fallback", reason, {
      masterPrompt: artifacts.masterPromptPath,
      workerPrompt: artifacts.workerPromptPath
    });
    const reportPath = await this.writeFinalReport("manual", [reason]);
    this.updateState({ status: "manual", reportPath, masterStatus: "manual", workerStatus: "manual" });
  }

  private async writeFinalReport(status: string, extraIssues: string[] = []): Promise<string> {
    const finishedAt = nowIso();
    const finalStatus = await this.safeGitStatus([]);
    const changedFiles = finalStatus || "No Git status available.";
    const knownIssues = [
      ...extraIssues,
      ...this.summaries.flatMap((summary) => summary.errors),
      ...this.summaries
        .filter((summary) => summary.reviewDecision !== "pass")
        .map((summary) => `Iteration ${summary.iteration}: ${summary.reviewSummary}`)
    ];
    const report = this.prompts.buildFinalReport({
      goal: this.options.goal,
      runId: this.runId,
      mode: this.options.mode,
      startedAt: this.state.startedAt,
      finishedAt,
      branch: this.state.branch,
      status,
      summaries: this.summaries.length
        ? this.summaries.map((summary) => `- ${this.formatIterationSummary(summary)}`).join("\n")
        : "- No automated iteration completed.",
      changedFiles,
      commits: this.commitOutputs.length ? this.commitOutputs.map((item) => `- ${item.trim()}`).join("\n") : "- No commits created.",
      runDir: this.bus.runDir,
      testCommand: this.options.testCommand || "(not configured)",
      buildCommand: this.options.buildCommand || "(not configured)",
      knownIssues: knownIssues.length ? knownIssues.map((issue) => `- ${issue}`).join("\n") : "- None recorded."
    });
    const reportPath = path.join(this.bus.runDir, "final_report.md");
    writeTextFile(reportPath, report);
    return reportPath;
  }

  private updateState(partial: Partial<RunState>): void {
    this.state = { ...this.state, ...partial, updatedAt: nowIso() };
    this.bus.writeState(this.state);
    this.callbacks.onState?.(this.getState());
  }

  private emit(level: EventRecord["level"], type: string, message: string, data?: unknown): EventRecord {
    const event = this.bus.event(level, type, message, data);
    this.callbacks.onEvent?.(event);
    return event;
  }

  private async waitIfPaused(): Promise<void> {
    while (this.paused && !this.stopRequested) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  private writeIterationLog(
    artifacts: IterationArtifacts,
    summary: IterationSummary,
    commitText: string,
    iterationStartedAt: string
  ): void {
    const finishedAt = nowIso();
    const artifactPaths = [
      `master_prompt=${artifacts.masterPromptPath}`,
      `master_output=${artifacts.masterOutputPath}`,
      `worker_prompt=${artifacts.workerPromptPath}`,
      `worker_output=${artifacts.workerOutputPath}`,
      `git_status=${artifacts.gitStatusPath}`,
      `git_diff=${artifacts.gitDiffPath}`,
      `test_log=${artifacts.testLogPath}`,
      `build_log=${artifacts.buildLogPath}`,
      `review=${artifacts.reviewPath}`,
      `commit=${artifacts.commitPath}`,
      `iteration_log=${artifacts.iterationLogPath}`
    ];
    const lines = [
      "ClaudeBrainDuel iteration log",
      "=".repeat(36),
      `run_id=${this.runId}`,
      `iteration=${summary.iteration}`,
      `goal=${redactSensitive(this.options.goal)}`,
      `started_at=${iterationStartedAt}`,
      `finished_at=${finishedAt}`,
      `status=${this.state.status}`,
      "",
      "Run controls",
      `rounds=${this.options.rounds}`,
      `min_rounds=${this.options.minRounds}`,
      `time_limit_min=${this.options.timeLimitMin}`,
      `min_runtime_min=${this.options.minRuntimeMin}`,
      `landing=${this.requestedLandingMode}`,
      `refresh_interval_sec=${this.options.refreshIntervalSec}`,
      "",
      "Iteration result",
      `master_summary=${summary.masterSummary}`,
      `worker_summary=${summary.workerSummary}`,
      `review_decision=${summary.reviewDecision}`,
      `review_summary=${summary.reviewSummary}`,
      `test=${summary.testOk === undefined ? "not_configured" : summary.testOk ? "pass" : "fail"}`,
      `build=${summary.buildOk === undefined ? "not_configured" : summary.buildOk ? "pass" : "fail"}`,
      `commit_hash=${summary.commitHash ?? ""}`,
      `commit_message=${summary.commitMessage ?? ""}`,
      "",
      "Errors",
      summary.errors.length ? summary.errors.map((item) => `- ${item}`).join("\n") : "- none",
      "",
      "Commit output",
      redactSensitive(commitText.trim() || "(empty)"),
      "",
      "Artifacts",
      artifactPaths.join("\n")
    ];
    writeTextFile(artifacts.iterationLogPath, `${lines.join("\n")}\n`);
    this.emit("info", "iteration_log_written", `Iteration ${summary.iteration} text log written.`, {
      path: artifacts.iterationLogPath
    });
  }

  private emptySummary(iteration: number, errors: string[], decision: "pass" | "partial" | "fail"): IterationSummary {
    return {
      iteration,
      masterSummary: "Manual fallback generated.",
      workerSummary: "Worker did not run.",
      reviewDecision: decision,
      reviewSummary: "Claude was unavailable.",
      errors
    };
  }

  private formatIterationSummary(summary: IterationSummary): string {
    const commit = summary.commitHash ? ` commit=${summary.commitHash}` : "";
    const test = summary.testOk === undefined ? "test=not_configured" : `test=${summary.testOk ? "pass" : "fail"}`;
    const build = summary.buildOk === undefined ? "build=not_configured" : `build=${summary.buildOk ? "pass" : "fail"}`;
    return `iteration ${summary.iteration}: ${summary.reviewDecision}; ${test}; ${build}; ${summary.reviewSummary || summary.workerSummary}${commit}`;
  }
}

function formatClaudeOutput(text: string, raw: string): string {
  return [`# Parsed Text`, "", text || "(empty)", "", "# Raw Output", "", raw || "(empty)"].join("\n");
}

function parseMasterPlan(text: string): { summary: string; workerTask: string; acceptanceCriteria: string[] } {
  const parsed = parseJsonObjectFromText(text) as Record<string, unknown> | undefined;
  const criteria = parsed?.acceptanceCriteria;
  return {
    summary: coerceString(parsed?.summary, "Master generated a fallback plan."),
    workerTask:
      coerceString(parsed?.workerTask) ||
      [
        "Perform one bounded implementation pass for the user's goal.",
        "First inspect the existing project structure and only the files needed for the goal.",
        "If the project already has implementation files, fix obvious runtime/documentation gaps instead of rewriting everything.",
        "Do not install packages unless a package.json already exists and the command is clearly required.",
        "Avoid long-running commands. Run at most one quick syntax/test/build check if obvious.",
        "Keep changes concise, then immediately output the required JSON report. Do not keep polishing after the project is runnable."
      ].join("\n"),
    acceptanceCriteria: Array.isArray(criteria)
      ? criteria.map((item) => coerceString(item)).filter(Boolean)
      : [coerceString(criteria, "Project is runnable, documented, tested where possible, and not a demo.")]
  };
}

function parseWorkerSummary(text: string): string {
  const parsed = parseJsonObjectFromText(text) as Record<string, unknown> | undefined;
  return coerceString(parsed?.summary, text.trim().slice(0, 300) || "Worker output was empty.");
}

function parseReview(
  text: string,
  testOk: boolean | undefined,
  buildOk: boolean | undefined,
  workerOutput: string
): ReviewResult {
  const parsed = parseJsonObjectFromText(text) as Record<string, unknown> | undefined;
  const decisionRaw = coerceString(parsed?.decision).toLowerCase();
  const decision = decisionRaw === "pass" || decisionRaw === "partial" || decisionRaw === "fail" ? decisionRaw : fallbackDecision(testOk, buildOk, workerOutput);
  return {
    decision,
    summary: coerceString(parsed?.summary, decision === "pass" ? "Accepted by fallback review." : "Fallback review requires another iteration."),
    continueNext: coerceBoolean(parsed?.continueNext, decision !== "pass"),
    severeError: coerceBoolean(parsed?.severeError, false)
  };
}

function fallbackDecision(testOk: boolean | undefined, buildOk: boolean | undefined, workerOutput: string): "pass" | "partial" | "fail" {
  if (!workerOutput.trim()) return "fail";
  if (testOk === false || buildOk === false) return "partial";
  const parsed = parseJsonObjectFromText(workerOutput) as Record<string, unknown> | undefined;
  const ready = coerceBoolean(parsed?.readyForReview, false);
  const filesChanged = parsed?.filesChanged;
  if (ready && Array.isArray(filesChanged) && filesChanged.length > 0) return "pass";
  if (/readyForReview["']?\s*:\s*true/i.test(workerOutput) && /filesChanged/i.test(workerOutput)) return "pass";
  return "partial";
}

function parseCommitHash(commitText: string): string | undefined {
  const match = commitText.match(/^hash=(.+)$/m);
  return match?.[1]?.trim() || undefined;
}

function parseCommitMessage(commitText: string): string | undefined {
  const match = commitText.match(/^message=(.+)$/m);
  return match?.[1]?.trim() || undefined;
}
