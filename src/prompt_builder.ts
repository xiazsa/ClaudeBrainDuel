import fs from "node:fs";
import { resolveTemplatePath, safeJsonStringify } from "./utils";

export interface MasterPlanVars {
  goal: string;
  iteration: number;
  maxRounds: number;
  finalRequirements: string;
  qualityBar: string;
  previousSummary: string;
  gitStatus: string;
  gitDiff: string;
  testLog: string;
  buildLog: string;
}

export interface WorkerTaskVars {
  goal: string;
  iteration: number;
  maxRounds: number;
  task: string;
  acceptanceCriteria: string;
  finalRequirements: string;
  qualityBar: string;
}

export interface MasterReviewVars {
  goal: string;
  iteration: number;
  maxRounds: number;
  workerOutput: string;
  gitStatus: string;
  gitDiff: string;
  testLog: string;
  buildLog: string;
  finalRequirements: string;
}

export interface FinalReportVars {
  goal: string;
  runId: string;
  mode: string;
  startedAt: string;
  finishedAt: string;
  branch: string;
  status: string;
  summaries: string;
  changedFiles: string;
  commits: string;
  runDir: string;
  testCommand: string;
  buildCommand: string;
  knownIssues: string;
}

export class PromptBuilder {
  buildMasterPlan(vars: MasterPlanVars): string {
    return fillTemplate(readTemplate("master_plan.md"), mapVars(vars));
  }

  buildWorkerTask(vars: WorkerTaskVars): string {
    return fillTemplate(readTemplate("worker_task.md"), mapVars(vars));
  }

  buildMasterReview(vars: MasterReviewVars): string {
    return fillTemplate(readTemplate("master_review.md"), mapVars(vars));
  }

  buildFinalReport(vars: FinalReportVars): string {
    return fillTemplate(readTemplate("final_report.md"), mapVars(vars));
  }
}

function readTemplate(name: string): string {
  const filePath = resolveTemplatePath(name);
  return fs.readFileSync(filePath, "utf8");
}

function mapVars(vars: object): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    mapped[key] = typeof value === "string" ? value : safeJsonStringify(value);
  }
  return mapped;
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => vars[key] ?? "");
}
