#!/usr/bin/env -S node --import tsx

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";
import { collectClawHubPublishablePluginPackages } from "./lib/plugin-clawhub-release.ts";
import { collectPublishablePluginPackages } from "./lib/plugin-npm-release.ts";

// Tool identity comes from this checked-out script, never the package source or ambient PATH.
const TOOLING_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Match the existing npm release-check and shrinkwrap command 10-minute ceilings: complete
// plugin builds and packs retain their normal budget while lifecycle or registry stalls stop.
const PLUGIN_RELEASE_PRETAG_COMMAND_TIMEOUT_MS = 10 * 60_000;

type PluginReleasePretagPackTarget = {
  packageDir: string;
  packageName: string;
  packClawHub: boolean;
  packNpm: boolean;
};

/** Preserve conventional managed-command exit statuses at the executable boundary. */
export function pluginReleasePretagExitCode(error: unknown): number {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "number" &&
    Number.isInteger(error.code) &&
    error.code >= 0 &&
    error.code <= 255
  ) {
    return error.code;
  }
  return 1;
}

function collectPluginReleasePretagPackTargets(
  rootDir = resolve("."),
): PluginReleasePretagPackTarget[] {
  const targets = new Map<string, PluginReleasePretagPackTarget>();

  for (const plugin of collectPublishablePluginPackages(rootDir)) {
    targets.set(plugin.packageDir, {
      packageDir: plugin.packageDir,
      packageName: plugin.packageName,
      packClawHub: false,
      packNpm: true,
    });
  }
  for (const plugin of collectClawHubPublishablePluginPackages(rootDir)) {
    const existing = targets.get(plugin.packageDir);
    targets.set(plugin.packageDir, {
      packageDir: plugin.packageDir,
      packageName: plugin.packageName,
      packClawHub: true,
      packNpm: existing?.packNpm ?? false,
    });
  }

  return [...targets.values()].toSorted((left, right) =>
    left.packageName.localeCompare(right.packageName),
  );
}

async function runCommand(
  command: string,
  args: string[],
  params: {
    commandLabel: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    quietStdout?: boolean;
    stage: string;
    timeoutMs: number;
  },
): Promise<void> {
  let status: number;
  try {
    status = await runManagedCommand({
      args,
      bin: command,
      cwd: params.cwd,
      env: params.env,
      shell: false,
      requireProcessTreeExit: process.platform !== "win32",
      stdio: params.quietStdout ? ["inherit", "ignore", "inherit"] : "inherit",
      timeoutMs: params.timeoutMs,
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ETIMEDOUT")) {
      throw error;
    }
    throw Object.assign(
      new Error(`${params.stage} timed out after ${params.timeoutMs}ms: ${params.commandLabel}`),
      { code: "ETIMEDOUT" as const },
    );
  }
  if (status !== 0) {
    throw Object.assign(
      new Error(`${params.stage} failed with exit code ${status}: ${params.commandLabel}`),
      { code: status },
    );
  }
}

export async function runPluginReleasePretagPackCheck(
  rootDir = resolve("."),
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (
    process.env.CLAWHUB_CLI_PACKAGE?.trim() &&
    process.env.CLAWHUB_CLI_PACKAGE.trim() !== "clawhub@0.23.3"
  ) {
    throw new Error(
      "CLAWHUB_CLI_PACKAGE overrides are not supported by the pinned release toolchain.",
    );
  }
  const timeoutMs = options.timeoutMs ?? PLUGIN_RELEASE_PRETAG_COMMAND_TIMEOUT_MS;
  const targets = collectPluginReleasePretagPackTargets(rootDir);
  const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-plugin-pretag-pack-"));
  const cliRoot = join(tempRoot, "clawhub-cli");
  let cliMaterialized = false;

  let unjoinedWork = false;
  try {
    const prebuiltPackEnv = {
      ...process.env,
      OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0",
    };
    for (const [index, target] of targets.entries()) {
      console.log(`plugin runtime build: ${target.packageName}`);
      await runCommand(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/check-plugin-npm-runtime-builds.mts",
          "--package",
          target.packageDir,
        ],
        {
          commandLabel: `node --import tsx scripts/check-plugin-npm-runtime-builds.mts --package ${target.packageDir}`,
          cwd: rootDir,
          stage: `plugin runtime build for ${target.packageName}`,
          timeoutMs,
        },
      );
      if (target.packNpm) {
        console.log(`npm pack: ${target.packageName}`);
        await runCommand(
          "bash",
          ["scripts/plugin-npm-publish.sh", "--pack-dry-run", target.packageDir],
          {
            commandLabel: `bash scripts/plugin-npm-publish.sh --pack-dry-run ${target.packageDir}`,
            cwd: rootDir,
            env: prebuiltPackEnv,
            quietStdout: true,
            stage: `npm pack for ${target.packageName}`,
            timeoutMs,
          },
        );
      }
      if (target.packClawHub) {
        if (!cliMaterialized) {
          await runCommand(
            "bash",
            [
              join(TOOLING_ROOT, "scripts/materialize-clawhub-cli.sh"),
              join(TOOLING_ROOT, ".github/release/clawhub-cli"),
              cliRoot,
            ],
            {
              commandLabel:
                "bash scripts/materialize-clawhub-cli.sh <trusted-tool-lock> <temporary-cli>",
              cwd: TOOLING_ROOT,
              env: { ...process.env, npm_config_min_release_age: "7" },
              stage: "ClawHub CLI materialization",
              timeoutMs,
            },
          );
          cliMaterialized = true;
        }
        const outputDir = join(tempRoot, `clawhub-${index}`);
        console.log(`ClawHub pack: ${target.packageName}`);
        await runCommand(
          "bash",
          ["scripts/plugin-clawhub-publish.sh", "--pack", target.packageDir],
          {
            commandLabel: `bash scripts/plugin-clawhub-publish.sh --pack ${target.packageDir}`,
            cwd: rootDir,
            env: {
              ...prebuiltPackEnv,
              OPENCLAW_CLAWHUB_CLI: join(cliRoot, "node_modules/.bin/clawhub"),
              OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR: outputDir,
            },
            quietStdout: true,
            stage: `ClawHub pack for ${target.packageName}`,
            timeoutMs,
          },
        );
      }
    }
  } catch (error) {
    unjoinedWork = hasUnjoinedWork(error);
    throw error;
  } finally {
    if (!unjoinedWork) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  console.log(`plugin-release-pretag-pack-check: packed ${targets.length} publishable plugins.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await runPluginReleasePretagPackCheck();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = pluginReleasePretagExitCode(error);
  }
}
