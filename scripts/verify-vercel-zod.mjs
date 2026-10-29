import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Exercise the installed public schemas, not replicas of their definitions.
// Optional baseline root enables differential validation against unmodified Zod 3.
const root = resolve(process.argv[2]);
const require = createRequire(resolve(root, "package.json"));
const cjs = require("@vercel/python-analysis");
const baseline = process.argv[3]
  ? createRequire(resolve(process.argv[3], "package.json"))("@vercel/python-analysis")
  : undefined;
/** @type {Array<[string, unknown]>} */
const cases = [
  [
    "PipfileLikeSchema",
    {
      packages: { flask: "*", local: { path: ".", editable: true } },
      "dev-packages": { pytest: "*" },
      source: [{ name: "pypi", url: "https://pypi.org/simple", verify_ssl: true }],
      scripts: { test: "pytest" },
    },
  ],
  [
    "PipfileLockLikeSchema",
    {
      _meta: { hash: { sha256: "abc" }, requires: { python_version: "3.12" } },
      default: { flask: { version: "==3.1.0", hashes: ["sha256:abc"] } },
      develop: {},
    },
  ],
  [
    "PyProjectProjectSchema",
    {
      name: "app",
      urls: { Homepage: "https://example.test" },
      "optional-dependencies": { test: ["pytest"] },
      scripts: { app: "app:main" },
      entry_points: { plugins: { x: "app:plugin" } },
      extra: "preserved",
    },
  ],
  [
    "PyProjectDependencyGroupsSchema",
    { dev: ["pytest", { "include-group": "lint" }], lint: ["ruff"] },
  ],
  [
    "UvConfigSchema",
    {
      sources: { local: { path: "../local", editable: true }, remote: [{ index: "private" }] },
      index: [{ name: "private", url: "https://example.test/simple" }],
      workspace: { members: ["packages/*"] },
    },
  ],
  [
    "PyProjectTomlSchema",
    {
      project: { name: "app", dependencies: ["flask"] },
      "build-system": { requires: ["hatchling"], "build-backend": "hatchling.build" },
      "dependency-groups": { test: ["pytest"] },
      tool: {
        uv: { sources: { local: { path: "." } } },
        vercel: { fastapi: { static: { cdn: true } } },
        other: { retained: true },
      },
      unknown: "preserved",
    },
  ],
  [
    "NormalizedRequirementSchema",
    {
      name: "flask",
      version: ">=3",
      extras: ["async"],
      source: { git: "https://example.test/repo", rev: "main" },
      hashes: ["sha256:abc"],
    },
  ],
  ["PipfileLikeSchema", {}],
  ["PipfileLockLikeSchema", {}],
  ["PyProjectTomlSchema", {}],
  ["PyProjectDependencyGroupsSchema", {}],
  ["UvConfigSchema", {}],
];
/** @type {Array<[string, unknown]>} */
const invalid = [
  ["PipfileLikeSchema", { packages: { flask: 42 } }],
  ["PipfileLikeSchema", { scripts: { test: 42 } }],
  ["PipfileLockLikeSchema", { default: { flask: { hashes: [42] } } }],
  ["PyProjectProjectSchema", { urls: { Homepage: 42 } }],
  ["PyProjectProjectSchema", { "optional-dependencies": { test: [42] } }],
  ["PyProjectProjectSchema", { scripts: { app: 42 } }],
  ["PyProjectProjectSchema", { entry_points: { plugins: { x: 42 } } }],
  ["PyProjectDependencyGroupsSchema", { dev: [{ "include-group": 42 }] }],
  ["UvConfigSchema", { sources: { local: { editable: "yes" } } }],
  ["PyProjectTomlSchema", { "build-system": { requires: 42 } }],
  ["NormalizedRequirementSchema", { name: 42 }],
];
for (const [name, value] of cases) {
  const result = cjs[name].parse(value);
  assert.deepEqual(result, value, name + " preserves valid manifest data");
  if (baseline) {
    assert.deepEqual(result, baseline[name].parse(value), name + " baseline parity");
  }
}
for (const [name, value] of invalid) {
  assert.equal(cjs[name].safeParse(value).success, false, name + " rejects invalid manifest data");
  if (baseline) {
    assert.equal(baseline[name].safeParse(value).success, false, name + " baseline rejection");
  }
}
for (const name of ["backends", "express", "hono", "python-analysis"]) {
  const fromParent = createRequire(resolve(root, "node_modules/@vercel", name, "package.json"));
  assert.equal(fromParent("zod/package.json").version, "4.6.7", name + " uses patched Zod");
}
console.log(
  "Vercel Zod compatibility: 23 CommonJS manifest cases passed" +
    (baseline ? " with Zod 3 differential parity." : "."),
);
