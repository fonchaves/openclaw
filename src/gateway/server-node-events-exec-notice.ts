import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
  type SessionEventTarget,
} from "../auto-reply/reply/session-event-handoff.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
} from "../infra/event-session-routing.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEventEntry,
} from "../infra/system-events.js";
import {
  captureNodeEventConfig,
  compactNodeEventText,
  isNodeEventConnectionCurrent,
  pairingChangedResult,
  parseNodeEventPayload,
  pruneBoundedTimestampMap,
} from "./server-node-event-source.js";
import type {
  NodeEventContext,
  NodeEventHandlerOptions,
  NodeEventHandleResult,
} from "./server-node-events-types.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";

const MAX_EXEC_EVENT_OUTPUT_CHARS = 180;
const EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT_EXEC_FINISHED_RUNS = 2000;
const recentExecFinishedRuns = new Map<string, number>();

/** Transfer the authorized exec notice and its captured route to one ordinary turn. */
export function enqueueNodeExecNotice(params: {
  sessionKey: string;
  agentId: string;
  authorization: ReturnType<NodeEventContext["authorizeNodeSystemRunEvent"]>;
  runId: string;
  text: string;
  expectedTarget: SessionEventTarget;
  assertAcceptanceCurrent: () => void;
}) {
  const { sessionKey, agentId, runId, text, expectedTarget, assertAcceptanceCurrent } = params;
  // The registry owns this snapshot; the terminal payload never supplies a route.
  // Calls without a host-bound route retain the captured session fallback.
  const deliveryContext =
    (typeof params.authorization === "object"
      ? params.authorization.invocationDeliveryContext
      : undefined) ?? expectedTarget.deliveryContext;
  assertAcceptanceCurrent();
  const eventOptions = withSystemEventOwner(
    { sessionKey, contextKey: runId ? `exec:${runId}` : "exec", deliveryContext },
    agentId,
  );
  const occurrence = enqueueSystemEventEntry(text, eventOptions);
  if (!occurrence) {
    return undefined;
  }
  try {
    return enqueueSessionEventForHost(text, {
      agentId,
      sessionKey,
      source: "node",
      contextKey: eventOptions.contextKey,
      deliveryContext,
      expectedTarget,
      occurrences: [occurrence],
      assertAcceptanceCurrent,
    });
  } catch (error) {
    consumeSelectedSystemEventEntries(eventOptions.sessionKey, [occurrence]);
    throw error;
  }
}

function shouldDropDuplicateExecFinished(params: {
  sessionKey: string;
  runId: string;
  now: number;
}): boolean {
  const fingerprint = `${params.sessionKey}::${params.runId}`;
  const previousTs = recentExecFinishedRuns.get(fingerprint);
  if (
    typeof previousTs === "number" &&
    params.now - previousTs <= EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS
  ) {
    return true;
  }

  recentExecFinishedRuns.set(fingerprint, params.now);
  pruneBoundedTimestampMap(recentExecFinishedRuns, {
    now: params.now,
    ttlMs: EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS,
    maxEntries: MAX_RECENT_EXEC_FINISHED_RUNS,
  });

  return false;
}

