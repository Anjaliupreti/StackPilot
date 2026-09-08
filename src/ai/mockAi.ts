import type {
  AIProvider,
  DescribeContext,
  ReviewContext,
} from "./aiProvider.js";
import type { Stack } from "../core/types.js";

/**
 * Deterministic, template-driven AI stand-in. Produces the same class of output
 * a real LLM would (structured, reviewer-friendly descriptions and stack
 * summaries) without any network dependency, so demos are reproducible.
 */
export class MockAIProvider implements AIProvider {
  readonly name = "mock-ai";

  async describePullRequest(ctx: DescribeContext): Promise<string> {
    const { stack, branch, commits, changedFiles, basePr } = ctx;
    const position = branch.level + 1;
    const total = stack.branches.length;

    const summary = summarizeCommits(commits);
    const areas = summarizeAreas(changedFiles);

    const lines: string[] = [];
    lines.push(`## ${titleFromBranch(branch.name)}`);
    lines.push("");
    lines.push(
      `> Part **${position} of ${total}** in stack \`${stack.name}\`.`
    );
    if (basePr) {
      lines.push(
        `> Stacked on top of PR !${basePr.id} (\`${branch.base}\`). Review that one first.`
      );
    } else {
      lines.push(`> Bottom of the stack; targets \`${branch.base}\`.`);
    }
    lines.push("");
    lines.push("### What this change does");
    lines.push(summary);
    lines.push("");

    if (areas.length) {
      lines.push("### Areas touched");
      for (const a of areas) lines.push(`- ${a}`);
      lines.push("");
    }

    if (commits.length) {
      lines.push("### Commits");
      for (const c of commits.slice(0, 10)) lines.push(`- ${c}`);
      if (commits.length > 10) lines.push(`- …and ${commits.length - 10} more`);
      lines.push("");
    }

    lines.push("### Review guidance");
    lines.push(reviewGuidance(position, total, changedFiles.length));
    lines.push("");
    lines.push(renderStackMap(stack, branch.name));

    return lines.join("\n");
  }

  async reviewStack(ctx: ReviewContext): Promise<string> {
    const { stack, prs } = ctx;
    const byBranch = new Map(prs.map((p) => [p.sourceBranch, p]));
    const lines: string[] = [];
    lines.push(`# Stack review: ${stack.name}`);
    lines.push("");
    lines.push(
      `This stack contains **${stack.branches.length}** dependent pull requests. ` +
        `Review bottom-up so each diff stays small and self-contained.`
    );
    lines.push("");
    lines.push("| # | PR | Branch | Targets | Status |");
    lines.push("|---|----|--------|---------|--------|");
    for (const b of stack.branches) {
      const pr = byBranch.get(b.name);
      lines.push(
        `| ${b.level + 1} | ${pr ? "!" + pr.id : "—"} | \`${b.name}\` | \`${b.base}\` | ${
          pr?.status ?? "not created"
        } |`
      );
    }
    lines.push("");
    lines.push("## Suggested review order");
    for (const b of stack.branches) {
      const pr = byBranch.get(b.name);
      lines.push(
        `${b.level + 1}. ${pr ? "PR !" + pr.id : "`" + b.name + "`"} — ${
          b.level === 0
            ? "foundational change, merge-ready first"
            : "builds on the previous PR"
        }`
      );
    }
    lines.push("");
    lines.push(
      "> ⚠️ Merging any PR out of order will force a restack of everything above it."
    );
    return lines.join("\n");
  }

  async guidance(prompt: string, stack?: Stack): Promise<string> {
    const p = prompt.toLowerCase();
    if (p.includes("sync") || p.includes("rebase")) {
      return (
        "To sync the stack, StackPilot will rebase each branch onto its updated " +
        "base from the bottom up. This is a mutating operation and requires approval. " +
        "Run `stackpilot sync --apply` (or comment `/stackpilot sync`)."
      );
    }
    if (p.includes("merge")) {
      return (
        "Merge the bottom PR first, then StackPilot retargets and restacks the " +
        "branches above it so no reviewer work is lost."
      );
    }
    if (p.includes("split")) {
      return (
        "Consider splitting large branches into stacked PRs of <400 lines each so " +
        "reviewers can approve incrementally."
      );
    }
    const name = stack ? ` for stack \`${stack.name}\`` : "";
    return (
      `Here's what I can do${name}: create PRs with dependency links, ` +
      "generate reviewer-friendly descriptions, keep branches in sync, and " +
      "produce a stack-aware review summary. Try `/stackpilot help`."
    );
  }
}

function titleFromBranch(branch: string): string {
  const tail = branch.split("/").pop() ?? branch;
  return tail
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function summarizeCommits(commits: string[]): string {
  if (!commits.length) return "_No new commits detected on this branch yet._";
  const verbs = commits
    .map((c) => c.split(/\s+/)[0].toLowerCase())
    .filter(Boolean);
  const uniqueVerbs = [...new Set(verbs)].slice(0, 3);
  const lead = commits[0].replace(/\.$/, "");
  return (
    `${lead}. This branch groups ${commits.length} commit(s) focused on ` +
    `${uniqueVerbs.join(", ")}, isolated from the rest of the stack for easier review.`
  );
}

function summarizeAreas(files: string[]): string[] {
  const dirs = new Map<string, number>();
  for (const f of files) {
    const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "(root)";
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  return [...dirs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([dir, n]) => `\`${dir}\` (${n} file${n === 1 ? "" : "s"})`);
}

function reviewGuidance(position: number, total: number, fileCount: number): string {
  const size =
    fileCount <= 5
      ? "small and quick to review"
      : fileCount <= 20
        ? "moderately sized"
        : "large — consider splitting further";
  const order =
    position === 1
      ? "Start here: this is the foundation the rest of the stack builds on."
      : `Review PRs 1–${position - 1} first; this diff only shows changes on top of them.`;
  return `This change is ${size}. ${order}`;
}

function renderStackMap(stack: Stack, current: string): string {
  const lines = ["### Stack", "```"];
  const ordered = [...stack.branches].sort((a, b) => b.level - a.level);
  for (const b of ordered) {
    const marker = b.name === current ? "▶" : " ";
    lines.push(`${marker} ${"  ".repeat(b.level)}${b.name}`);
  }
  lines.push(`  ${stack.trunk} (trunk)`);
  lines.push("```");
  return lines.join("\n");
}
