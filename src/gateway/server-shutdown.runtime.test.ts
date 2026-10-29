import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const loaded: string[] = [];
  const artifacts = { available: true };
  const mocks = {
    prepareClose: vi.fn(),
    drainEmbeddingProviders: vi.fn(),
    completeClose: vi.fn(),
    flushSessionChanges: vi.fn(),
    drainSessionPublications: vi.fn(),
    stopPlugins: vi.fn(),
    preparePluginRegistryShutdown: vi.fn(async () => undefined),
    waitForPluginCacheRetirement: vi.fn(async () => undefined),
  };
  const dependencies = {
    "server-close": {
      prepareGatewayClose: mocks.prepareClose,
      completeGatewayClose: mocks.completeClose,
      drainActiveSessionsForShutdown: vi.fn(),
      runGatewayClosePrelude: vi.fn(),
    },
    "plugin-hooks": { runGlobalGatewayStopSafely: mocks.stopPlugins },
    "session-change-events": { flushPendingSessionsChangedEvents: mocks.flushSessionChanges },
    "session-event-publications": {
      get drainSessionEventPublications() {
        if (!artifacts.available) {
          throw new Error("installed session-event-prepared-row chunk was removed");
        }
        return mocks.drainSessionPublications;
      },
    },
    "mcp-http": { closeMcpLoopbackServer: vi.fn() },
    "bundle-lsp": { disposeAllBundleLspRuntimes: vi.fn() },
    embeddings: { drainRetainedOpenAiEmbeddingProviders: mocks.drainEmbeddingProviders },
    "gmail-watcher": { stopGmailWatcher: vi.fn() },
    "cron-maintenance": { stopCronMaintenance: vi.fn() },
    "code-mode": { disposeAllCodeModeRuns: vi.fn() },
    "provider-transports": { closeProviderTransportDispatcherPool: vi.fn() },
    "plugin-runtime": { prepareActivePluginRegistryShutdown: mocks.preparePluginRegistryShutdown },
    "plugin-cache": {
      get waitForPluginCacheRetirement() {
        if (!artifacts.available) {
          throw new Error("installed plugin-cache chunk was removed");
        }
        return mocks.waitForPluginCacheRetirement;
      },
    },
  };
  return {
    ...mocks,
    artifacts,
    dependencies,
    loaded,
    loadedMock<K extends keyof typeof dependencies>(name: K) {
      loaded.push(name);
      return dependencies[name];
    },
  };
});

// mock-isolation: Trace shutdown dependency loading without initializing its live runtime.
vi.mock("./server-close.runtime.js", () => state.loadedMock("server-close"));
// mock-isolation: Trace shutdown dependency loading without initializing its live runtime.
vi.mock("../plugins/hook-runner-global.js", () => state.loadedMock("plugin-hooks"));
// mock-isolation: Trace shutdown dependency loading without initializing its live runtime.
vi.mock("./server-methods/session-change-event.js", () =>
  state.loadedMock("session-change-events"),
);
// mock-isolation: Trace shutdown dependency loading without initializing its live runtime.
vi.mock("./session-event-prepared-row.js", () => state.loadedMock("session-event-publications"));
// mock-isolation: Trace shutdown dependency loading without initializing its live runtime.
vi.mock("./mcp-http.js", () => state.loadedMock("mcp-http"));
// mock-isolation: Trace shutdown dependency loading without initializing its live runtime.
vi.mock("../agents/agent-bundle-lsp-runtime.js", () => state.loadedMock("bundle-lsp"));
vi.mock("./embeddings-http.js", () => {
  throw new Error("shutdown preparation must not load embeddings HTTP");
});
// mock-isolation: Trace shutdown dependency loading without initializing its live runtime.
vi.mock("./embeddings-provider-lifetime.js", () => state.loadedMock("embeddings"));
// mock-isolation: Trace shutdown dependency loading without initializing its live runtime.
vi.mock("../hooks/gmail-watcher.js", () => state.loadedMock("gmail-watcher"));
// mock-isolation: Trace shutdown dependency loading without initializing its live runtime.
vi.mock("../cron/maintenance.js", () => state.loadedMock("cron-maintenance"));
// mock-isolation: Trace shutdown dependency loading without initializing its live runtime.
vi.mock("../agents/code-mode-state.js", () => state.loadedMock("code-mode"));
// mock-isolation: Trace shutdown dependency loading without initializing its live runtime.
vi.mock("../agents/provider-transport-dispatcher-pool.js", () =>
  state.loadedMock("provider-transports"),
);
// mock-isolation: Trace shutdown dependency loading without initializing its live runtime.
vi.mock("../plugins/runtime.js", () => state.loadedMock("plugin-runtime"));
// mock-isolation: Trace shutdown dependency loading without initializing its live runtime.
vi.mock("../plugins/plugin-cache.js", () => state.loadedMock("plugin-cache"));
vi.mock("../agents/subagents/registry/subagent-session-cleanup.js", () => ({
  loadSubagentSessionCleanupRuntime: async () => undefined,
}));

const { prepareGatewayShutdownRuntime } = await import("./server-shutdown.runtime.js");

it("resolves every shutdown dependency during preparation", async () => {
  const runtime = await prepareGatewayShutdownRuntime();

  expect(state.loaded.toSorted()).toEqual(Object.keys(state.dependencies).toSorted());
  expect(runtime.prepareGatewayClose).toBe(state.prepareClose);
  expect(runtime.drainRetainedOpenAiEmbeddingProviders).toBe(state.drainEmbeddingProviders);
  expect(runtime.completeGatewayClose).toBe(state.completeClose);
  expect(runtime.flushPendingSessionsChangedEvents).toBe(state.flushSessionChanges);
  expect(runtime.runGlobalGatewayStopSafely).toBe(state.stopPlugins);
  expect(state.preparePluginRegistryShutdown).toHaveBeenCalledOnce();
  expect(state.waitForPluginCacheRetirement).not.toHaveBeenCalled();
  expect(state.drainSessionPublications).not.toHaveBeenCalled();
  state.artifacts.available = false;
  try {
    expect(runtime.drainSessionEventPublications).toBe(state.drainSessionPublications);
    await runtime.waitForPluginCacheRetirement();
    expect(state.waitForPluginCacheRetirement).toHaveBeenCalledOnce();
  } finally {
    state.artifacts.available = true;
  }
});
