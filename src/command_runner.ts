import { spawn } from "node:child_process";
import { CommandResult } from "./types";
import { formatDurationMs } from "./utils";

export interface RunProcessOptions {
  cwd: string;
  timeoutMs?: number;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions
): Promise<CommandResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env }
    });

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Best effort.
      }
      terminateProcessTree(child.pid);
      setTimeout(() => {
        if (!settled) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Best effort.
          }
          terminateProcessTree(child.pid);
        }
      }, 3000).unref();
    }, timeoutMs);

    const abortHandler = () => {
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Best effort.
      }
      terminateProcessTree(child.pid);
      setTimeout(() => {
        if (!settled) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Best effort.
          }
          terminateProcessTree(child.pid);
        }
      }, 3000).unref();
    };
    if (options.signal?.aborted) abortHandler();
    else options.signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      options.onStdout?.(text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      options.onStderr?.(text);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortHandler);
      const durationMs = Date.now() - started;
      resolve({
        ok: false,
        command: [command, ...args].join(" "),
        stdout,
        stderr,
        combined: `${stdout}${stderr}`,
        exitCode: null,
        timedOut,
        durationMs,
        errorMessage: aborted ? "Process aborted." : error.message
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortHandler);
      const durationMs = Date.now() - started;
      const combined = `${stdout}${stderr}`;
      resolve({
        ok: code === 0 && !timedOut && !aborted,
        command: [command, ...args].join(" "),
        stdout,
        stderr,
        combined,
        exitCode: code,
        timedOut,
        durationMs,
        errorMessage: aborted ? "Process aborted." : timedOut ? `Timed out after ${formatDurationMs(timeoutMs)}` : undefined
      });
    });
  });
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      }).unref();
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // Best effort.
  }
}

export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs = 20 * 60 * 1000,
  onChunk?: (chunk: string) => void
): Promise<CommandResult> {
  const shellCommand = process.platform === "win32" ? command : command;
  return runProcess(shellCommand, [], {
    cwd,
    timeoutMs,
    shell: true,
    onStdout: onChunk,
    onStderr: onChunk
  });
}