/** Consume the registry's captured caller and route, then transfer custody to the receipt. */
export async function handleNodeExecEvent(
  ctx: NodeEventContext,
  nodeId: string,
  event: "exec.started" | "exec.finished" | "exec.denied",
  payloadJSON: string | null | undefined,
  opts?: NodeEventHandlerOptions,
): Promise<NodeEventHandleResult | undefined> {
  const obj = parseNodeEventPayload(payloadJSON);
  if (!obj) {
    return undefined;
  }
  const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? `node-${nodeId}`;
  const config = captureNodeEventConfig();
  const { cfg } = config;
  const { canonicalKey: sessionKey, agentId } = resolveSessionStoreIdentity({
    cfg,
    sessionKey: sessionKeyRaw,
  });
  const runId = normalizeOptionalString(obj.runId) ?? "";
  const policy = resolveEventSessionRoutingPolicy({ cfg, sessionKey });
  const eventSessionKey = resolveEventSessionKeyForPolicy(sessionKey, policy);
  const assertAcceptanceCurrent = () => {
    config.assertCurrent();
    opts?.assertSessionEventCurrent?.();
  };
  assertAcceptanceCurrent();
  const auth = ctx.authorizeNodeSystemRunEvent({
    nodeId,
    connId: opts?.connId,
    ...(runId ? { runId } : {}),
    sessionKey: sessionKeyRaw,
    event,
  });
  if (!auth) {
    return {
      ok: true,
      event,
      handled: false,
      reason: "unmatched_exec_event",
    };
  }
  const authorization = typeof auth === "object" ? auth : undefined;
  const release = authorization?.release;
  if (cfg.tools?.exec?.notifyOnExit === false || obj.suppressNotifyOnExit === true) {
    release?.();
    return undefined;
  }
  if (event === "exec.denied") {
    release?.();
    return undefined;
  }
  const command = normalizeOptionalString(obj.command) ?? "";
  const exitCode =
    typeof obj.exitCode === "number" && Number.isFinite(obj.exitCode) ? obj.exitCode : undefined;
  const timedOut = obj.timedOut === true;
  const output = normalizeOptionalString(obj.output) ?? "";

  let text;
  if (event === "exec.started") {
    text = `Exec started (node=${nodeId}${runId ? ` id=${runId}` : ""})`;
    if (command) {
      text += `: ${command}`;
    }
  } else {
    const exitLabel = timedOut ? "timeout" : `code ${exitCode ?? "?"}`;
    const compactOutput = compactNodeEventText(output, MAX_EXEC_EVENT_OUTPUT_CHARS);
    const shouldNotify = timedOut || exitCode !== 0 || compactOutput.length > 0;
    if (!shouldNotify) {
      release?.();
      return undefined;
    }
    text = `Exec finished (node=${nodeId}${runId ? ` id=${runId}` : ""}, ${exitLabel})`;
    if (compactOutput) {
      text += `\n${compactOutput}`;
    }
  }

  const notify = async () => {
    let releaseOnExit = release;
    try {
      const expectedTarget =
        authorization?.expectedTarget ??
        (await captureSessionEventTargetForHost(agentId, eventSessionKey, {
          assertCaptureCurrent: assertAcceptanceCurrent,
        }));
      expectedTarget.assertCurrent?.();
      if (!(await isNodeEventConnectionCurrent(opts))) {
        return pairingChangedResult(event);
      }
      assertAcceptanceCurrent();
      if (
        event === "exec.finished" &&
        runId &&
        shouldDropDuplicateExecFinished({ sessionKey, runId, now: Date.now() })
      ) {
        return undefined;
      }
      const receipt = enqueueNodeExecNotice({
        sessionKey: expectedTarget.sessionKey ?? eventSessionKey,
        agentId: expectedTarget.agentId ?? agentId,
        authorization: auth,
        runId,
        text,
        expectedTarget,
        // The registry accepted this notice before the node connection could depart.
        assertAcceptanceCurrent: config.assertCurrent,
      });
      if (receipt) {
        const accepted = await receipt.accepted;
        if (!accepted.ok) {
          throw new Error(accepted.error);
        }
        void receipt.settled
          .then((outcome) => {
            if (outcome.status !== "completed") {
              ctx.logGateway.warn(`exec event not delivered node=${nodeId}: ${outcome.status}`);
            }
          })
          .finally(release);
        releaseOnExit = undefined;
        return undefined;
      }
      return undefined;
    } finally {
      // Accepted receipts retain their own source; rejected and ignored notices end here.
      releaseOnExit?.();
    }
  };
  // A caller still waiting on this run gets its output inline; notify only if that fails.
  if (authorization?.holdNotice) {
    authorization.holdNotice(() => {
      void notify().catch((error: unknown) => {
        ctx.logGateway.warn(
          `exec event not delivered node=${nodeId}: ${formatErrorMessage(error)}`,
        );
      });
    });
  } else {
    return await notify();
  }
  return undefined;
}
