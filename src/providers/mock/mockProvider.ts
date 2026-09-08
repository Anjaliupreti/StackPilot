import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PullRequest } from "../../core/types.js";
import type {
  CreatePullRequestInput,
  Provider,
  UpdatePullRequestInput,
} from "../provider.js";

/**
 * In-memory provider that mimics Azure DevOps well enough to demo the full
 * stacked-PR workflow offline. When given a `persistFile`, state is written to
 * disk so it survives across separate CLI processes (real ADO persists
 * server-side; this gives the mock the same durability).
 */
export class MockProvider implements Provider {
  readonly name = "mock";
  private prs = new Map<number, PullRequest>();
  private branches: Set<string>;
  private nextPrId = 101;
  private nextThreadId = 5001;
  private readonly baseUrl: string;
  private readonly persistFile?: string;

  constructor(opts?: {
    branches?: string[];
    repositoryUrl?: string;
    persistFile?: string;
  }) {
    this.branches = new Set(opts?.branches ?? ["main"]);
    this.baseUrl =
      opts?.repositoryUrl ??
      "https://dev.azure.com/contoso/StackPilot/_git/demo";
    this.persistFile = opts?.persistFile;
    this.restore();
  }

  private restore(): void {
    if (!this.persistFile || !existsSync(this.persistFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.persistFile, "utf8")) as {
        prs: PullRequest[];
        branches: string[];
        nextPrId: number;
        nextThreadId: number;
      };
      this.prs = new Map(data.prs.map((p) => [p.id, p]));
      this.branches = new Set(data.branches);
      this.nextPrId = data.nextPrId;
      this.nextThreadId = data.nextThreadId;
    } catch {
      /* start fresh on a corrupt file */
    }
  }

  private save(): void {
    if (!this.persistFile) return;
    mkdirSync(dirname(this.persistFile), { recursive: true });
    writeFileSync(
      this.persistFile,
      JSON.stringify(
        {
          prs: [...this.prs.values()],
          branches: [...this.branches],
          nextPrId: this.nextPrId,
          nextThreadId: this.nextThreadId,
        },
        null,
        2
      ),
      "utf8"
    );
  }

  async listBranches(): Promise<string[]> {
    return [...this.branches];
  }

  async branchExists(branch: string): Promise<boolean> {
    return this.branches.has(branch);
  }

  /** Test helper: register a branch as if it had been pushed. */
  registerBranch(branch: string): void {
    this.branches.add(branch);
    this.save();
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    const id = this.nextPrId++;
    const now = new Date().toISOString();
    this.branches.add(input.sourceBranch);
    this.branches.add(input.targetBranch);
    const pr: PullRequest = {
      id,
      title: input.title,
      description: input.description,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      status: input.isDraft ? "draft" : "active",
      url: `${this.baseUrl}/pullrequest/${id}`,
      dependsOn: input.dependsOn ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.prs.set(id, pr);
    this.save();
    return { ...pr };
  }

  async updatePullRequest(
    id: number,
    changes: UpdatePullRequestInput
  ): Promise<PullRequest> {
    const pr = this.prs.get(id);
    if (!pr) throw new Error(`PR ${id} not found`);
    const updated: PullRequest = {
      ...pr,
      title: changes.title ?? pr.title,
      description: changes.description ?? pr.description,
      targetBranch: changes.targetBranch ?? pr.targetBranch,
      status: changes.status ?? pr.status,
      dependsOn: changes.dependsOn ?? pr.dependsOn,
      updatedAt: new Date().toISOString(),
    };
    this.prs.set(id, updated);
    this.save();
    return { ...updated };
  }

  async getPullRequest(id: number): Promise<PullRequest | undefined> {
    const pr = this.prs.get(id);
    return pr ? { ...pr } : undefined;
  }

  async addComment(prId: number, _content: string): Promise<number> {
    if (!this.prs.has(prId)) throw new Error(`PR ${prId} not found`);
    const id = this.nextThreadId++;
    this.save();
    return id;
  }

  async completePullRequest(id: number): Promise<PullRequest> {
    return this.updatePullRequest(id, { status: "completed" });
  }

  async listPullRequests(): Promise<PullRequest[]> {
    return [...this.prs.values()].map((p) => ({ ...p }));
  }
}
