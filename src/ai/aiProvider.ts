import type { PullRequest, Stack, StackedBranch } from "../core/types.js";

/** Context passed to the AI provider to generate stack-aware content. */
export interface DescribeContext {
  stack: Stack;
  branch: StackedBranch;
  /** Commit subject lines unique to this branch (vs. its base). */
  commits: string[];
  /** Changed file paths on this branch. */
  changedFiles: string[];
  /** The PR immediately below this one in the stack, if any. */
  basePr?: PullRequest;
}

export interface ReviewContext {
  stack: Stack;
  prs: PullRequest[];
}

/** Pluggable AI provider. Swap the mock for a real LLM without engine changes. */
export interface AIProvider {
  readonly name: string;
  /** Generate a reviewer-friendly PR description for a stacked branch. */
  describePullRequest(ctx: DescribeContext): Promise<string>;
  /** Produce a stack-aware review summary spanning all PRs. */
  reviewStack(ctx: ReviewContext): Promise<string>;
  /** Natural-language guidance for a comment-based command. */
  guidance(prompt: string, stack?: Stack): Promise<string>;
}
