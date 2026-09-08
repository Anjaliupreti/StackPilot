import * as azdev from "azure-devops-node-api";
import type { GitPullRequest } from "azure-devops-node-api/interfaces/GitInterfaces.js";
import {
  PullRequestStatus as AdoPrStatus,
  CommentThreadStatus,
  CommentType,
} from "azure-devops-node-api/interfaces/GitInterfaces.js";
import type { IGitApi } from "azure-devops-node-api/GitApi.js";
import type { PullRequest, PullRequestStatus } from "../../core/types.js";
import type {
  CreatePullRequestInput,
  Provider,
  UpdatePullRequestInput,
} from "../provider.js";

export interface AdoProviderOptions {
  organizationUrl: string;
  project: string;
  repository: string;
  pat: string;
}

const REFS_PREFIX = "refs/heads/";

/**
 * Azure DevOps provider backed by azure-devops-node-api. Azure DevOps has no
 * native PR-to-PR dependency, so StackPilot encodes the stack relationship in
 * the PR description (a machine-readable marker) plus a posted comment.
 */
export class AdoProvider implements Provider {
  readonly name = "ado";
  private git!: IGitApi;
  private repoId!: string;
  private ready: Promise<void>;

  constructor(private readonly opts: AdoProviderOptions) {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const auth = azdev.getPersonalAccessTokenHandler(this.opts.pat);
    const conn = new azdev.WebApi(this.opts.organizationUrl, auth);
    this.git = await conn.getGitApi();
    const repo = await this.git.getRepository(
      this.opts.repository,
      this.opts.project
    );
    if (!repo?.id) throw new Error(`Repository ${this.opts.repository} not found`);
    this.repoId = repo.id;
  }

  private toRef(branch: string): string {
    return branch.startsWith(REFS_PREFIX) ? branch : REFS_PREFIX + branch;
  }

  private fromRef(ref?: string): string {
    return (ref ?? "").replace(REFS_PREFIX, "");
  }

  private mapStatus(pr: GitPullRequest): PullRequestStatus {
    if (pr.isDraft) return "draft";
    switch (pr.status) {
      case AdoPrStatus.Completed:
        return "completed";
      case AdoPrStatus.Abandoned:
        return "abandoned";
      default:
        return "active";
    }
  }

  private map(pr: GitPullRequest): PullRequest {
    const org = this.opts.organizationUrl.replace(/\/$/, "");
    return {
      id: pr.pullRequestId ?? -1,
      title: pr.title ?? "",
      description: pr.description ?? "",
      sourceBranch: this.fromRef(pr.sourceRefName),
      targetBranch: this.fromRef(pr.targetRefName),
      status: this.mapStatus(pr),
      url: `${org}/${this.opts.project}/_git/${this.opts.repository}/pullrequest/${pr.pullRequestId}`,
      dependsOn: parseDependsOn(pr.description ?? ""),
      createdAt: pr.creationDate?.toISOString?.() ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async listBranches(): Promise<string[]> {
    await this.ready;
    const refs = await this.git.getRefs(this.repoId, this.opts.project, "heads/");
    return refs.map((r) => this.fromRef(r.name));
  }

  async branchExists(branch: string): Promise<boolean> {
    const branches = await this.listBranches();
    return branches.includes(branch);
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    await this.ready;
    const description = embedDependsOn(input.description, input.dependsOn ?? []);
    const created = await this.git.createPullRequest(
      {
        title: input.title,
        description,
        sourceRefName: this.toRef(input.sourceBranch),
        targetRefName: this.toRef(input.targetBranch),
        isDraft: input.isDraft ?? false,
      },
      this.repoId,
      this.opts.project
    );
    return this.map(created);
  }

  async updatePullRequest(
    id: number,
    changes: UpdatePullRequestInput
  ): Promise<PullRequest> {
    await this.ready;
    const patch: GitPullRequest = {};
    if (changes.title !== undefined) patch.title = changes.title;
    if (changes.targetBranch !== undefined)
      patch.targetRefName = this.toRef(changes.targetBranch);
    if (changes.description !== undefined || changes.dependsOn !== undefined) {
      const current = await this.git.getPullRequestById(id, this.opts.project);
      const baseDesc = changes.description ?? stripDependsOn(current.description ?? "");
      const deps = changes.dependsOn ?? parseDependsOn(current.description ?? "");
      patch.description = embedDependsOn(baseDesc, deps);
    }
    if (changes.status === "abandoned") patch.status = AdoPrStatus.Abandoned;
    if (changes.status === "completed") patch.status = AdoPrStatus.Completed;
    const updated = await this.git.updatePullRequest(
      patch,
      this.repoId,
      id,
      this.opts.project
    );
    return this.map(updated);
  }

  async getPullRequest(id: number): Promise<PullRequest | undefined> {
    await this.ready;
    try {
      const pr = await this.git.getPullRequestById(id, this.opts.project);
      return pr ? this.map(pr) : undefined;
    } catch {
      return undefined;
    }
  }

  async addComment(prId: number, content: string): Promise<number> {
    await this.ready;
    const thread = await this.git.createThread(
      {
        comments: [{ content, commentType: CommentType.Text }],
        status: CommentThreadStatus.Active,
      },
      this.repoId,
      prId,
      this.opts.project
    );
    return thread.id ?? -1;
  }

  async completePullRequest(id: number): Promise<PullRequest> {
    await this.ready;
    const pr = await this.git.getPullRequestById(id, this.opts.project);
    const updated = await this.git.updatePullRequest(
      {
        status: AdoPrStatus.Completed,
        lastMergeSourceCommit: pr.lastMergeSourceCommit,
      },
      this.repoId,
      id,
      this.opts.project
    );
    return this.map(updated);
  }

  async listPullRequests(): Promise<PullRequest[]> {
    await this.ready;
    const prs = await this.git.getPullRequests(this.repoId, {}, this.opts.project);
    return prs.map((p) => this.map(p));
  }
}

const DEP_MARKER = /<!--\s*stackpilot:depends-on=([\d,\s]*)\s*-->/i;

/** Encode stack dependencies into a PR description as a hidden HTML marker. */
export function embedDependsOn(description: string, dependsOn: number[]): string {
  const clean = stripDependsOn(description).trimEnd();
  const marker = `<!-- stackpilot:depends-on=${dependsOn.join(",")} -->`;
  return `${clean}\n\n${marker}\n`;
}

export function parseDependsOn(description: string): number[] {
  const m = description.match(DEP_MARKER);
  if (!m || !m[1].trim()) return [];
  return m[1]
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

export function stripDependsOn(description: string): string {
  return description.replace(DEP_MARKER, "").trimEnd();
}
