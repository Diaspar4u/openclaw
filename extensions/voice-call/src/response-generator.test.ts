import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CoreAgentDeps } from "./core-bridge.js";
import { generateVoiceResponse } from "./response-generator.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

function createMockAgentRuntime(): CoreAgentDeps {
  return {
    resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent"),
    resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
    ensureAgentWorkspace: vi.fn().mockResolvedValue(undefined),
    resolveThinkingDefault: vi.fn().mockReturnValue("off"),
    resolveAgentIdentity: vi.fn().mockReturnValue({ name: "TestBot" }),
    resolveAgentTimeoutMs: vi.fn().mockReturnValue(30000),
    runEmbeddedPiAgent: vi.fn().mockResolvedValue({ payloads: [{ text: "Hello" }] }),
    defaults: {
      provider: "openai",
      model: "gpt-4o-mini",
    },
    session: {
      resolveStorePath: vi.fn().mockReturnValue("/tmp/store"),
      loadSessionStore: vi.fn().mockReturnValue({}),
      saveSessionStore: vi.fn().mockResolvedValue(undefined),
      resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/session.jsonl"),
    },
  } as unknown as CoreAgentDeps;
}

describe("generateVoiceResponse", () => {
  const baseCoreConfig = { session: { store: "/tmp" } } as never;
  let mockRuntime: ReturnType<typeof createMockAgentRuntime>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRuntime = createMockAgentRuntime();
  });

  it("defaults agentId to 'main' when responseAgentId is not set", async () => {
    const voiceConfig = createVoiceCallBaseConfig();

    await generateVoiceResponse({
      voiceConfig,
      coreConfig: baseCoreConfig,
      agentRuntime: mockRuntime,
      callId: "call-1",
      from: "+15559991234",
      transcript: [],
      userMessage: "Hi",
    });

    const session = mockRuntime.session as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(session.resolveStorePath).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: "main" }),
    );
    expect(mockRuntime.resolveAgentDir).toHaveBeenCalledWith(expect.anything(), "main");
    expect(mockRuntime.resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.anything(), "main");
    expect(mockRuntime.resolveAgentIdentity).toHaveBeenCalledWith(expect.anything(), "main");
    expect(session.resolveSessionFilePath).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ agentId: "main" }),
    );
    expect(mockRuntime.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
  });

  it("uses responseAgentId from config when set", async () => {
    const voiceConfig = { ...createVoiceCallBaseConfig(), responseAgentId: "nikki" };

    await generateVoiceResponse({
      voiceConfig,
      coreConfig: baseCoreConfig,
      agentRuntime: mockRuntime,
      callId: "call-2",
      from: "+15559991234",
      transcript: [],
      userMessage: "Hi",
    });

    const session = mockRuntime.session as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(session.resolveStorePath).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentId: "nikki" }),
    );
    expect(mockRuntime.resolveAgentDir).toHaveBeenCalledWith(expect.anything(), "nikki");
    expect(mockRuntime.resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.anything(), "nikki");
    expect(mockRuntime.resolveAgentIdentity).toHaveBeenCalledWith(expect.anything(), "nikki");
    expect(session.resolveSessionFilePath).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ agentId: "nikki" }),
    );
    expect(mockRuntime.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "nikki" }),
    );
  });

  it("passes agentId through to embedded run", async () => {
    const voiceConfig = { ...createVoiceCallBaseConfig(), responseAgentId: "dev" };

    await generateVoiceResponse({
      voiceConfig,
      coreConfig: baseCoreConfig,
      agentRuntime: mockRuntime,
      callId: "call-3",
      from: "+15559991234",
      transcript: [],
      userMessage: "Test",
    });

    const runCall = (mockRuntime.runEmbeddedPiAgent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(runCall.agentId).toBe("dev");
    expect(runCall.lane).toBe("voice");
    expect(runCall.prompt).toBe("Test");
  });

  it("returns null text when coreConfig is falsy", async () => {
    const voiceConfig = createVoiceCallBaseConfig();
    const result = await generateVoiceResponse({
      voiceConfig,
      coreConfig: null as never,
      agentRuntime: mockRuntime,
      callId: "call-4",
      from: "+15559991234",
      transcript: [],
      userMessage: "Hi",
    });

    expect(result.text).toBeNull();
    expect(result.error).toContain("Core config unavailable");
  });
});
