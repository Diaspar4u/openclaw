import path from "node:path";
import type { MutationGateConfig } from "../config/types.tools.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isCronSessionKey } from "../routing/session-key.js";
import { normalizeToolName } from "./tool-policy.js";

const log = createSubsystemLogger("agents/mutation-gate");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const OCG_APPROVE_CALLBACK_DATA = "ocg_approve";

/**
 * Staleness TTL — unclaimed approvals are cleaned up after 24 hours.
 * This is NOT a user-facing approval window; approvals are one-shot
 * (consumed immediately when a mutation executes).
 */
const APPROVAL_STALENESS_TTL_MS = 86_400_000; // 24 hours

/**
 * Default channels where the mutation gate is enforced.
 * Only channels with inline-button approval support should be listed.
 */
const DEFAULT_GATE_CHANNELS = ["telegram"];

/**
 * Session key segments that represent DM scopes, not channel providers.
 * DM session keys follow "agent:<id>:main" or "agent:<id>:direct:<peer>"
 * patterns — position 2 is a scope identifier, not a channel name.
 * These must not be treated as channel names for gate bypass decisions.
 */
const DM_SCOPE_SEGMENTS = new Set(["main", "direct", "subagent"]);

/**
 * Default mutation tool list — only high-impact tools that modify
 * infrastructure or apply bulk code changes.
 * config.extraMutations adds ON TOP of this list (no replacement).
 */
const DEFAULT_MUTATION_TOOLS: readonly string[] = ["apply_patch", "gateway"];

// ---------------------------------------------------------------------------
// Approval state
// ---------------------------------------------------------------------------

type ApprovalEntry = { timestamp: number; senderId: string; sessionId?: string };

const MUTATION_APPROVALS = new Map<string, ApprovalEntry>();

/**
 * Evict stale entries from the approval map.  Called on every new approval
 * so the map stays bounded without needing a background timer.
 */
function evictStaleApprovals(): void {
  const now = Date.now();
  for (const [key, entry] of MUTATION_APPROVALS) {
    if (now - entry.timestamp > APPROVAL_STALENESS_TTL_MS) {
      MUTATION_APPROVALS.delete(key);
    }
  }
}

export function recordMutationApproval(
  sessionKey: string,
  senderId: string,
  sessionId?: string,
): void {
  evictStaleApprovals();
  MUTATION_APPROVALS.set(sessionKey, { timestamp: Date.now(), senderId, sessionId });
  log.info(`mutation approval recorded: session=${sessionKey} sender=${senderId}`);
}

export function clearMutationApproval(sessionKey: string): void {
  MUTATION_APPROVALS.delete(sessionKey);
}

/**
 * Check and consume a pending approval.  One click = one tool call.
 * The approval is deleted immediately so the next mutation requires a new click.
 *
 * Session scoping: when both the stored approval and the caller provide a
 * `sessionId`, they must match.  An approval recorded without a sessionId
 * (e.g. legacy path or edge case where session entry was unavailable) is
 * accepted by any session to avoid deadlocking the agent.
 */
function consumeMutationApproval(sessionKey: string, sessionId?: string): boolean {
  const entry = MUTATION_APPROVALS.get(sessionKey);
  if (!entry) {
    return false;
  }
  // Stale cleanup — approval was never claimed
  if (Date.now() - entry.timestamp > APPROVAL_STALENESS_TTL_MS) {
    MUTATION_APPROVALS.delete(sessionKey);
    return false;
  }
  // Session scope check: reject approval from a different ephemeral session
  // (e.g. approval clicked in old conversation, new conversation started via /new).
  if (sessionId && entry.sessionId && sessionId !== entry.sessionId) {
    MUTATION_APPROVALS.delete(sessionKey);
    log.info(
      `mutation approval rejected (session mismatch): session=${sessionKey} expected=${sessionId} got=${entry.sessionId}`,
    );
    return false;
  }
  // Consume: one-shot
  MUTATION_APPROVALS.delete(sessionKey);
  log.info(`mutation approval consumed: session=${sessionKey}`);
  return true;
}

// ---------------------------------------------------------------------------
// Memory file write detection
// ---------------------------------------------------------------------------

/**
 * Check whether a write/edit tool call targets the agent's own memory files.
 * Memory writes are always allowed (agent must be able to flush memory
 * without user approval).
 */
