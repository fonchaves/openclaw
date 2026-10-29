import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];
afterEach(() => cleanupTempDirs(tempDirs));
const source = readFileSync("scripts/materialize-clawhub-cli.sh", "utf8");
const lockBytes = readFileSync(".github/release/clawhub-cli/package-lock.json");
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const lock = JSON.parse(lockBytes.toString());
const cliIntegrity =
  "sha512-VwM6FQrZVarFRDiEqG42npUeyCu/iLhPnpO+b7kKIGRXv+TA6Lb8pboHnIgT6cmjFEnW3j/pTbshWeDQMQ7QWQ==";

function fixture(options: { version?: string; executable?: boolean; npmExit?: number } = {}) {
  const root = makeTempDir(tempDirs, "clawhub-materializer-contract-");
  const trusted = join(root, "trusted");
  const bin = join(root, "bin");
  mkdirSync(trusted);
  mkdirSync(bin);
  copyFileSync(".github/release/clawhub-cli/package.json", join(trusted, "package.json"));
  writeFileSync(join(trusted, "package-lock.json"), lockBytes);
  const script = join(root, "materialize.sh");
  writeFileSync(script, source);
  mkdirSync(join(root, "lib"));
  copyFileSync(
    "scripts/lib/materialize-pinned-cli.sh",
    join(root, "lib/materialize-pinned-cli.sh"),
  );
  const npm = join(bin, "npm");
  writeFileSync(
    npm,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$@" > "$PROOF_ROOT/npm-args"',
      'test "$npm_config_min_release_age" = 7',
      'test "$PWD" = "$PROOF_ROOT/install"',
      "test -f package-lock.json",
      "exit_code=" + (options.npmExit ?? 0),
      'if [[ "$exit_code" != 0 ]]; then exit "$exit_code"; fi',
      "mkdir -p node_modules/clawhub node_modules/.bin",
      "printf '%s' " +
        JSON.stringify(JSON.stringify({ version: options.version ?? "0.23.3" })) +
        " > node_modules/clawhub/package.json",
      ...(options.executable === false
        ? []
        : [
            "printf '#!/bin/sh\\nexit 0\\n' > node_modules/.bin/clawhub",
            "chmod +x node_modules/.bin/clawhub",
          ]),
      "",
    ].join("\n"),
  );
  chmodSync(npm, 0o755);
  const output = join(root, "outputs");
  const destination = join(root, "install");
  const run = () =>
    spawnSync("bash", [script, trusted, destination, output], {
      encoding: "utf8",
      env: {
        PATH: bin + delimiter + process.env.PATH,
        HOME: root,
        PROOF_ROOT: root,
        npm_config_min_release_age: "7",
      },
    });
  return { root, trusted, script, output, destination, run };
}

describe("ordinary ClawHub release toolchain contract", () => {
  it("uses the exact patched CLI identity, complete lock hash, and lifecycle-disabled install", () => {
    expect(lock.packages["node_modules/clawhub"]).toMatchObject({
      version: "0.23.3",
      integrity: cliIntegrity,
    });
    expect(lock.packages["node_modules/undici"].version).toBe("7.30.1");
    expect(source).toContain('expected_lock_sha256="' + hash(lockBytes) + '"');
    const f = fixture();
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.root, "npm-args"), "utf8").trim().split("\n")).toEqual([
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
    ]);
    expect(readFileSync(f.output, "utf8").trim().split("\n")).toEqual([
      "cli=" + join(f.destination, "node_modules/.bin/clawhub"),
      "integrity=" + cliIntegrity,
      "lock_sha256=" + hash(lockBytes),
      "version=0.23.3",
    ]);
  });

  it("takes tool bytes from workflow_sha while retaining target-package authority and prepared-artifact routing", () => {
    const text = readFileSync(".github/workflows/plugin-clawhub-release.yml", "utf8");
    const workflow = parse(text);
    const steps = workflow.jobs.pack_plugins_clawhub_artifacts.steps;
    const trusted = steps.findIndex(
      (s: { name: string }) => s.name === "Checkout trusted artifact tooling",
    );
    const materialize = steps.findIndex(
      (s: { name: string }) => s.name === "Materialize pinned ClawHub CLI",
    );
    const pack = steps.findIndex(
      (s: { name: string }) => s.name === "Pack ClawHub package artifact",
    );
    expect(trusted).toBeLessThan(materialize);
    expect(materialize).toBeLessThan(pack);
    expect(steps[trusted].with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      path: ".release-tooling",
      "persist-credentials": false,
    });
    expect(steps[materialize]).toMatchObject({
      id: "clawhub_cli",
      if: "inputs.prepared_artifact == ''",
      env: { npm_config_min_release_age: "7" },
    });
    expect(steps[materialize].run).toContain(
      "bash .release-tooling/scripts/materialize-clawhub-cli.sh",
    );
    expect(steps[materialize].run).toContain(".release-tooling/.github/release/clawhub-cli");
    expect(steps[materialize].run).toContain('"${RUNNER_TEMP}/clawhub-cli"');
    expect(steps[pack].env.OPENCLAW_CLAWHUB_CLI).toBe("${{ steps.clawhub_cli.outputs.cli }}");
    expect(steps[pack].env.SOURCE_COMMIT).toBe(
      "${{ needs.preview_plugins_clawhub.outputs.ref_revision }}",
    );
    expect(steps[pack].if).toBe("inputs.prepared_artifact == ''");
    expect(text).not.toContain("npm exec");
    expect(text).not.toContain("CLAWHUB_CLI_PACKAGE");
    expect(
      steps.find((s: { name: string }) => s.name === "Restore exact prepared ClawHub tarball").if,
    ).toBe("inputs.prepared_artifact != ''");
  });

  it("rejects a changed lock before invoking npm and emits no CLI capability", () => {
    const f = fixture();
    writeFileSync(join(f.trusted, "package-lock.json"), lockBytes.toString() + " ");
    expect(f.run().status).not.toBe(0);
    expect(existsSync(join(f.root, "npm-args"))).toBe(false);
    expect(existsSync(f.output)).toBe(false);
  });

  it("independently rejects mismatched CLI integrity before invoking npm", () => {
    const f = fixture();
    const altered = JSON.parse(lockBytes.toString());
    altered.packages["node_modules/clawhub"].integrity = "sha512-wrong";
    const bytes = JSON.stringify(altered);
    writeFileSync(join(f.trusted, "package-lock.json"), bytes);
    writeFileSync(f.script, source.replace(hash(lockBytes), hash(bytes)));
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("integrity mismatch");
    expect(existsSync(join(f.root, "npm-args"))).toBe(false);
    expect(existsSync(f.output)).toBe(false);
  });

  it.each(["directory", "symlink"])(
    "rejects a pre-existing %s destination without invoking npm",
    (kind) => {
      const f = fixture();
      if (kind === "directory") {
        mkdirSync(f.destination);
      } else {
        symlinkSync(f.trusted, f.destination);
      }
      expect(f.run().status).not.toBe(0);
      expect(existsSync(join(f.root, "npm-args"))).toBe(false);
    },
  );

  it.each([{ version: "0.23.2" }, { executable: false }, { npmExit: 42 }])(
    "never emits a CLI capability after an invalid install %j",
    (options) => {
      const f = fixture(options);
      expect(f.run().status).not.toBe(0);
      expect(existsSync(f.output)).toBe(false);
    },
  );
});
