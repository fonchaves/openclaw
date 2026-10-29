import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createBaselineFixture } from "./pr-baseline-native.test-support.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const bindingRef = "refs/openclaw/pr-workflow-bindings/42";
const lockRef = "refs/openclaw/pr-operation-locks/42";
const retained = [
  "prep-context.env",
  "pr-meta.json",
  "pr-meta.env",
  "review.json",
  "correction-review.json",
  "correction-incoming-review.json",
  "prep.env",
];

function fixture(baseline = false) {
  const f = createBaselineFixture(temps.make("pr-workflow-successor-"), 1);
  if (baseline) {
    f.pass("prepare-baseline-refresh", f.manifest(f.advanceMain("baseline")));
    f.approve();
  }
  const head = f.prepGit("rev-parse", "HEAD");
  const tree = f.prepGit("rev-parse", "HEAD^{tree}");
  // Only this completed prep.env retains the GraphQL alias. There is no
  // push/sync result from which a successor could reconstruct its authority.
  const hosted = f.prepGit("commit-tree", "-S", tree, "-p", f.incoming, "-m", "Hosted alias");
  f.git(f.repo, "update-ref", "refs/heads/topic", hosted);
  f.preparePublication();
  const complete = spawnSync(
    process.platform === "darwin" ? "/bin/bash" : "bash",
    [
      "-c",
      `
set -euo pipefail
source "$1/scripts/pr-lib/prepare-core.sh"
source .local/prep-context.env
source .local/gates.env
PR_AUTHOR=fixture
PUSH_REPLACED_HOSTED_ANCESTRY=false
resolve_contributor_coauthor_email() { return 1; }
complete_prepare_push "$2" "$3" "$4" "$4" "$2"
`,
      "complete-fixture",
      f.repo,
      hosted,
      head,
      f.incoming,
    ],
    { cwd: f.worktree, env: f.env, encoding: "utf8" },
  );
  expectExit(complete, 0);
  f.writeLocal("gates-build.log", "previous exact-head build\n");
  const binding = f.git(f.repo, "rev-parse", bindingRef);
  const source = JSON.parse(f.git(f.repo, "show", `${binding}:binding.json`)).source as string;
  writeFileSync(join(f.repo, "workflow-version"), "repaired workflow\n");
  f.git(f.repo, "add", "workflow-version");
  f.git(f.repo, "commit", "-qm", "fix: workflow successor fixture");
  const current = f.git(f.repo, "rev-parse", "HEAD");
  // Authenticate the official source spelling while keeping every transport
  // inside the fixture's real local Git repository.
  f.git(f.repo, "config", `url.${f.repo}.insteadOf`, "https://github.com/openclaw/openclaw.git");
  f.git(f.repo, "remote", "set-url", "origin", "https://github.com/openclaw/openclaw.git");
  f.git(f.repo, "fetch", "-q", "origin", "main");
  const review = f.prepGit("hash-object", "--no-filters", f.local("correction-review.json"));
  const values = {
    "--expected-binding": binding,
    "--from-workflow": source,
    "--to-workflow": current,
    "--expected-head": head,
    "--expected-tree": tree,
    "--expected-review": review,
    "--expected-hosted-head": hosted,
  };
  const args = (overrides: Partial<typeof values> = {}) =>
    Object.entries({ ...values, ...overrides }).flat();
  const files = f.snapshot([...retained, ...(baseline ? ["prepare-baseline.json"] : [])]);
  const originalGate = f.readLocal("gates.env");
  const unchanged = () => {
    f.expectSnapshot(files);
    expect(f.prepGit("rev-parse", "HEAD")).toBe(head);
    expect(f.prepGit("rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(f.prepGit("status", "--porcelain", "--untracked-files=no")).toBe("");
    f.prepGit("verify-commit", head);
    f.prepGit("verify-commit", hosted);
    f.git(f.repo, "verify-commit", current);
  };
  const transition = (extra: NodeJS.ProcessEnv = {}) =>
    f.run("prepare-workflow-successor", args(), extra);
  return {
    ...f,
    binding,
    source,
    current,
    head,
    tree,
    hosted,
    review,
    args,
    unchanged,
    transition,
    originalGate,
  };
}

function expectExit(result: ReturnType<typeof spawnSync>, status: number) {
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(status);
}

function gitFault(f: ReturnType<typeof fixture>, phase: "before CAS" | "after CAS" | "race") {
  const realGit = spawnSync("sh", ["-c", "command -v git"], {
    env: f.env,
    encoding: "utf8",
  }).stdout.trim();
  const probe = join(f.root, "git-fault");
  writeFileSync(
    probe,
    `#!/usr/bin/env python3
import os,subprocess,sys
args=sys.argv[1:]
if args[-3:] == ['update-ref','--no-deref','--stdin']:
 data=sys.stdin.buffer.read()
 if ${JSON.stringify("update " + bindingRef + " ")}.encode() in data:
  open(${JSON.stringify(join(f.root, "fault-reached"))},'w').write(${JSON.stringify(phase)})
  ${phase === "race" ? `subprocess.check_call([${JSON.stringify(realGit)},'-C',${JSON.stringify(f.repo)},'update-ref',${JSON.stringify(bindingRef)},${JSON.stringify(f.head)}])` : "pass"}
  ${phase === "after CAS" || phase === "race" ? `result=subprocess.run([${JSON.stringify(realGit)},*args],input=data); ${phase === "race" ? "sys.exit(result.returncode)" : "result.check_returncode()"}` : "pass"}
  sys.stderr.write('fixture ${phase} interruption\\n'); sys.exit(74)
 sys.exit(subprocess.run([${JSON.stringify(realGit)},*args],input=data).returncode)
os.execv(${JSON.stringify(realGit)},[${JSON.stringify(realGit)},*args])
`,
    { mode: 0o700 },
  );
  return { OPENCLAW_PR_GIT: probe };
}

describePosix("correction-only workflow succession", () => {
  it.each([false, true])(
    "preserves signed correction and alias authority, baseline=%s",
    (baseline) => {
      const f = fixture(baseline);
      const previousArchives = new Set(readdirSync(join(f.worktree, ".local")));
      expectExit(f.transition(), 0);
      f.unchanged();
      f.expectAbsent("gates.env", "prepare-push-result.env", "prepare-sync-result.env");
      const next = f.git(f.repo, "rev-parse", bindingRef);
      const record = JSON.parse(f.git(f.repo, "show", `${next}:binding.json`));
      expect(record).toMatchObject({
        version: 2,
        predecessor: f.binding,
        source: f.current,
        continuation: { head: f.head, tree: f.tree, hostedHead: f.hosted, review: f.review },
      });
      expect(f.git(f.repo, "rev-parse", `${next}^@`).split("\n")).toEqual([
        f.binding,
        f.current,
        f.head,
        f.hosted,
      ]);
      const archives = readdirSync(join(f.worktree, ".local")).filter(
        (name) => name.startsWith("prep-evidence.") && !previousArchives.has(name),
      );
      expect(archives).toHaveLength(1);
      for (const name of previousArchives) {
        if (name.startsWith("prep-evidence.")) expect(existsSync(f.local(name))).toBe(true);
      }
      const [archive] = archives;
      expect(readFileSync(f.local(`${archive}/gates.env`)).equals(f.originalGate)).toBe(true);
      expect(readFileSync(f.local(`${archive}/prep.env`)).equals(f.readLocal("prep.env"))).toBe(
        true,
      );
      // These are the normal command owners, not a substitute gate checker.
      for (const command of ["prepare-push", "prepare-sync-head", "merge-verify"]) {
        const denied = f.run(command);
        expect(denied.status, denied.stdout + denied.stderr).not.toBe(0);
        expect(denied.stdout + denied.stderr).toContain("gates.env");
        expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.hosted);
      }
      f.unchanged();
    },
  );

  it.each([
    "binding",
    "from",
    "to",
    "head",
    "tree",
    "review",
    "hosted",
    "mode",
    "capture",
    "pending",
    "lock",
  ])("refuses %s drift before retiring qualification", (fault) => {
    const f = fixture();
    const overrides: Parameters<typeof f.args>[0] = {};
    const key = (
      {
        binding: "--expected-binding",
        from: "--from-workflow",
        to: "--to-workflow",
        head: "--expected-head",
        tree: "--expected-tree",
        review: "--expected-review",
        hosted: "--expected-hosted-head",
      } as Record<string, string>
    )[fault];
    if (key) Object.assign(overrides, { [key]: f.incoming });
    if (fault === "mode")
      f.writeLocal(
        "prep-context.env",
        f
          .readLocal("prep-context.env")
          .toString()
          .replace("PREP_REVIEW_MODE=correction", "PREP_REVIEW_MODE=ready"),
      );
    if (fault === "capture") f.writeLocal("merge-output.log", "");
    if (fault === "pending") f.writeLocal("gates.env", "PENDING_CRABBOX_RUN_ID=123\n");
    if (fault === "lock") f.git(f.repo, "update-ref", lockRef, f.head);
    const gate = f.readLocal("gates.env");
    const result = f.run("prepare-workflow-successor", f.args(overrides));
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(f.git(f.repo, "rev-parse", bindingRef)).toBe(f.binding);
    expect(f.readLocal("gates.env").equals(gate)).toBe(true);
    expect(f.prepGit("rev-parse", "HEAD")).toBe(f.head);
  });

  it.each(["before invalidation", "before CAS", "after CAS", "race"] as const)(
    "retains authority through %s interruption",
    (phase) => {
      const f = fixture();
      let extra: NodeJS.ProcessEnv;
      if (phase === "before invalidation") {
        const realRm = spawnSync("sh", ["-c", "command -v rm"], {
          env: f.env,
          encoding: "utf8",
        }).stdout.trim();
        writeFileSync(
          join(f.root, "bin/rm"),
          `#!/bin/sh\nif [ "$1" = .local/gates.env ]; then exit 74; fi\nexec '${realRm}' "$@"\n`,
          { mode: 0o700 },
        );
        extra = {};
      } else extra = gitFault(f, phase);
      const result = f.transition(extra);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      if (phase !== "before invalidation")
        expect(readFileSync(join(f.root, "fault-reached"), "utf8")).toBe(phase);
      f.unchanged();
      expect(existsSync(f.local("gates.env"))).toBe(phase === "before invalidation");
      const next = f.git(f.repo, "rev-parse", bindingRef);
      if (phase === "after CAS") {
        expect(JSON.parse(f.git(f.repo, "show", `${next}:binding.json`))).toMatchObject({
          predecessor: f.binding,
          source: f.current,
        });
      } else expect(next).toBe(phase === "race" ? f.head : f.binding);
      expect(
        readdirSync(join(f.worktree, ".local")).some((name) => name.startsWith("prep-evidence.")),
      ).toBe(true);
    },
  );

  it("rejects generic/current-workflow switches and duplicate selectors at the actual entrypoint", () => {
    const f = fixture();
    for (const args of [
      f.args().slice(0, -1),
      [...f.args(), "--current-workflow"],
      [...f.args().slice(0, -2), "--expected-head", f.head],
    ]) {
      expectExit(f.run("prepare-workflow-successor", args), 2);
    }
    expect(f.git(f.repo, "rev-parse", bindingRef)).toBe(f.binding);
    f.unchanged();
  });
});
