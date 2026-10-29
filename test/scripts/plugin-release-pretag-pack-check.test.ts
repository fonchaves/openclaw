// Plugin release pretag pack check tests cover its script-local target and command routing.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pluginReleasePretagExitCode,
  runPluginReleasePretagPackCheck,
} from "../../scripts/plugin-release-pretag-pack-check.ts";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

const { runManagedCommandMock } = vi.hoisted(() => ({
  runManagedCommandMock: vi.fn(),
}));

vi.mock("../../scripts/lib/managed-child-process.mts", async () => {
  const actual = await vi.importActual<
    typeof import("../../scripts/lib/managed-child-process.mts")
  >("../../scripts/lib/managed-child-process.mts");
  return {
    ...actual,
    runManagedCommand: runManagedCommandMock,
  };
});

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
  runManagedCommandMock.mockReset();
  vi.unstubAllEnvs();
});

function createDualPublishPluginRepo() {
  const repoDir = makeTempRepoRoot(tempDirs, "openclaw-plugin-pretag-pack-");
  writeJsonFile(join(repoDir, "package.json"), { name: "openclaw-test-root", type: "module" });
  writePublishablePluginFixture(repoDir, {
    version: "2026.4.10",
    publishTo: "both",
  });
  return repoDir;
}

describe("scripts/plugin-release-pretag-pack-check.ts", () => {
  it("runs runtime build, npm pack, and ClawHub pack commands as managed process groups", async () => {
    const repoDir = createDualPublishPluginRepo();
    runManagedCommandMock.mockResolvedValue(0);

    await runPluginReleasePretagPackCheck(repoDir);

    expect(runManagedCommandMock).toHaveBeenCalledTimes(4);
    expect(runManagedCommandMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        args: [
          "--import",
          "tsx",
          "scripts/check-plugin-npm-runtime-builds.mts",
          "--package",
          "extensions/demo-plugin",
        ],
        bin: process.execPath,
        cwd: repoDir,
        shell: false,
        requireProcessTreeExit: process.platform !== "win32",
        stdio: "inherit",
        timeoutMs: 600_000,
      }),
    );
    expect(runManagedCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        args: ["scripts/plugin-npm-publish.sh", "--pack-dry-run", "extensions/demo-plugin"],
        bin: "bash",
        cwd: repoDir,
        env: expect.objectContaining({ OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0" }),
        stdio: ["inherit", "ignore", "inherit"],
        timeoutMs: 600_000,
      }),
    );
    expect(runManagedCommandMock).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        args: ["scripts/plugin-clawhub-publish.sh", "--pack", "extensions/demo-plugin"],
        bin: "bash",
        cwd: repoDir,
        env: expect.objectContaining({ OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0" }),
        stdio: ["inherit", "ignore", "inherit"],
        timeoutMs: 600_000,
      }),
    );
    const clawHubOptions = runManagedCommandMock.mock.calls[3]?.[0] as {
      env?: NodeJS.ProcessEnv;
    };
    expect(clawHubOptions.env?.OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR).toContain("clawhub-0");
  });

  it("gives each selected runtime build its own managed deadline", async () => {
    const repoDir = createDualPublishPluginRepo();
    writePublishablePluginFixture(repoDir, {
      extensionId: "second-plugin",
      version: "2026.4.11",
      publishTo: "both",
    });
    runManagedCommandMock.mockResolvedValue(0);

    await runPluginReleasePretagPackCheck(repoDir, { timeoutMs: 321 });

    expect(runManagedCommandMock).toHaveBeenCalledTimes(7);
    expect(runManagedCommandMock.mock.calls[0]?.[0]).toMatchObject({
      args: expect.arrayContaining(["--package", "extensions/demo-plugin"]),
      timeoutMs: 321,
    });
    expect(runManagedCommandMock.mock.calls[4]?.[0]).toMatchObject({
      args: expect.arrayContaining(["--package", "extensions/second-plugin"]),
      timeoutMs: 321,
    });
  });

  it("applies a caller-provided timeout to every managed command", async () => {
    const repoDir = createDualPublishPluginRepo();
    runManagedCommandMock.mockResolvedValue(0);

    await runPluginReleasePretagPackCheck(repoDir, { timeoutMs: 321 });

    expect(runManagedCommandMock).toHaveBeenCalledTimes(4);
    for (const [options] of runManagedCommandMock.mock.calls) {
      expect(options).toMatchObject({ timeoutMs: 321 });
    }
  });

  it("preserves nonzero command failure semantics", async () => {
    const repoDir = createDualPublishPluginRepo();
    runManagedCommandMock.mockResolvedValueOnce(7);

    let thrown: unknown;
    try {
      await runPluginReleasePretagPackCheck(repoDir);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 7 });
    expect((thrown as Error).message).toBe(
      "plugin runtime build for @openclaw/demo-plugin failed with exit code 7: node --import tsx scripts/check-plugin-npm-runtime-builds.mts --package extensions/demo-plugin",
    );
  });

  it("identifies the stalled release stage without exposing child details", async () => {
    const repoDir = createDualPublishPluginRepo();
    runManagedCommandMock.mockResolvedValueOnce(0).mockRejectedValueOnce(
      Object.assign(new Error("managed command ETIMEDOUT secret-marker"), {
        code: "ETIMEDOUT",
      }),
    );

    let thrown: unknown;
    try {
      await runPluginReleasePretagPackCheck(repoDir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "ETIMEDOUT" });
    expect((thrown as Error).message).toBe(
      "npm pack for @openclaw/demo-plugin timed out after 600000ms: bash scripts/plugin-npm-publish.sh --pack-dry-run extensions/demo-plugin",
    );
    expect((thrown as Error).message).not.toContain("secret-marker");
  });

  it("preserves managed cancellation statuses at the CLI boundary", () => {
    expect(
      pluginReleasePretagExitCode(Object.assign(new Error("interrupted"), { code: 130 })),
    ).toBe(130);
    expect(pluginReleasePretagExitCode(Object.assign(new Error("terminated"), { code: 143 }))).toBe(
      143,
    );
    expect(
      pluginReleasePretagExitCode(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
    ).toBe(1);
  });

  it.each(["live", "indeterminate", "terminated"] as const)(
    "retains temporary inputs only when managed cleanup reports %s work",
    async (processTreeState) => {
      const repoDir = createDualPublishPluginRepo();
      runManagedCommandMock
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(
          Object.assign(new Error("managed cleanup failed"), {
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState,
          }),
        );
      await expect(runPluginReleasePretagPackCheck(repoDir)).rejects.toMatchObject({
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        processTreeState,
      });
      const options = runManagedCommandMock.mock.calls[2]?.[0] as { args: string[] };
      const tempRoot = dirname(options.args[2]!);
      tempDirs.push(tempRoot);
      expect(existsSync(tempRoot)).toBe(processTreeState !== "terminated");
    },
  );
  it("materializes once from the executing tooling root and passes only the exact absolute CLI", async () => {
    const repoDir = createDualPublishPluginRepo();
    vi.stubEnv("OPENCLAW_CLAWHUB_CLI", "/untrusted/cli");
    runManagedCommandMock.mockResolvedValue(0);
    await runPluginReleasePretagPackCheck(repoDir);
    const install = runManagedCommandMock.mock.calls[2]?.[0];
    const pack = runManagedCommandMock.mock.calls[3]?.[0];
    expect(install).toMatchObject({
      bin: "bash",
      args: [
        resolve("scripts/materialize-clawhub-cli.sh"),
        resolve(".github/release/clawhub-cli"),
        expect.any(String),
      ],
      cwd: resolve("."),
      env: expect.objectContaining({ npm_config_min_release_age: "7" }),
      shell: false,
      requireProcessTreeExit: process.platform !== "win32",
    });
    expect(pack.env.OPENCLAW_CLAWHUB_CLI).toBe(join(install.args[2], "node_modules/.bin/clawhub"));
    expect(pack.env.OPENCLAW_CLAWHUB_CLI).not.toContain(repoDir);
    expect(
      runManagedCommandMock.mock.calls.filter(([call]) =>
        call.args[0].endsWith("materialize-clawhub-cli.sh"),
      ),
    ).toHaveLength(1);
  });

  it("fails closed on materializer failure without invoking ClawHub or retrying npm-exec", async () => {
    const repoDir = createDualPublishPluginRepo();
    runManagedCommandMock
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(9);
    await expect(runPluginReleasePretagPackCheck(repoDir)).rejects.toMatchObject({ code: 9 });
    expect(runManagedCommandMock).toHaveBeenCalledTimes(3);
    expect(runManagedCommandMock.mock.calls[2]?.[0].args[0]).toBe(
      resolve("scripts/materialize-clawhub-cli.sh"),
    );
  });

  it("rejects a custom package override before running any command", async () => {
    vi.stubEnv("CLAWHUB_CLI_PACKAGE", "clawhub@latest");
    await expect(runPluginReleasePretagPackCheck(createDualPublishPluginRepo())).rejects.toThrow(
      "overrides are not supported",
    );
    expect(runManagedCommandMock).not.toHaveBeenCalled();
  });
});
