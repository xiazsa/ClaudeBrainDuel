export type Mode = "tui" | "headless" | "manual";
export type LandingMode = "hard" | "soft";
export type ClaudeOutputFormat = "json" | "stream-json" | "text";
export type RunStatus =
  | "idle"
  | "running"
  | "paused"
  | "stopping"
  | "completed"
  | "failed"
  | "manual";
export type Role = "master" | "worker" | "orchestrator" | "git" | "tests" | "build";
export type EventLevel = "debug" | "info" | "warn" | "error";
export type ReviewDecision = "pass" | "partial" | "fail";

export interface ClaudeConfig {
  command: string;
  outputFormat: ClaudeOutputFormat;
  allowedTools: string[];
  maxRetries: number;
  timeoutMs: number;
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
}

export interface CbduelConfig {
  defaultRounds: number;
  defaultMinRounds: number;
  defaultTimeLimitMin: number;
  defaultMinRuntimeMin: number;
  mode: Mode;
  landing: LandingMode;
  refreshIntervalSec: number;
  autoCommit: boolean;
  push: boolean;
  createBranch: boolean;
  testCommand: string;
  buildCommand: string;
  finalRequirements: string;
  claude: ClaudeConfig;
  qualityBar: string;
}

export interface CliOptions {
  command?: "init" | "run" | "help";
  goal?: string;
  rounds?: number;
  minRounds?: number;
  timeLimitMin?: number;
  minRuntimeMin?: number;
  mode?: Mode;
  landing?: LandingMode;
  refreshIntervalSec?: number;
  autoCommit?: boolean;
  push?: boolean;
  createBranch?: boolean;
  testCommand?: string;
  buildCommand?: string;
  finalRequirements?: string;
  dryRun?: boolean;
  noInteractive?: boolean;
}

export interface ResolvedRunOptions {
  goal: string;
  rounds: number;
  minRounds: number;
  timeLimitMin: number;
  minRuntimeMin: number;
  mode: Mode;
  landing: LandingMode;
  refreshIntervalSec: number;
  autoCommit: boolean;
  push: boolean;
  createBranch: boolean;
  testCommand: string;
  buildCommand: string;
  finalRequirements: string;
  dryRun: boolean;
  noInteractive: boolean;
}

export interface EventRecord {
  id: string;
  timestamp: string;
  level: EventLevel;
  type: string;
  message: string;
  data?: unknown;
}

export interface BusMessage {
  id: string;
  timestamp: string;
  role: Role;
  iteration: number;
  channel: "in" | "out" | "event";
  kind: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RunState {
  runId: string;
  goal: string;
  mode: Mode;
  status: RunStatus;
  currentView: string;
  iteration: number;
  maxRounds: number;
  minRounds: number;
  startedAt: string;
  updatedAt: string;
  deadlineAt: string;
  minRuntimeMin: number;
  landing: LandingMode;
  refreshIntervalSec: number;
  remainingRounds: number;
  branch: string;
  masterStatus: string;
  workerStatus: string;
  gitStatus: string;
  testStatus: string;
  buildStatus: string;
  lastError?: string;
  reportPath?: string;
  runDir: string;
  logPath: string;
}

export interface ClaudeRunInput {
  role: Role;
  prompt: string;
  cwd: string;
  outputFormat: ClaudeOutputFormat;
  allowedTools: string[];
  timeoutMs: number;
  maxRetries: number;
  permissionMode: ClaudeConfig["permissionMode"];
  dryRun?: boolean;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

export interface ClaudeRunResult {
  ok: boolean;
  text: string;
  raw: string;
  json?: unknown;
  errorKind?: "missing_command" | "auth" | "timeout" | "json_parse" | "empty_output" | "process_error";
  errorMessage?: string;
  exitCode?: number | null;
  durationMs: number;
  attempts: number;
}

export interface CommandResult {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  combined: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  errorMessage?: string;
}

export interface IterationArtifacts {
  iteration: number;
  dir: string;
  masterPromptPath: string;
  masterOutputPath: string;
  workerPromptPath: string;
  workerOutputPath: string;
  gitStatusPath: string;
  gitDiffPath: string;
  testLogPath: string;
  buildLogPath: string;
  reviewPath: string;
  commitPath: string;
  iterationLogPath: string;
}

export interface IterationSummary {
  iteration: number;
  masterSummary: string;
  workerSummary: string;
  reviewDecision: ReviewDecision;
  reviewSummary: string;
  testOk?: boolean;
  buildOk?: boolean;
  commitHash?: string;
  commitMessage?: string;
  errors: string[];
}

export interface ReviewResult {
  decision: ReviewDecision;
  summary: string;
  continueNext: boolean;
  severeError: boolean;
}
