// Bundled hosted OpenAI-compatible providers list models from the account, so a new
// vendor model appears without an OpenClaw release (docs/plugins/sdk-provider-plugins/model-catalogs.md).
import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLiveCatalogCacheForTests } from "../../plugin-sdk/provider-catalog-live-runtime.js";
import type { LiveModelCatalogFetchGuard } from "../../plugin-sdk/provider-catalog-live-runtime.js";
import { registerProviderPlugins } from "../../test-utils/plugin-registration.js";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";
import { runProviderCatalog } from "../provider-discovery.js";

const fetchWithSsrFGuard = vi.hoisted(() => vi.fn<LiveModelCatalogFetchGuard>());

vi.mock("../../plugin-sdk/ssrf-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/ssrf-runtime.js")>()),
  fetchWithSsrFGuard,
}));

const repoRoot = path.resolve(import.meta.dirname, "../../..");

// Each entry names why the provider cannot list models live yet. Remove the entry
// when the provider gains live listing.
const STATIC_LISTING_REASONS: Record<string, string> = {
  abliteration:
    "Static manifest by design (#182248): each row carries its own reasoning-effort ladder; live listing needs the vendor /models shape checked with a real key.",
};

type HostedProvider = { pluginDir: string; providerId: string; baseUrl: string };

function collectHostedOpenAICompatibleProviders(): HostedProvider[] {
  const files = listGitTrackedFiles({ repoRoot, pathspecs: "extensions" });
  if (!files) {
    throw new Error("unable to list bundled plugin files from git");
  }
  const hosted: HostedProvider[] = [];
  for (const file of files.filter((f) => /^extensions\/[^/]+\/openclaw\.plugin\.json$/.test(f))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")) as Record<
      string,
      unknown
    >;
    const pluginDir = path.dirname(file);
    const providers = readRecord(readRecord(manifest.modelCatalog)?.providers) ?? {};
    for (const [providerId, raw] of Object.entries(providers)) {
      const provider = readRecord(raw);
      const baseUrl = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
      if (provider?.api === "openai-completions" && baseUrl.startsWith("https://")) {
        hosted.push({ pluginDir, providerId, baseUrl });
      }
    }
  }
  return hosted.toSorted((a, b) => a.providerId.localeCompare(b.providerId));
}

async function requestsModelList({ pluginDir, providerId, baseUrl }: HostedProvider) {
  const { default: plugin } = (await import(path.join(repoRoot, pluginDir, "index.ts"))) as {
    default: Parameters<typeof registerProviderPlugins>[0];
  };
  // Family plugins serve sibling providers (for example coding plans) through hook
  // aliases or one family catalog that honors `providerIds`.
  const registered = await registerProviderPlugins(plugin);
  const provider =
    registered.find(
      (entry) =>
        entry.id === providerId ||
        entry.aliases?.includes(providerId) ||
        entry.hookAliases?.includes(providerId),
    ) ?? (registered.length === 1 ? registered[0] : undefined);
  if (!provider) {
    throw new Error(`${pluginDir} registers no provider ${providerId}`);
  }
  // Any vendor request during the catalog run is a live listing; endpoints differ
  // (`/models`, `/models/managed`, vendor-specific paths).
  let requests = 0;
  fetchWithSsrFGuard.mockImplementation(async ({ url }) => {
    requests += 1;
    return {
      response: Response.json({ data: [{ id: "contract-probe-chat-1", object: "model" }] }),
      finalUrl: url,
      release: async () => {},
    };
  });
  // Live discovery runs only with a resolved secret, not a config marker.
  const credential = { apiKey: "contract-probe-key", discoveryApiKey: "contract-probe-key" };
  await runProviderCatalog({
    provider,
    providerIds: [providerId],
    // Region-scoped plans list only after setup records the endpoint.
    config: { models: { providers: { [providerId]: { baseUrl, models: [] } } } },
    env: {} as NodeJS.ProcessEnv,
    resolveProviderApiKey: () => credential,
    resolveProviderAuth: () => ({ ...credential, mode: "api_key", source: "env" }),
  });
  return requests > 0;
}

describe("bundled hosted OpenAI-compatible providers list models live", () => {
  beforeEach(clearLiveCatalogCacheForTests);
  afterEach(() => {
    clearLiveCatalogCacheForTests();
    fetchWithSsrFGuard.mockReset();
  });

  for (const hosted of collectHostedOpenAICompatibleProviders()) {
    const { providerId } = hosted;
    const reason = STATIC_LISTING_REASONS[providerId];
    it(`${providerId} ${reason ? "keeps a recorded static-listing reason" : "requests the account's model list"}`, async () => {
      const lists = await requestsModelList(hosted);
      expect(lists, reason ? `${providerId} lists live now: remove its reason` : undefined).toBe(
        !reason,
      );
    });
  }
});
