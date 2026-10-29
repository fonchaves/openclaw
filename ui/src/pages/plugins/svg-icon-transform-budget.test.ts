import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Evaluate the production validator unchanged in a disposable child. A timeout
// can terminate a pathological regexp even while its JS event loop is blocked.
const source = readFileSync(
  path.resolve(
    process.cwd(),
    process.cwd().endsWith("/ui")
      ? "src/pages/plugins/svg-icon-rasterizer.ts"
      : "ui/src/pages/plugins/svg-icon-rasterizer.ts",
  ),
  "utf8",
);
const transformCase = source.match(/case "transform":([\s\S]*?)case "cx":/)?.[1];
if (transformCase === undefined) {
  throw new Error("Could not locate the production SVG transform validator");
}
const expression = transformCase.slice(
  transformCase.indexOf("return ") + 7,
  transformCase.indexOf(".test("),
);
function validate(value: string) {
  const script =
    "const re = " +
    expression +
    "; console.log(JSON.stringify(re.test(" +
    JSON.stringify(value.trim()) +
    ")))";
  return spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 1000 });
}

describe("plugin SVG production transform validator", () => {
  it("rejects the unclosed transform without blocking", () => {
    const result = validate("scale(" + (String.fromCharCode(9, 9) + ")scale(").repeat(24));
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("false");
  });
  it.each([
    "translate(1 2) scale(1.5)",
    "scale(1) ".repeat(40),
    "  translate(1 2)  ",
    "matrix(1 0 0 1 4 4)",
    "rotate(-30 1 2)",
    "skewX(1e-3) skewY(+2)",
  ])("accepts valid transforms: %s", (value) => {
    const result = validate(value);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("true");
  });
  it.each(["translate()", "javascript:alert(1)", "scale(1)garbage", "rotate(Infinity)"])(
    "rejects unsafe or malformed transforms: %s",
    (value) => {
      expect(validate(value).stdout.trim()).toBe("false");
    },
  );
});
