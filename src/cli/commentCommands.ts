import type { AIProvider } from "../ai/aiProvider.js";
import type { StackManager } from "../core/stackManager.js";

export interface CommentCommand {
  verb: string;
  args: string[];
  raw: string;
}

const TRIGGERS = ["/stackpilot", "/sp", "@stackpilot"];

/**
 * Parse a PR comment into a StackPilot command. Returns undefined when the
 * comment doesn't address StackPilot. Mirrors how an ADO comment webhook would
 * feed comment text into the engine.
 */
export function parseComment(comment: string): CommentCommand | undefined {
  const text = comment.trim();
  const lower = text.toLowerCase();
  const trigger = TRIGGERS.find((t) => lower.startsWith(t));
  if (!trigger) return undefined;

  const rest = text.slice(trigger.length).trim();
  const [verb = "help", ...args] = rest.split(/\s+/).filter(Boolean);
  return { verb: verb.toLowerCase(), args, raw: text };
}

export interface CommentResult {
  reply: string;
  /** Whether the command performed (or queued) a mutating action. */
  mutated: boolean;
}

/**
 * Execute a parsed comment command against a stack. Every reply is phrased as a
 * PR comment StackPilot would post back, keeping the human in the loop.
 */
export async function dispatchComment(
  engine: StackManager,
  ai: AIProvider,
  stackName: string,
  cmd: CommentCommand,
  opts: { apply?: boolean } = {}
): Promise<CommentResult> {
  const apply = opts.apply ?? false;
  switch (cmd.verb) {
    case "help":
      return { reply: HELP, mutated: false };

    case "status": {
      const stack = engine.requireStack(stackName);
      const prs = await engine.prsFor(stack);
      const lines = stack.branches
        .sort((a, b) => a.level - b.level)
        .map((b) => {
          const pr = prs.find((p) => p.sourceBranch === b.name);
          return `${b.level + 1}. \`${b.name}\` → \`${b.base}\` ${pr ? "(!" + pr.id + ", " + pr.status + ")" : "(no PR)"}`;
        });
      return {
        reply: `📚 **Stack ${stack.name}**\n${lines.join("\n")}`,
        mutated: false,
      };
    }

    case "describe": {
      const updated = await engine.describe(stackName, cmd.args[0]);
      return {
        reply: `📝 StackPilot refreshed ${updated.length} PR description(s).`,
        mutated: true,
      };
    }

    case "review": {
      const summary = await engine.reviewSummary(stackName, apply);
      return {
        reply: apply ? `Posted stack review:\n\n${summary}` : summary,
        mutated: apply,
      };
    }

    case "sync":
    case "restack": {
      const result = await engine.sync(stackName, apply);
      return {
        reply: `🔄 **Sync plan**\n${result.messages.map((m) => "- " + m).join("\n")}`,
        mutated: result.applied,
      };
    }

    case "merge": {
      const result = await engine.merge(stackName, apply);
      return {
        reply: `🚀 **Merge plan**\n${result.messages.map((m) => "- " + m).join("\n")}`,
        mutated: result.applied,
      };
    }

    case "approve": {
      const id = cmd.args[0];
      if (!id) return { reply: "Usage: `/stackpilot approve <approvalId>`", mutated: false };
      const result = await engine.approve(id);
      return { reply: `✅ ${result.messages.join(" ")}`, mutated: true };
    }

    case "deny": {
      const id = cmd.args[0];
      if (!id) return { reply: "Usage: `/stackpilot deny <approvalId>`", mutated: false };
      await engine.deny(id);
      return { reply: `🚫 Denied approval ${id}.`, mutated: false };
    }

    default: {
      // Fall back to AI guidance for free-form questions.
      const stack = engine.requireStack(stackName);
      const guidance = await ai.guidance(cmd.raw, stack);
      return { reply: `🤖 ${guidance}`, mutated: false };
    }
  }
}

const HELP = `🧭 **StackPilot commands** (comment on any PR in the stack)
- \`/stackpilot status\` — show the stack and PR states
- \`/stackpilot describe [branch]\` — regenerate reviewer-friendly descriptions
- \`/stackpilot review\` — post a stack-aware review summary
- \`/stackpilot sync\` — restack branches whose base moved (needs approval)
- \`/stackpilot merge\` — merge the bottom PR and restack the rest
- \`/stackpilot approve <id>\` / \`deny <id>\` — act on a pending approval`;
