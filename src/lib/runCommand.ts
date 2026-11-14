/**
 * runCommand.ts
 *
 * execFile without a shell: arguments are passed as a list, so a file name can
 * never be read as shell syntax. Used by the off-site backup and restore check,
 * which take their commands as an injectable `Runner` so tests can fake them.
 */

import { execFile } from "node:child_process";

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

export class CommandError extends Error {
  constructor(
    public readonly command: string,
    public readonly exitCode: number | string | null,
    public readonly stderr: string,
  ) {
    // Only the tail: enough to diagnose, and short enough for an alert.
    super(`${command} failed (${exitCode ?? "killed"}): ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
    this.name = "CommandError";
  }
}

const MAX_BUFFER = 32 * 1024 * 1024;

export const runCommand: Runner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env: options.env ?? process.env,
        timeout: options.timeoutMs ?? 10 * 60 * 1000,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code ?? null;
          reject(new CommandError(command, code, String(stderr || err.message)));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
