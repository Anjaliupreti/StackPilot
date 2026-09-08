import { randomUUID } from "node:crypto";
import type { AIProvider } from "../ai/aiProvider.js";
import type { GitService } from "../git/gitService.js";
import type { Provider } from "../providers/provider.js";
import type { StackStore } from "../store/stackStore.js";
import type {
  ApprovalRequest,
  PlannedOperation,
  PullRequest,
  Stack,
  StackedBranch,
  StackEffect,
  StackPilotConfig,
} from "./types.js";

export interface EngineDeps {
  provider: Provider;
  git: GitService;
  ai: AIProvider;
  store: StackStore;
  config: StackPilotConfig;
}

export interface PlanResult {
  operations: PlannedOperation[];
  applied: boolean;
  approval?: ApprovalRequest;
  messages: string[];
}

export interface SyncItem {
  branch: string;
  base: string;
  drifted: boolean;
  operations: PlannedOperation[];
}

/**
 * The StackPilot engine. Owns the stack lifecycle: create → push → open PRs →
 * describe → sync/restack → review → merge, emitting an audit event for every
 * meaningful action and gating mutating git/provider work behind approvals.
 */
export class StackManager {
  constructor(private readonly deps: EngineDeps) {}

  private get actor(): string {
    return this.deps.config.actor;
  }

  // ---- stack lifecycle --------------------------------------------------

