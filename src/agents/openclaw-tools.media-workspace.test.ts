import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveStateDir } from "../config/paths.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { applyNodesToolWorkspaceGuard } from "./openclaw-tools.nodes-workspace-guard.js";
import { subagentAttachmentRootForRun } from "./subagents/subagent-attachment-paths.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { callInProcessGatewayTool } from "./tools/in-process-gateway.js";
import { loadMediaToolReferences } from "./tools/media-tool-shared.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

vi.mock("./tools/in-process-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools/in-process-gateway.js")>()),
  callInProcessGatewayTool: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/BsAAAAASUVORK5CYII=",
  "base64",
);

function guardedNodes(workspaceDir: string, sandbox = false) {
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  const tool = applyNodesToolWorkspaceGuard(
    { name: "nodes", label: "Nodes", description: "Nodes", parameters: Type.Object({}), execute },
    {
      workspaceDir,
      fsPolicy: { workspaceOnly: true },
      ...(sandbox ? { sandboxRoot: workspaceDir, sandboxContainerWorkdir: "/workspace" } : {}),
    },
  );
  return { tool, execute };
}

describe("nodes output paths", () => {
  it.each([
    { outPath: "capture.mp4", sandbox: false },
    { outPath: "/workspace/capture.mp4", sandbox: true },
  ])("normalizes $outPath before executing the node tool", async ({ outPath, sandbox }) => {
    const workspace = tempDirs.make("openclaw-nodes-workspace-");
    const { tool, execute } = guardedNodes(workspace, sandbox);
    await tool.execute("capture", { action: "screen_record", outPath });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "capture",
      { action: "screen_record", outPath: path.join(workspace, "capture.mp4") },
      undefined,
      undefined,
    );
  });

  it("rejects an output outside the workspace before node execution", async () => {
    const { tool, execute } = guardedNodes(tempDirs.make("openclaw-nodes-workspace-"));
    await expect(tool.execute("capture", { outPath: "/etc/passwd" })).rejects.toThrow(
      /Path escapes sandbox root/,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

function createMediaTool(name: string, options: Parameters<typeof createOpenClawTools>[0]) {
  const tool = createOpenClawTools({
    config: { plugins: { enabled: false } },
    agentDir: tempDirs.make("openclaw-media-agent-"),
    modelHasVision: true,
    ...options,
  }).find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected registered ${name} tool`);
  }
  return tool;
}

async function expectLoadedImage(tool: ReturnType<typeof createMediaTool>, imagePath: string) {
  const result = await tool.execute("inspect-screenshot", { path: imagePath });
  expect(result.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "image", mimeType: "image/png", data: expect.any(String) }),
    ]),
  );
}

describe("media references in task workspaces", () => {
  it.each([false, true])(
    "loads session-worktree images with workspaceOnly=%s",
    async (workspaceOnly) => {
      const workspaceDir = tempDirs.make("openclaw-media-canonical-");
      const sessionRoot = tempDirs.make("openclaw-media-worktree-");
      const cwd = path.join(sessionRoot, "task");
      await fs.mkdir(cwd);
      const imagePath = path.join(cwd, "screenshot.png");
      await fs.writeFile(imagePath, png);
      await fs.writeFile(path.join(sessionRoot, "shared.png"), png);
      const tool = createMediaTool("view_image", {
        workspaceDir,
        cwd,
        fsPolicy: { workspaceOnly, root: sessionRoot },
      });

      await expectLoadedImage(tool, imagePath);
      await expectLoadedImage(tool, "screenshot.png");
      await expectLoadedImage(tool, "../shared.png");

      if (workspaceOnly) {
        const outsideImage = path.join(workspaceDir, "outside.png");
        await fs.writeFile(outsideImage, png);
        await expect(tool.execute("outside-image", { path: outsideImage })).rejects.toThrow(
          /not under an allowed directory/i,
        );
      }
    },
  );

  it("keeps sandbox media on its bridge despite a different host session root", async () => {
    const workspaceDir = tempDirs.make("openclaw-media-canonical-");
    const hostRoot = tempDirs.make("openclaw-media-host-");
    const sandboxRoot = tempDirs.make("openclaw-media-sandbox-");
    await fs.writeFile(path.join(sandboxRoot, "screenshot.png"), png);
    const hostImage = path.join(hostRoot, "host.png");
    await fs.writeFile(hostImage, png);
    const tool = createMediaTool("view_image", {
      workspaceDir,
      cwd: hostRoot,
      fsPolicy: { workspaceOnly: true, root: hostRoot },
      sandboxRoot,
      sandboxFsBridge: createHostSandboxFsBridge(sandboxRoot),
    });

    await expectLoadedImage(tool, "screenshot.png");
    await expect(tool.execute("host-image", { path: hostImage })).rejects.toThrow(
      /escapes sandbox root/i,
    );
  });

  it("discards an image when the run is cancelled during a sandbox read", async () => {
    const sandboxRoot = tempDirs.make("openclaw-media-sandbox-");
    await fs.writeFile(path.join(sandboxRoot, "screenshot.png"), png);
    const bridge = createHostSandboxFsBridge(sandboxRoot);
    const readStarted = createDeferredCore();
    const finishRead = createDeferredCore();
    const controller = new AbortController();
    const tool = createMediaTool("view_image", {
      sandboxRoot,
      sandboxFsBridge: {
        ...bridge,
        readFile: async (params) => {
          readStarted.resolve();
          await finishRead.promise;
          return await bridge.readFile(params);
        },
      },
    });

    const result = tool.execute("cancelled-image", { path: "screenshot.png" }, controller.signal);
    const rejected = expect(result).rejects.toThrow("cancelled image inspection");
    await readStarted.promise;
    controller.abort(new Error("cancelled image inspection"));
    finishRead.resolve();
    await rejected;
  });

  it.each([{ name: "reference.png", bytes: png, mime: "image/png" }])(
    "rejects $mime as a PDF after reading within the session root",
    async ({ name, bytes, mime }) => {
      const workspaceDir = tempDirs.make("openclaw-media-canonical-");
      const sessionRoot = tempDirs.make("openclaw-media-worktree-");
      const cwd = path.join(sessionRoot, "task");
      await fs.mkdir(cwd);
      const imagePath = path.join(sessionRoot, name);
      const outsidePath = path.join(workspaceDir, name);
      await fs.writeFile(imagePath, bytes);
      await fs.writeFile(outsidePath, bytes);
      const tool = createMediaTool("pdf", {
        config: {
          plugins: { allow: [] },
          tools: { allow: ["pdf"] },
          agents: { defaults: { pdfModel: { primary: "fixture/pdf-model" } } },
        },
        workspaceDir,
        cwd,
        fsPolicy: { workspaceOnly: true, root: sessionRoot },
      });

      // Reaching content validation proves file access without invoking a PDF provider.
      for (const pdf of [imagePath, `../${name}`]) {
        await expect(tool.execute("read-reference", { pdf })).rejects.toThrow(
          `Expected PDF but got ${mime}`,
        );
      }
      await expect(tool.execute("outside-reference", { pdf: outsidePath })).rejects.toThrow(
        /not under an allowed directory/i,
      );
    },
  );

  it.each(["image_generate"] as const)(
    "%s shared reference loader follows the task cwd and session boundary",
    async (toolName) => {
      const workspaceDir = tempDirs.make("openclaw-media-canonical-");
      const sessionRoot = tempDirs.make("openclaw-media-worktree-");
      const cwd = path.join(sessionRoot, "task");
      await fs.mkdir(cwd);
      const imagePath = path.join(sessionRoot, "reference.png");
      const outsidePath = path.join(workspaceDir, "reference.png");
      await fs.writeFile(imagePath, png);
      await fs.writeFile(outsidePath, png);
      const loadReferences = (inputs: string[]) =>
        loadMediaToolReferences({
          inputs,
          toolName,
          expectedKind: "image",
          workspaceDir,
          cwd,
          fsPolicy: { workspaceOnly: true, root: sessionRoot },
          sandbox: null,
          maxBytes: 1024 * 1024,
          mapMedia: (media) => media.buffer.byteLength,
        });

      const loaded = await loadReferences([imagePath, "../reference.png"]);
      expect(loaded).toHaveLength(2);
      for (const reference of loaded) {
        expect(reference.source).toBeGreaterThan(0);
      }
      await expect(loadReferences([outsidePath])).rejects.toThrow(
        /not under an allowed directory/i,
      );
    },
  );
});

async function defaultMediaDir(prefix: string) {
  const root = path.join(resolveStateDir(), "media");
  await fs.mkdir(root, { recursive: true });
  return tempDirs.make(prefix, root);
}

describe("derived factory filesystem policy", () => {
  it.each([
    { name: "global", config: { tools: { fs: { workspaceOnly: true } } } },
    {
      name: "agent",
      config: { agents: { entries: { main: { tools: { fs: { workspaceOnly: true } } } } } },
    },
  ])("restricts image reads with $name config and no explicit fsPolicy", async ({ config }) => {
    const workspaceDir = await defaultMediaDir("derived-workspace-");
    const outside = path.join(await defaultMediaDir("derived-outside-"), "image.png");
    await fs.writeFile(path.join(workspaceDir, "image.png"), png);
    await fs.writeFile(outside, png);
    const tool = createMediaTool("view_image", { workspaceDir, config });
    await expectLoadedImage(tool, "image.png");
    await expect(tool.execute("outside", { path: outside })).rejects.toThrow(
      /not under an allowed directory/i,
    );
  });

  it.each([
    { workspaceOnly: true, mode: "workspace" as const, allowed: false },
    { workspaceOnly: true, mode: "full" as const, allowed: true },
    { workspaceOnly: false, mode: "guarded" as const, allowed: false },
    { workspaceOnly: false, mode: "read-only" as const, allowed: false },
  ])(
    "honors session mode $mode with global workspaceOnly=$workspaceOnly",
    async ({ workspaceOnly, mode, allowed }) => {
      const workspaceDir = await defaultMediaDir("derived-workspace-");
      const root = await defaultMediaDir("derived-session-");
      const inside = path.join(root, "image.png");
      const outside = path.join(workspaceDir, "image.png");
      await fs.writeFile(inside, png);
      await fs.writeFile(outside, png);
      const tool = createMediaTool("view_image", {
        workspaceDir,
        config: { tools: { fs: { workspaceOnly } } },
        sessionPermissionPolicy: { root, mode },
      });
      await expectLoadedImage(tool, inside);
      if (allowed) {
        await expectLoadedImage(tool, outside);
      } else {
        await expect(tool.execute("outside", { path: outside })).rejects.toThrow(
          /not under an allowed directory/i,
        );
      }
    },
  );

  it("keeps host-owned attachments readable without widening sibling access", async () => {
    const state = tempDirs.make("derived-state-");
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    try {
      const workspaceDir = await defaultMediaDir("derived-workspace-");
      const agentSessionKey = "agent:main:subagent:derived-proof";
      const root = subagentAttachmentRootForRun("main", agentSessionKey)!;
      await fs.mkdir(root, { recursive: true });
      const attachment = path.join(root, "image.png");
      const sibling = path.join(await defaultMediaDir("sibling-"), "sibling.png");
      await fs.writeFile(attachment, png);
      await fs.writeFile(sibling, png);
      const tool = createMediaTool("view_image", {
        workspaceDir,
        agentSessionKey,
        config: { tools: { fs: { workspaceOnly: true } } },
      });
      await expectLoadedImage(tool, attachment);
      await expect(tool.execute("sibling", { path: sibling })).rejects.toThrow(
        /not under an allowed directory/i,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([true, false])(
    "carries workspaceOnly=%s to the delegation authority sink",
    async (workspaceOnly) => {
      const call = vi.mocked(callInProcessGatewayTool);
      call.mockImplementation(async () => {
        expect(getGatewayToolCallerIdentity()?.fullPermission).toBe(!workspaceOnly);
        return { sessionId: "proof", reply: "Done." };
      });
      const tool = createMediaTool("openclaw", {
        agentSessionKey: "agent:main:proof",
        config: { tools: { fs: { workspaceOnly }, exec: { mode: "full" } } },
      });
      await tool.execute("delegate", { message: "Inspect synthetic config." });
      call.mockReset();
    },
  );
});
