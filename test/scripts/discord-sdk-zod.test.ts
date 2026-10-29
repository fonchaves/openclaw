import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildDiscordActivitySdk } from "../../scripts/build-discord-activity-sdk.mts";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

type Schema = {
  parse: (input: unknown) => unknown;
  safeParse: (input: unknown) => { success: boolean; error?: { issues: unknown[] } };
};
type Sdk = {
  Common: {
    Scopes: Schema;
    GuildMember: { shape: { roles: { max: (limit: number) => Schema } } };
  };
};
type Schemas = { AuthenticateResponseSchema: Schema; ShareInteractionRequestSchema: Schema };
const require = createRequire(new URL("../../extensions/discord/package.json", import.meta.url));
const sdkDir = path.dirname(require.resolve("@discord/embedded-app-sdk/package.json"));
const tempDirs: string[] = [];
afterEach(() => cleanupTempDirs(tempDirs));

describe("Discord SDK security-patched Zod", () => {
  it.each(["mjs", "cjs"])(
    "preserves authentication and rejects oversized buttons before parsing (%s)",
    async (extension) => {
      const sdk: Sdk = await import(
        pathToFileURL(path.join(sdkDir, "output", "index." + extension)).href
      );
      const schemas: Schemas = await import(
        pathToFileURL(path.join(sdkDir, "output/generated/schemas." + extension)).href
      );
      expect(sdk.Common.Scopes.parse("identify")).toBe("identify");
      expect(sdk.Common.Scopes.parse("future.scope")).toBe(-1);
      const response = {
        access_token: "fixture-token",
        user: { id: "1", username: "fixture", discriminator: "0", public_flags: 0 },
        scopes: ["identify", "future.scope", null],
        expires: "2030-01-01T00:00:00Z",
        application: { id: "2", name: "fixture", description: "fixture" },
      };
      expect(schemas.AuthenticateResponseSchema.parse(response)).toEqual({
        ...response,
        scopes: ["identify", -1, -1],
      });
      expect(
        schemas.AuthenticateResponseSchema.safeParse({ ...response, user: { id: 1 } }).success,
      ).toBe(false);
      const validButton = { type: 2, style: 1, label: "Open" };
      const validRequest = {
        command: "fixture",
        components: [{ type: 1, components: [validButton] }],
      };
      expect(schemas.ShareInteractionRequestSchema.parse(validRequest)).toEqual(validRequest);
      let elementReads = 0;
      const buttons = Array.from({ length: 6 }, () => ({
        get type() {
          elementReads += 1;
          return 2;
        },
        style: 1,
      }));
      const result = schemas.ShareInteractionRequestSchema.safeParse({
        command: "fixture",
        components: [{ type: 1, components: buttons }],
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toHaveLength(1);
      expect(elementReads).toBe(0);
    },
  );

  it("ships the repaired parser and scope handling through the production browser build", async () => {
    const dir = makeTempDir(tempDirs, "discord-sdk-zod-");
    const outputPath = path.join(dir, "embedded-app-sdk.mjs");
    await buildDiscordActivitySdk({ outputPath });
    const sdk: Sdk = await import(pathToFileURL(outputPath).href);
    expect(sdk.Common.Scopes.parse("identify")).toBe("identify");
    expect(sdk.Common.Scopes.parse("future.scope")).toBe(-1);
    let elementReads = 0;
    const roles = Array(6).fill("role");
    Object.defineProperty(roles, "0", {
      get() {
        elementReads += 1;
        return "role";
      },
    });
    expect(sdk.Common.GuildMember.shape.roles.max(5).safeParse(roles).success).toBe(false);
    expect(elementReads).toBe(0);
  });
});