  async createStack(
    name: string,
    trunk: string,
    bottomBranch: string
  ): Promise<Stack> {
    const existing = this.deps.store.getStack(name);
    if (existing) throw new Error(`Stack "${name}" already exists`);

    const now = new Date().toISOString();
    const stack: Stack = {
      id: randomUUID(),
      name,
      trunk,
      repository: this.deps.config.repository ?? "demo",
      branches: [
        {
          level: 0,
          name: bottomBranch,
          base: trunk,
          lastKnownSha: await safeSha(this.deps.git, bottomBranch),
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.store.saveStack(stack);
    await this.deps.store.appendAudit({
      action: "stack.create",
      actor: this.actor,
      stackId: stack.id,
      summary: `Created stack "${name}" on trunk ${trunk} with bottom branch ${bottomBranch}`,
      applied: true,
    });
    return stack;
  }

  /** Add a branch on top of the current top of the stack. */
  async push(stackName: string, branch: string): Promise<Stack> {
    const stack = this.requireStack(stackName);
    if (stack.branches.some((b) => b.name === branch)) {
      throw new Error(`Branch ${branch} already in stack`);
    }
    const top = topBranch(stack);
    const level = stack.branches.length;
    stack.branches.push({
      level,
      name: branch,
      base: top.name,
      lastKnownSha: await safeSha(this.deps.git, branch),
    });
    await this.deps.store.saveStack(stack);
    await this.deps.store.appendAudit({
      action: "stack.push",
      actor: this.actor,
      stackId: stack.id,
      summary: `Pushed ${branch} onto stack (base: ${top.name})`,
      applied: true,
    });
    return stack;
  }

  // ---- pull requests ----------------------------------------------------

  /** Create PRs for any stacked branch that doesn't yet have one, bottom-up. */
  async createPullRequests(
    stackName: string,
    opts: { draft?: boolean } = {}
  ): Promise<PullRequest[]> {
    const stack = this.requireStack(stackName);
    const created: PullRequest[] = [];

    for (const b of [...stack.branches].sort((a, z) => a.level - z.level)) {
      if (b.prId) continue;
      const basePr = this.basePrOf(stack, b);
      const description = await this.buildDescription(stack, b, basePr);
      const pr = await this.deps.provider.createPullRequest({
        title: titleFor(b),
        description,
        sourceBranch: b.name,
        targetBranch: b.base,
        isDraft: opts.draft ?? false,
        dependsOn: basePr ? [basePr.id] : [],
      });
      b.prId = pr.id;
      this.prCache.set(pr.id, pr);
      created.push(pr);

      await this.deps.store.appendAudit({
        action: "pr.create",
        actor: this.actor,
        stackId: stack.id,
        summary: `Opened PR !${pr.id} for ${b.name} → ${b.base}`,
        details: { prId: pr.id, dependsOn: pr.dependsOn },
        applied: true,
      });

      if (basePr) {
        await this.deps.provider.addComment(
          pr.id,
          `🧩 **StackPilot**: this PR is stacked on !${basePr.id}. Review that one first.`
        );
        await this.deps.store.appendAudit({
          action: "pr.link",
          actor: this.actor,
          stackId: stack.id,
          summary: `Linked PR !${pr.id} to depend on !${basePr.id}`,
          applied: true,
        });
      }
    }
    await this.deps.store.saveStack(stack);
    return created;
  }

  /** (Re)generate AI descriptions for every PR in the stack and update them. */
  async describe(stackName: string, branchName?: string): Promise<PullRequest[]> {
    const stack = this.requireStack(stackName);
    const updated: PullRequest[] = [];
    await this.prsFor(stack); // populate PR cache for dependency linking
    const targets = branchName
      ? stack.branches.filter((b) => b.name === branchName)
      : stack.branches;

    for (const b of targets) {
      if (!b.prId) continue;
      const basePr = this.basePrOf(stack, b);
      const description = await this.buildDescription(stack, b, basePr);
      const pr = await this.deps.provider.updatePullRequest(b.prId, {
        description,
        dependsOn: basePr ? [basePr.id] : [],
      });
      updated.push(pr);
      await this.deps.store.appendAudit({
        action: "ai.describe",
        actor: this.actor,
        stackId: stack.id,
        summary: `AI regenerated description for PR !${pr.id} (${b.name})`,
        applied: true,
      });
    }
    return updated;
  }

  private async buildDescription(
    stack: Stack,
    b: StackedBranch,
    basePr?: PullRequest
  ): Promise<string> {
    const commits = await this.deps.git.commitsBetween(b.base, b.name);
    const changedFiles = await this.deps.git.changedFiles(b.base, b.name);
    return this.deps.ai.describePullRequest({
      stack,
      branch: b,
      commits,
      changedFiles,
      basePr,
    });
  }

  // ---- sync / restack ---------------------------------------------------

  /**
   * Detect branches whose base moved and plan the rebases needed to bring the
   * whole stack back in line. Mutating; honors the approval gate.
   */
  async sync(stackName: string, apply: boolean): Promise<PlanResult> {
    const stack = this.requireStack(stackName);
    const messages: string[] = [];
    const operations: PlannedOperation[] = [];

    for (const b of [...stack.branches].sort((a, z) => a.level - z.level)) {
      const currentSha = await safeSha(this.deps.git, b.name);
      const baseSha = await safeSha(this.deps.git, b.base);
      const drifted =
        b.lastKnownSha !== undefined && b.lastKnownSha !== currentSha;
      const baseMoved =
        (this.baseBranch(stack, b)?.lastKnownSha ?? baseSha) !== baseSha;

      if (drifted || baseMoved) {
        const rebase = this.deps.git.planRebase(b.name, b.base, b.base);
        const push = this.deps.git.planPush(b.name, true);
        operations.push(rebase, push);
        messages.push(
          `↻ ${b.name} needs restack onto ${b.base} (base moved / branch drifted)`
        );
      } else {
        messages.push(`✓ ${b.name} is up to date`);
      }
    }

    if (operations.length === 0) {
      return { operations, applied: false, messages };
    }

    return this.runOrGate({
      stack,
      action: "branch.sync",
      description: `Restack ${stack.name} (${operations.length / 2} branch(es))`,
      operations,
      apply,
      messages,
      effect: { kind: "sync", stackId: stack.id },
    });
  }

  // ---- merge ------------------------------------------------------------

  /**
   * Merge the bottom PR, then retarget and restack everything above it so
   * reviewer history on the upper PRs is preserved.
   */
  async merge(stackName: string, apply: boolean): Promise<PlanResult> {
    const stack = this.requireStack(stackName);
    const ordered = [...stack.branches].sort((a, z) => a.level - z.level);
    const bottom = ordered[0];
    if (!bottom?.prId) {
      throw new Error("Bottom of stack has no PR to merge");
    }

    const operations: PlannedOperation[] = [];
    const messages: string[] = [`Merge bottom PR !${bottom.prId} (${bottom.name}) into ${bottom.base}`];

    for (const b of ordered.slice(1)) {
      operations.push(this.deps.git.planRebase(b.name, bottom.base, bottom.name));
      operations.push(this.deps.git.planPush(b.name, true));
      messages.push(`Retarget ${b.name} onto ${b.base === bottom.name ? bottom.base : b.base}`);
    }

    return this.runOrGate({
      stack,
      action: "stack.merge",
      description: `Merge & restack ${stack.name}`,
      operations,
      apply,
      messages,
      effect: {
        kind: "merge",
        stackId: stack.id,
        bottomBranch: bottom.name,
        bottomPrId: bottom.prId,
      },
    });
  }

  /** Apply the semantic state change for an approved/immediate plan. */
  private async applyEffect(effect: StackEffect): Promise<void> {
    if (effect.kind === "sync") {
      const stack = this.requireStack(effect.stackId);
      for (const b of stack.branches) {
        b.lastKnownSha = await safeSha(this.deps.git, b.name);
      }
      await this.deps.store.saveStack(stack);
      return;
    }

    // merge: complete the bottom PR, drop it, re-level and retarget the rest.
    const stack = this.requireStack(effect.stackId);
    const ordered = [...stack.branches].sort((a, z) => a.level - z.level);
    const bottom = ordered[0];
    const trunkTarget = bottom.base;
    await this.deps.provider.completePullRequest(effect.bottomPrId);
    stack.branches = ordered.slice(1).map((b, i) => ({
      ...b,
      level: i,
      base: i === 0 ? trunkTarget : ordered[i].name,
    }));
    const newBottom = stack.branches[0];
    if (newBottom?.prId) {
      await this.deps.provider.updatePullRequest(newBottom.prId, {
        targetBranch: newBottom.base,
        dependsOn: [],
      });
    }
    await this.deps.store.saveStack(stack);
    await this.deps.store.appendAudit({
      action: "stack.merge",
      actor: this.actor,
      stackId: stack.id,
      summary: `Merged PR !${effect.bottomPrId} and restacked ${stack.branches.length} branch(es)`,
      applied: true,
    });
  }

  // ---- review -----------------------------------------------------------

  async reviewSummary(stackName: string, post: boolean): Promise<string> {
    const stack = this.requireStack(stackName);
    const prs = await this.prsFor(stack);
    const summary = await this.deps.ai.reviewStack({ stack, prs });

    if (post) {
      const bottom = [...stack.branches].sort((a, z) => a.level - z.level)[0];
      if (bottom?.prId) await this.deps.provider.addComment(bottom.prId, summary);
    }
    await this.deps.store.appendAudit({
      action: "review.summary",
      actor: this.actor,
      stackId: stack.id,
      summary: `Generated stack review summary${post ? " and posted to bottom PR" : ""}`,
      applied: post,
    });
    return summary;
  }

  // ---- approvals --------------------------------------------------------

  async approve(approvalId: string): Promise<PlanResult> {
    const req = this.deps.store.getApproval(approvalId);
    if (!req) throw new Error(`Approval ${approvalId} not found`);
    if (req.status !== "pending")
      throw new Error(`Approval ${approvalId} is already ${req.status}`);

    req.status = "approved";
    await this.deps.store.saveApproval(req);
    await this.deps.store.appendAudit({
      action: "approval.grant",
      actor: this.actor,
      stackId: req.stackId,
      summary: `Approved ${req.description}`,
      applied: false,
    });

    for (const op of req.operations) await this.deps.git.apply(op);
    if (req.effect) await this.applyEffect(req.effect);

    await this.deps.store.appendAudit({
      action: req.action,
      actor: this.actor,
      stackId: req.stackId,
      summary: `Applied ${req.operations.length} operation(s): ${req.description}`,
      details: { operations: req.operations.map((o) => o.command) },
      applied: true,
    });
    return { operations: req.operations, applied: true, messages: [`Applied: ${req.description}`] };
  }

  async deny(approvalId: string): Promise<void> {
    const req = this.deps.store.getApproval(approvalId);
    if (!req) throw new Error(`Approval ${approvalId} not found`);
    req.status = "denied";
    await this.deps.store.saveApproval(req);
    await this.deps.store.appendAudit({
      action: "approval.deny",
      actor: this.actor,
      stackId: req.stackId,
      summary: `Denied ${req.description}`,
      applied: false,
    });
  }

  // ---- helpers ----------------------------------------------------------

  /**
   * Either run mutating operations immediately (when apply=true and approval is
   * not required) or record a pending {@link ApprovalRequest} for later.
   */
  private async runOrGate(args: {
    stack: Stack;
    action: ApprovalRequest["action"];
    description: string;
    operations: PlannedOperation[];
    apply: boolean;
    messages: string[];
    effect: StackEffect;
  }): Promise<PlanResult> {
    const { stack, action, description, operations, apply, messages, effect } = args;

    const needsApproval = this.deps.config.requireApproval;

    if (!apply) {
      return { operations, applied: false, messages: [...messages, "(dry run — pass --apply to execute)"] };
    }

    if (needsApproval) {
      const req: ApprovalRequest = {
        id: randomUUID(),
        stackId: stack.id,
        action,
        description,
        operations,
        effect,
        createdAt: new Date().toISOString(),
        status: "pending",
      };
      await this.deps.store.saveApproval(req);
      await this.deps.store.appendAudit({
        action: "approval.request",
        actor: this.actor,
        stackId: stack.id,
        summary: `Requested approval: ${description}`,
        details: { approvalId: req.id, operations: operations.map((o) => o.command) },
        applied: false,
      });
      return {
        operations,
        applied: false,
        approval: req,
        messages: [...messages, `Approval required. Run: stackpilot approve ${req.id}`],
      };
    }

    for (const op of operations) await this.deps.git.apply(op);
    await this.applyEffect(effect);
    await this.deps.store.appendAudit({
      action,
      actor: this.actor,
      stackId: stack.id,
      summary: `Applied: ${description}`,
      details: { operations: operations.map((o) => o.command) },
      applied: true,
    });
    return { operations, applied: true, messages: [...messages, `Applied: ${description}`] };
  }

  requireStack(nameOrId: string): Stack {
    const stack = this.deps.store.getStack(nameOrId);
    if (!stack) throw new Error(`Stack "${nameOrId}" not found`);
    return stack;
  }

  private baseBranch(stack: Stack, b: StackedBranch): StackedBranch | undefined {
    return stack.branches.find((x) => x.name === b.base);
  }

  private basePrOf(stack: Stack, b: StackedBranch): PullRequest | undefined {
    const base = this.baseBranch(stack, b);
    if (!base?.prId) return undefined;
    // Synchronous view is enough for linking; details are fetched on demand.
    return this.prCache.get(base.prId);
  }

  private prCache = new Map<number, PullRequest>();

  async prsFor(stack: Stack): Promise<PullRequest[]> {
    const prs: PullRequest[] = [];
    for (const b of stack.branches) {
      if (!b.prId) continue;
      const pr = await this.deps.provider.getPullRequest(b.prId);
      if (pr) {
        this.prCache.set(pr.id, pr);
        prs.push(pr);
      }
    }
    return prs;
  }
}

function topBranch(stack: Stack): StackedBranch {
  return [...stack.branches].sort((a, b) => b.level - a.level)[0];
}

function titleFor(b: StackedBranch): string {
  const tail = b.name.split("/").pop() ?? b.name;
  return tail.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function safeSha(git: GitService, branch: string): Promise<string | undefined> {
  try {
    return await git.headSha(branch);
  } catch {
    return undefined;
  }
}