function isMemoryFileWrite(toolName: string, params: unknown, agentWorkspace?: string): boolean {
  if (toolName !== "write" && toolName !== "edit") {
    return false;
  }
  // Accept both "file_path" (raw from model) and "path" (canonical/normalized form)
  const record = params && typeof params === "object" ? (params as Record<string, unknown>) : null;
  const filePath =
    typeof record?.file_path === "string"
      ? record.file_path
      : typeof record?.path === "string"
        ? record.path
        : undefined;
  if (typeof filePath !== "string") {
    return false;
  }

  // Workspace constraint is mandatory — without it we can't verify the write
  // targets the agent's own memory (any path ending in /MEMORY.md would pass).
  if (!agentWorkspace) {
    return false;
  }

  const normalizedWorkspace = agentWorkspace.endsWith(path.sep)
    ? agentWorkspace
    : `${agentWorkspace}${path.sep}`;
  // Resolve relative paths against workspace before prefix check so that
  // model-supplied paths like "MEMORY.md" or "memory/2026-03-04.md" are
  // correctly identified as memory writes.  path.resolve() normalizes
  // traversal sequences ("../") to prevent escaping the workspace.
  const rawPath = path.isAbsolute(filePath) ? filePath : path.join(normalizedWorkspace, filePath);
  const resolvedPath = path.normalize(rawPath);
  if (!resolvedPath.startsWith(normalizedWorkspace)) {
    return false;
  }

  // Match MEMORY.md or memory/*.md (handle both / and \ separators)
  if (resolvedPath.endsWith(`${path.sep}MEMORY.md`)) {
    return true;
  }
  // Direct child of workspace-root memory/ dir (e.g. <workspace>/memory/notes.md)
  const memoryDir = `${normalizedWorkspace}memory${path.sep}`;
  if (resolvedPath.startsWith(memoryDir) && resolvedPath.endsWith(".md")) {
    // Only allow direct children — no subdirectories
    const remainder = resolvedPath.slice(memoryDir.length);
    if (!remainder.includes(path.sep)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Gate check
// ---------------------------------------------------------------------------

type GateResult = { allowed: true } | { allowed: false; reason: string };

/**
 * Extract the channel provider from a session key.
 * Session keys follow patterns like "agent:<id>:<channel>:group:..." or "agent:<id>:<channel>:main".
 */
function extractChannelFromSessionKey(sessionKey: string): string | undefined {
  // e.g. "agent:dev:telegram:group:-100123:topic:42"
  const parts = sessionKey.split(":");
  // parts[0] = "agent", parts[1] = agentId, parts[2] = channel
  return parts.length >= 3 ? parts[2]?.toLowerCase() : undefined;
}

export function checkMutationGate(args: {
  toolName: string;
  params: unknown;
  sessionKey: string;
  /** Ephemeral session UUID — used to scope approvals to the current conversation. */
  sessionId?: string;
  config: MutationGateConfig;
  agentWorkspace?: string;
  /** When false, inline-button approval is unavailable for this session.
   *  The gate skips enforcement to avoid deadlocking the agent. */
  hasInlineButtons?: boolean;
  /** When false, the message tool is not in the current tool set.
   *  The gate skips enforcement because the agent cannot send approval requests. */
  hasMessageTool?: boolean;
}): GateResult {
  if (!args.config.enabled) {
    return { allowed: true };
  }

  // Skip gating when inline buttons are explicitly unavailable (e.g. channel
  // posts, non-Telegram channels that lack button support). Gating without
  // a way to approve would deadlock the agent.
  if (args.hasInlineButtons === false) {
    return { allowed: true };
  }

  // Skip gating when the message tool is not available (e.g. coding/minimal
  // profiles). The agent cannot send approval-request messages without it,
  // so gating would deadlock.
  if (args.hasMessageTool === false) {
    return { allowed: true };
  }

  // Only enforce the gate on channels that support inline-button approval.
  // DM scope identifiers ("main", "direct", "subagent") mean the session key
  // doesn't carry the provider name (e.g. "agent:dev:main").  Without knowing
  // the provider we can't tell whether inline buttons are available, so we
  // allow the call rather than gating with no way to approve.
  const channel = extractChannelFromSessionKey(args.sessionKey);
  if (!channel) {
    // Cannot determine provider — assume non-interactive context, allow
    return { allowed: true };
  }
  const gateChannels = args.config.channels ?? DEFAULT_GATE_CHANNELS;
  if (channel && DM_SCOPE_SEGMENTS.has(channel)) {
    return { allowed: true };
  }
  if (channel && !gateChannels.includes(channel)) {
    return { allowed: true };
  }

  // Cron sessions run autonomously with no human to click approval buttons.
  if (isCronSessionKey(args.sessionKey)) {
    log.info(`mutation gate bypassed for autonomous session: session=${args.sessionKey}`);
    return { allowed: true };
  }

  const toolName = normalizeToolName(args.toolName);

  // Gate tools in the default list + any extras from config (additive, deduplicated).
  // Normalize extraMutations so config entries like "Gateway" or "bash" (alias)
  // match after normalizeToolName is applied to the incoming tool call.
  const normalizedExtras = (args.config.extraMutations ?? []).map(normalizeToolName);
  const mutations = new Set([...DEFAULT_MUTATION_TOOLS, ...normalizedExtras]);
  if (!mutations.has(toolName)) {
    return { allowed: true };
  }

  // Memory file writes always allowed
  if (isMemoryFileWrite(toolName, args.params, args.agentWorkspace)) {
    return { allowed: true };
  }

  // Check for valid approval (one-shot: consumed on use, scoped to sessionId)
  if (consumeMutationApproval(args.sessionKey, args.sessionId)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `\u26a0\ufe0f Mutation blocked \u2014 approval required. Send a message with an inline button (callback_data="${OCG_APPROVE_CALLBACK_DATA}") to request approval, then retry.`,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export const __testing = {
  MUTATION_APPROVALS,
  DEFAULT_MUTATION_TOOLS,
  DEFAULT_GATE_CHANNELS,
  DM_SCOPE_SEGMENTS,
  isMemoryFileWrite,
  consumeMutationApproval,
  extractChannelFromSessionKey,
  evictStaleApprovals,
  APPROVAL_STALENESS_TTL_MS,
};
