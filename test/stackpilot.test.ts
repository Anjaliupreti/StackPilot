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
  return { engine, git, provider, store };
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

test("submit reuses existing PRs and creates only missing PRs", async () => {
  const { engine, git, provider } = await makeEngine(
    join(tmpdir(), "stackpilot-test-submit")
  );
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.push("s", "c");
  const first = await provider.createPullRequest({
    title: "A",
    description: "",
    sourceBranch: "a",
    targetBranch: "main",
    dependsOn: [],
  });
  const second = await provider.createPullRequest({
    title: "B",
    description: "",
    sourceBranch: "b",
    targetBranch: "a",
    dependsOn: [first.id],
  });

  const result = await engine.submit("s");
  const prs = await provider.listPullRequests();

  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].sourceBranch, "c");
  assert.deepEqual(
    result.reused.map((pr) => pr.id),
    [first.id, second.id]
  );
  assert.equal(prs.length, 3);
  assert.deepEqual(
    git.applied.map((op) => op.command),
    [
      "git push origin a",
      "git push origin b",
      "git push origin c",
    ]
  );
  assert.equal(provider.comments.length, 1);
  assert.equal(provider.comments[0].prId, result.created[0].id);
});

test("submit corrects PR links without duplicating PRs or comments", async () => {
  const { engine, provider } = await makeEngine(
    join(tmpdir(), "stackpilot-test-submit-idempotent")
  );
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  const first = await provider.createPullRequest({
    title: "A",
    description: "",
    sourceBranch: "a",
    targetBranch: "wrong-base",
    dependsOn: [999],
  });
  const second = await provider.createPullRequest({
    title: "B",
    description: "",
    sourceBranch: "b",
    targetBranch: "main",
    dependsOn: [],
  });

  const firstRun = await engine.submit("s");
  const secondRun = await engine.submit("s");
  const prs = await provider.listPullRequests();

  assert.equal(firstRun.updated.length, 2);
  assert.equal(secondRun.created.length, 0);
  assert.equal(secondRun.updated.length, 0);
  assert.equal(secondRun.reused.length, 2);
  assert.equal(prs.length, 2);
  assert.equal(provider.comments.length, 1);
  assert.equal(prs.find((pr) => pr.id === first.id)?.targetBranch, "main");
  assert.deepEqual(prs.find((pr) => pr.id === first.id)?.dependsOn, []);
  assert.equal(prs.find((pr) => pr.id === second.id)?.targetBranch, "a");
  assert.deepEqual(prs.find((pr) => pr.id === second.id)?.dependsOn, [
    first.id,
  ]);
});

test("submit rejects a branch that does not contain its parent", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-invalid-ancestry")
  );
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  git.setAncestor("a", "b", false);

  await assert.rejects(
    engine.submit("s"),
    /b does not contain a in its history/
  );
  assert.equal(git.applied.length, 0);
});

test("validation rejects missing branches and merge commits", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-invalid-history")
  );
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  git.deleteBranch("b");
  await assert.rejects(engine.submit("s"), /Branch b does not exist locally/);

  git.setSha("b", "b-v1");
  git.setMergeCommits("a", "b", ["merge-1"]);
  await assert.rejects(
    engine.submit("s"),
    /b contains 1 merge commit/
  );
});

test("sync and merge require a clean working tree and no active rebase", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-git-preflight")
  );
  await engine.createStack("s", "main", "a");
  git.setDirty(true);
  await assert.rejects(engine.sync("s", false), /uncommitted changes/);
  await assert.rejects(engine.merge("s", false), /uncommitted changes/);

  git.setDirty(false);
  git.setRebaseInProgress(true);
  await assert.rejects(engine.submit("s"), /rebase is already in progress/);
});

test("navigation switches between ordered stack branches", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-navigation")
  );
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.push("s", "c");

  assert.equal(await engine.navigate("s", "bottom"), "a");
  assert.equal(await engine.navigate("s", "up"), "b");
  assert.equal(await engine.navigate("s", "top"), "c");
  assert.equal(await engine.navigate("s", "up"), "c");
  assert.equal(await engine.navigate("s", "down"), "b");
  assert.equal(await engine.navigate("s", "trunk"), "main");
  assert.equal(await git.currentBranch(), "main");
});

test("merge completes the bottom PR and restacks the rest onto trunk", async () => {
  const root = join(tmpdir(), "stackpilot-test-merge");
  const { engine, git, provider } = await makeEngine(root);
  git.setSha("main", "main-v1");
  git.setSha("a", "a-v1");
  git.setSha("b", "b-v1");
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.createPullRequests("s");
  const result = await engine.merge("s", true);
  assert.equal(result.applied, true);
  assert.deepEqual(
    result.operations.map((op) => op.command),
    [
      "git rebase --onto main a-v1 b",
      "git push --force-with-lease origin b",
    ]
  );

  const stack = engine.requireStack("s");
  assert.equal(stack.branches.length, 1);
  assert.equal(stack.branches[0].name, "b");
  assert.equal(stack.branches[0].base, "main");
  assert.equal(stack.branches[0].lastKnownBaseSha, "main-v1");

  const prs = await provider.listPullRequests();
  const bottom = prs.find((p) => p.sourceBranch === "a");
  const upper = prs.find((p) => p.sourceBranch === "b");
  assert.equal(bottom?.status, "completed");
  assert.equal(upper?.targetBranch, "main");
  assert.deepEqual(upper?.dependsOn, []);
});

test("merge restacks every remaining branch onto its updated parent", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-merge-cascade")
  );
  git.setSha("main", "main-v1");
  git.setSha("a", "a-v1");
  git.setSha("b", "b-v1");
  git.setSha("c", "c-v1");
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.push("s", "c");
  await engine.createPullRequests("s");

  const result = await engine.merge("s", true);

  assert.deepEqual(
    result.operations.map((op) => op.command),
    [
      "git rebase --onto main a-v1 b",
      "git push --force-with-lease origin b",
      "git rebase --onto b b-v1 c",
      "git push --force-with-lease origin c",
    ]
  );
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

test("sync rebases from the recorded base SHA when trunk moves", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-trunk-rebase")
  );
  git.setSha("main", "main-v1");
  git.setSha("a", "a-v1");
  git.setSha("b", "b-v1");
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");

  git.setSha("main", "main-v2");
  const plan = await engine.sync("s", false);

  assert.deepEqual(
    plan.operations.map((op) => op.command),
    [
      "git rebase --onto main main-v1 a",
      "git push --force-with-lease origin a",
      "git rebase --onto a a-v1 b",
      "git push --force-with-lease origin b",
    ]
  );
});

test("sync cascades upward when a lower stack branch moves", async () => {
  const { engine, git } = await makeEngine(
    join(tmpdir(), "stackpilot-test-cascade-rebase")
  );
  git.setSha("main", "main-v1");
  git.setSha("a", "a-v1");
  git.setSha("b", "b-v1");
  git.setSha("c", "c-v1");
  await engine.createStack("s", "main", "a");
  await engine.push("s", "b");
  await engine.push("s", "c");

  git.setSha("a", "a-v2");
  const plan = await engine.sync("s", false);

  assert.deepEqual(
    plan.operations.map((op) => op.command),
    [
      "git rebase --onto a a-v1 b",
      "git push --force-with-lease origin b",
      "git rebase --onto b b-v1 c",
      "git push --force-with-lease origin c",
    ]
  );
});
