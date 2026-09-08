import type { PullRequest, PullRequestStatus } from "../core/types.js";

/**
 * Provider abstraction over a code host (Azure DevOps in production, an
 * in-memory fake for offline demos). Keeps the engine independent of ADO SDK
 * details so the same logic drives both real and mock runs.
 */
export interface Provider {
  readonly name: string;

  /** List branch names in the repository. */
  listBranches(): Promise<string[]>;

  /** Whether a branch exists on the remote. */
  branchExists(branch: string): Promise<boolean>;

  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;

  updatePullRequest(
    id: number,
    changes: UpdatePullRequestInput
  ): Promise<PullRequest>;

  getPullRequest(id: number): Promise<PullRequest | undefined>;

  /** Post a comment (thread) on a PR. Returns a thread/comment id. */
  addComment(prId: number, content: string): Promise<number>;

  /** Complete/merge a PR into its target branch. */
  completePullRequest(id: number): Promise<PullRequest>;

  listPullRequests(): Promise<PullRequest[]>;
}

export interface CreatePullRequestInput {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  isDraft?: boolean;
  dependsOn?: number[];
}

export interface UpdatePullRequestInput {
  title?: string;
  description?: string;
  targetBranch?: string;
  status?: PullRequestStatus;
  dependsOn?: number[];
}
