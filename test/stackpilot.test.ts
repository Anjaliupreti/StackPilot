import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MockAIProvider } from "../src/ai/mockAi.js";
import { parseComment } from "../src/cli/commentCommands.js";
import { StackManager } from "../src/core/stackManager.js";
import type { StackPilotConfig } from "../src/core/types.js";
import { MockGitService } from "../src/git/gitService.js";
import {
  embedDependsOn,
  parseDependsOn,
  stripDependsOn,
} from "../src/providers/ado/adoProvider.js";
import { MockProvider } from "../src/providers/mock/mockProvider.js";
import { StackStore } from "../src/store/stackStore.js";

async function makeEngine(root: string) {
  await rm(join(root, ".stackpilot"), { recursive: true, force: true });
  const store = new StackStore(root);
  await store.load();
  const config: StackPilotConfig = {
    provider: "mock",
    ai: "mock",
    trunk: "main",
    repository: "test-repo",
    requireApproval: false,
    actor: "tester",
  };
  await store.setConfig(config);
  const provider = new MockProvider({ branches: ["main"] });
  const git = new MockGitService();
  const engine = new StackManager({
    provider,
    git,
    ai: new MockAIProvider(),
    store,
    config,
  });
  return { engine, provider, store };
}

test("dependsOn marker round-trips through a description", () => {
  const desc = "Some PR body.";
  const embedded = embedDependsOn(desc, [101, 102]);
  assert.deepEqual(parseDependsOn(embedded), [101, 102]);
  assert.equal(stripDependsOn(embedded), "Some PR body.");
  // Re-embedding does not duplicate the marker.
  const reembedded = embedDependsOn(embedded, [103]);
  assert.deepEqual(parseDependsOn(reembedded), [103]);
  assert.equal((reembedded.match(/stackpilot:depends-on/g) ?? []).length, 1);
});

test("parseComment recognises triggers and verbs", () => {
  assert.deepEqual(parseComment("/stackpilot sync now")?.verb, "sync");
  assert.deepEqual(parseComment("/sp status")?.verb, "status");
  assert.deepEqual(parseComment("@stackpilot review")?.verb, "review");
  assert.equal(parseComment("just a normal comment"), undefined);
});

test("PRs are created bottom-up with dependency links", async () => {
  const { engine } = await makeEngine(join(tmpdir(), "stackpilot-test-deps"));
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.push("s", "c");
  const prs = await engine.createPullRequests("s");
  assert.equal(prs.length, 3);
  // bottom has no deps; each upper depends on the one below.
  assert.deepEqual(prs[0].dependsOn, []);
  assert.deepEqual(prs[1].dependsOn, [prs[0].id]);
  assert.deepEqual(prs[2].dependsOn, [prs[1].id]);
  assert.equal(prs[0].targetBranch, "main");
  assert.equal(prs[1].targetBranch, "a");
});

test("merge completes the bottom PR and restacks the rest onto trunk", async () => {
  const root = join(tmpdir(), "stackpilot-test-merge");
  const { engine, provider } = await makeEngine(root);
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.createPullRequests("s");
  const result = await engine.merge("s", true);
  assert.equal(result.applied, true);

  const stack = engine.requireStack("s");
  assert.equal(stack.branches.length, 1);
  assert.equal(stack.branches[0].name, "b");
  assert.equal(stack.branches[0].base, "main");

  const prs = await provider.listPullRequests();
  const bottom = prs.find((p) => p.sourceBranch === "a");
  const upper = prs.find((p) => p.sourceBranch === "b");
  assert.equal(bottom?.status, "completed");
  assert.equal(upper?.targetBranch, "main");
  assert.deepEqual(upper?.dependsOn, []);
});

test("approval gate defers mutating sync until approved", async () => {
  const root = join(tmpdir(), "stackpilot-test-approval");
  await rm(join(root, ".stackpilot"), { recursive: true, force: true });
  const store = new StackStore(root);
  await store.load();
  const config: StackPilotConfig = {
    provider: "mock",
    ai: "mock",
    trunk: "main",
    requireApproval: true,
    actor: "tester",
  };
  await store.setConfig(config);
  const git = new MockGitService();
  const engine = new StackManager({
    provider: new MockProvider(),
    git,
    ai: new MockAIProvider(),
    store,
    config,
  });
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.createPullRequests("s");
  git.bumpSha("a");

  const plan = await engine.sync("s", true);
  assert.equal(plan.applied, false);
  assert.ok(plan.approval, "a pending approval should be created");
  assert.equal(git.applied.length, 0, "no git ops before approval");

  await engine.approve(plan.approval!.id);
  assert.ok(git.applied.length > 0, "git ops run after approval");
  assert.equal(store.listApprovals("approved").length, 1);
});
