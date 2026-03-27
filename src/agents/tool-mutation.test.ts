import { describe, expect, it } from "vitest";
import {
  buildToolActionFingerprint,
  buildToolMutationState,
  isLikelyMutatingToolName,
  isMutatingToolCall,
  isSameToolMutationAction,
} from "./tool-mutation.js";

describe("tool mutation helpers", () => {
  it("treats session_status as mutating only when model override is provided", () => {
    expect(isMutatingToolCall("session_status", { sessionKey: "agent:main:main" })).toBe(false);
    expect(
      isMutatingToolCall("session_status", {
        sessionKey: "agent:main:main",
        model: "openai/gpt-4o",
      }),
    ).toBe(true);
  });

  it("builds stable fingerprints for mutating calls and omits read-only calls", () => {
    const writeFingerprint = buildToolActionFingerprint(
      "write",
      { path: "/tmp/demo.txt", id: 42 },
      "write /tmp/demo.txt",
    );
    expect(writeFingerprint).toContain("tool=write");
    expect(writeFingerprint).toContain("path=/tmp/demo.txt");
    expect(writeFingerprint).toContain("id=42");
    expect(writeFingerprint).not.toContain("meta=write /tmp/demo.txt");

    const metaOnlyFingerprint = buildToolActionFingerprint("exec", { command: "ls -la" }, "ls -la");
    expect(metaOnlyFingerprint).toContain("tool=exec");
    expect(metaOnlyFingerprint).toContain("meta=ls -la");

    const readFingerprint = buildToolActionFingerprint("read", { path: "/tmp/demo.txt" });
    expect(readFingerprint).toBeUndefined();
  });

  it("treats coding-tool path aliases as the same stable target", () => {
    const filePathFingerprint = buildToolActionFingerprint("edit", {
      file_path: "/tmp/demo.txt",
      old_string: "before",
      new_string: "after",
    });
    const fileAliasFingerprint = buildToolActionFingerprint("edit", {
      file: "/tmp/demo.txt",
      oldText: "before",
      newText: "after again",
    });

    expect(filePathFingerprint).toBe("tool=edit|path=/tmp/demo.txt");
    expect(fileAliasFingerprint).toBe("tool=edit|path=/tmp/demo.txt");
  });

  it("exposes mutation state for downstream payload rendering", () => {
    expect(
      buildToolMutationState("message", { action: "send", to: "telegram:1" }).mutatingAction,
    ).toBe(true);
    expect(buildToolMutationState("browser", { action: "list" }).mutatingAction).toBe(false);
  });

  it("matches tool actions by fingerprint and fails closed on asymmetric data", () => {
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
      ),
    ).toBe(true);
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/b" },
      ),
    ).toBe(false);
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
        { toolName: "write" },
      ),
    ).toBe(false);
  });

  it("classifies gateway dotted actions as read-only or mutating", () => {
    // Read-only gateway actions
    expect(isMutatingToolCall("gateway", { action: "config.get" })).toBe(false);
    expect(isMutatingToolCall("gateway", { action: "config.schema" })).toBe(false);
    expect(isMutatingToolCall("gateway", { action: "config.schema.lookup" })).toBe(false);

    // Mutating gateway actions
    expect(isMutatingToolCall("gateway", { action: "restart" })).toBe(true);
    expect(isMutatingToolCall("gateway", { action: "config.apply" })).toBe(true);
    expect(isMutatingToolCall("gateway", { action: "config.patch" })).toBe(true);
    expect(isMutatingToolCall("gateway", { action: "update.run" })).toBe(true);

    // Fail-closed: no action, unknown action, or bare verbs not in GATEWAY_READ_ONLY_ACTIONS
    expect(isMutatingToolCall("gateway", {})).toBe(true);
    expect(isMutatingToolCall("gateway", { action: "unknown.thing" })).toBe(true);
    expect(isMutatingToolCall("gateway", { action: "list" })).toBe(true);
    expect(isMutatingToolCall("gateway", { action: "status" })).toBe(true);

    // Fingerprint: read-only gateway calls produce no fingerprint
    expect(buildToolActionFingerprint("gateway", { action: "config.get" })).toBeUndefined();

    // Cron/canvas still use only READ_ONLY_ACTIONS (unchanged behavior)
    expect(isMutatingToolCall("cron", { action: "list" })).toBe(false);
    expect(isMutatingToolCall("cron", { action: "config.get" })).toBe(true);
    expect(isMutatingToolCall("canvas", { action: "get" })).toBe(false);
  });

  it("keeps legacy name-only mutating heuristics for payload fallback", () => {
    expect(isLikelyMutatingToolName("sessions_send")).toBe(true);
    expect(isLikelyMutatingToolName("browser_actions")).toBe(true);
    expect(isLikelyMutatingToolName("message_slack")).toBe(true);
    expect(isLikelyMutatingToolName("browser")).toBe(false);
  });
});
