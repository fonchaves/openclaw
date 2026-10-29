import "./verify-vercel-zod.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { runInNewContext } from "node:vm";

// Exercise schema declarations from the installed ESM artifacts. Importing
// python-analysis's whole ESM bundle is independently broken upstream by an
// extensionless pep440 subpath. Do not change that unrelated package behavior.
const root = resolve(process.argv[2]);
const require = createRequire(resolve(root, "package.json"));
const { z } = require("zod");
function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, "Expected pinned schema section");
  return source.slice(from, to);
}
const python = readFileSync(
  resolve(root, "node_modules/@vercel/python-analysis/dist/index.js"),
  "utf8",
);
const pip = between(python, "var pipfileDependencyDetailSchema", "// src/util/type.ts");
const project = between(
  python,
  "var dependencySourceSchema",
  "// src/manifest/requirements-txt-parser.ts",
);
const schemas = runInNewContext(
  pip +
    project +
    "; ({ PipfileLikeSchema, PipfileLockLikeSchema, PyProjectProjectSchema, PyProjectDependencyGroupsSchema, UvConfigSchema: uvConfigSchema })",
  { z, z2: z, z3: z, z4: z },
);
for (const [name, valid, invalid] of [
  [
    "PipfileLikeSchema",
    { packages: { flask: "*" }, scripts: { test: "pytest" } },
    { packages: { flask: 1 } },
  ],
  [
    "PipfileLockLikeSchema",
    { default: { flask: { version: "==3" } } },
    { default: { flask: { version: 3 } } },
  ],
  [
    "PyProjectProjectSchema",
    { entry_points: { plugins: { app: "app:main" } } },
    { entry_points: { plugins: { app: 1 } } },
  ],
  ["PyProjectDependencyGroupsSchema", { test: ["pytest"] }, { test: [1] }],
  ["UvConfigSchema", { sources: { app: { path: "." } } }, { sources: { app: { path: 1 } } }],
]) {
  assert.deepEqual(schemas[name].parse(valid), valid);
  assert.equal(schemas[name].safeParse(invalid).success, false);
}
const backend = readFileSync(resolve(root, "node_modules/@vercel/backends/dist/index.mjs"), "utf8");
const schemaSources = [
  between(backend, "const introspectionSchema =", "const introspection =") +
    "return introspectionSchema;",
  between(backend, "const introspectionSchema$1 =", "let introspectionData;") +
    "return introspectionSchema$1;",
];
for (const source of schemaSources) {
  const schema = runInNewContext("(() => {" + source + "})()", {
    z,
    isAbsolute,
    relative,
    args: { dir: root },
  });
  const route = { src: "/health", dest: "/api", methods: ["GET"] };
  assert.deepEqual(schema.parse({ routes: [route] }), { routes: [route] });
  assert.deepEqual(
    schema.parse({ routes: [], additionalFolders: ["assets"], additionalDeps: ["dep"] }),
    { routes: [], additionalFolders: ["assets"], additionalDeps: ["dep"] },
  );
  assert.equal(schema.safeParse({ routes: [{ ...route, methods: [1] }] }).success, false);
}
// An oversized constrained collection must fail before visiting its elements.
// This detects the vulnerable allocation path without exhausting test memory.
let visited = 0;
const oversized = Array(100);
Object.defineProperty(oversized, 0, {
  get() {
    visited++;
    return "x";
  },
});
assert.equal(z.array(z.string()).max(1).safeParse(oversized).success, false);
assert.equal(visited, 0);
if (process.argv[3]) {
  const baselineRequire = createRequire(
    resolve(process.argv[3], "node_modules/@vercel/python-analysis/package.json"),
  );
  const baselineZod = baselineRequire("zod");
  let baselineVisited = 0;
  const baselineOversized = Array(100);
  Object.defineProperty(baselineOversized, 0, {
    get() {
      baselineVisited++;
      return "x";
    },
  });
  assert.equal(
    baselineZod.array(baselineZod.string()).max(1).safeParse(baselineOversized).success,
    false,
  );
  assert.ok(baselineVisited > 0, "Vulnerable baseline visits oversized array elements");
}

console.log(
  "ESM record schemas, backend introspection schemas, and constrained-array early rejection passed.",
);
