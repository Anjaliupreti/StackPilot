import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlannedOperation } from "../core/types.js";

const execFileAsync = promisify(execFile);

/**
 * Controlled Git surface. Every mutating method returns a {@link PlannedOperation}
 * describing exactly what will run, so the engine can preview/approve before
 * anything touches the working tree or remote.
 */
export interface GitService {
  readonly name: string;
  currentBranch(): Promise<string>;
  headSha(branch?: string): Promise<string>;
  /** Commit subjects present on `head` but not on `base`. */
  commitsBetween(base: string, head: string): Promise<string[]>;
  /** File paths changed on `head` relative to `base`. */
  changedFiles(base: string, head: string): Promise<string[]>;

  planCreateBranch(name: string, from: string): PlannedOperation;
  planRebase(branch: string, onto: string, from: string): PlannedOperation;
  planPush(branch: string, force: boolean): PlannedOperation;

  /** Execute a previously planned operation. */
  apply(op: PlannedOperation): Promise<void>;
}

/** Real git backed by the `git` CLI in the current working directory. */
export class RealGitService implements GitService {
  readonly name = "git";
  constructor(private readonly cwd: string = process.cwd()) {}

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: this.cwd });
    return stdout.trim();
  }

  async currentBranch(): Promise<string> {
    return this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
  }

  async headSha(branch = "HEAD"): Promise<string> {
    return this.git(["rev-parse", branch]);
  }

  async commitsBetween(base: string, head: string): Promise<string[]> {
    const out = await this.git([
      "log",
      "--format=%s",
      `${base}..${head}`,
    ]);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  async changedFiles(base: string, head: string): Promise<string[]> {
    const out = await this.git(["diff", "--name-only", `${base}...${head}`]);
    return out ? out.split("\n").filter(Boolean) : [];
  }

  planCreateBranch(name: string, from: string): PlannedOperation {
    return {
      kind: "git",
      command: `git checkout -b ${name} ${from}`,
      description: `Create branch ${name} from ${from}`,
      mutating: true,
    };
  }

  planRebase(branch: string, onto: string, from: string): PlannedOperation {
    return {
      kind: "git",
      command: `git rebase --onto ${onto} ${from} ${branch}`,
      description: `Rebase ${branch} onto ${onto} (was based on ${from})`,
      mutating: true,
    };
  }

  planPush(branch: string, force: boolean): PlannedOperation {
    const flag = force ? " --force-with-lease" : "";
    return {
      kind: "git",
      command: `git push${flag} origin ${branch}`,
      description: `Push ${branch} to origin${force ? " (force-with-lease)" : ""}`,
      mutating: true,
    };
  }

  async apply(op: PlannedOperation): Promise<void> {
    if (op.kind !== "git") return;
    const args = op.command.replace(/^git\s+/, "").split(/\s+/);
    await this.git(args);
  }
}

/**
 * Simulated git for offline demos. Generates plausible commits/files from branch
 * names and records applied operations instead of touching a real repository.
 */
export class MockGitService implements GitService {
  readonly name = "mock-git";
  readonly applied: PlannedOperation[] = [];
  private current = "main";
  private shas = new Map<string, string>();

  constructor(private readonly seed?: {
    branchCommits?: Record<string, string[]>;
    branchFiles?: Record<string, string[]>;
  }) {}

  setCurrent(branch: string): void {
    this.current = branch;
  }

  async currentBranch(): Promise<string> {
    return this.current;
  }

  async headSha(branch = this.current): Promise<string> {
    if (!this.shas.has(branch)) {
      this.shas.set(branch, randomSha());
    }
    return this.shas.get(branch)!;
  }

  /** Force a new SHA for a branch to simulate upstream drift. */
  bumpSha(branch: string): void {
    this.shas.set(branch, randomSha());
  }

  async commitsBetween(_base: string, head: string): Promise<string[]> {
    return this.seed?.branchCommits?.[head] ?? [];
  }

  async changedFiles(_base: string, head: string): Promise<string[]> {
    return this.seed?.branchFiles?.[head] ?? [];
  }

  planCreateBranch(name: string, from: string): PlannedOperation {
    return {
      kind: "git",
      command: `git checkout -b ${name} ${from}`,
      description: `Create branch ${name} from ${from}`,
      mutating: true,
    };
  }

  planRebase(branch: string, onto: string, from: string): PlannedOperation {
    return {
      kind: "git",
      command: `git rebase --onto ${onto} ${from} ${branch}`,
      description: `Rebase ${branch} onto ${onto} (was based on ${from})`,
      mutating: true,
    };
  }

  planPush(branch: string, force: boolean): PlannedOperation {
    return {
      kind: "git",
      command: `git push${force ? " --force-with-lease" : ""} origin ${branch}`,
      description: `Push ${branch} to origin`,
      mutating: true,
    };
  }

  async apply(op: PlannedOperation): Promise<void> {
    this.applied.push(op);
  }
}

function randomSha(): string {
  return Array.from({ length: 40 }, () =>
    "0123456789abcdef"[Math.floor(Math.random() * 16)]
  ).join("");
}
