import { describe, expect, it, vi, beforeEach } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import type { CoreAgentDeps, CoreConfig } from "./core-bridge.js";
import { generateVoiceResponse } from "./response-generator.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

function createAgentRuntime(payloads: Array<Record<string, unknown>>) {
  const runEmbeddedPiAgent = vi.fn(async () => ({
    payloads,
    meta: { durationMs: 12, aborted: false },
  }));

  const runtime = {
    defaults: {
      provider: "together",
      model: "Qwen/Qwen2.5-7B-Instruct-Turbo",
    },
    resolveAgentDir: () => "/tmp/openclaw/agents/main",
    resolveAgentWorkspaceDir: () => "/tmp/openclaw/workspace/main",
    resolveAgentIdentity: () => ({ name: "tester" }),
    resolveThinkingDefault: () => "off",
    resolveAgentTimeoutMs: () => 30_000,
    ensureAgentWorkspace: async () => {},
    runEmbeddedPiAgent,
    session: {
      resolveStorePath: () => "/tmp/openclaw/sessions.json",
      loadSessionStore: () => ({}),
      saveSessionStore: async () => {},
      resolveSessionFilePath: () => "/tmp/openclaw/sessions/session.jsonl",
    },
  } as unknown as CoreAgentDeps;

  return { runtime, runEmbeddedPiAgent };
}

function requireEmbeddedAgentArgs(runEmbeddedPiAgent: ReturnType<typeof vi.fn>) {
  const calls = runEmbeddedPiAgent.mock.calls as unknown[][];
  const firstCall = calls[0];
  if (!firstCall) {
    throw new Error("voice response generator did not invoke the embedded agent");
  }
  const args = firstCall[0] as { extraSystemPrompt?: string } | undefined;
  if (!args?.extraSystemPrompt) {
    throw new Error("voice response generator did not pass the spoken-output contract prompt");
  }
  return args;
}

async function runGenerateVoiceResponse(
  payloads: Array<Record<string, unknown>>,
  overrides?: {
    runtime?: CoreAgentDeps;
    transcript?: Array<{ speaker: "user" | "bot"; text: string }>;
  },
) {
  const voiceConfig = VoiceCallConfigSchema.parse({
    responseTimeoutMs: 5000,
  });
  const coreConfig = {} as CoreConfig;
  const runtime = overrides?.runtime ?? createAgentRuntime(payloads).runtime;

  const result = await generateVoiceResponse({
    voiceConfig,
    coreConfig,
    agentRuntime: runtime,
    callId: "call-123",
    from: "+15550001111",
    transcript: overrides?.transcript ?? [{ speaker: "user", text: "hello there" }],
    userMessage: "hello there",
  });

  return { result };
}

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
  it("suppresses reasoning payloads and reads structured spoken output", async () => {
    const { runtime, runEmbeddedPiAgent } = createAgentRuntime([
      { text: "Reasoning: hidden", isReasoning: true },
      { text: '{"spoken":"Hello from JSON."}' },
    ]);
    const { result } = await runGenerateVoiceResponse([], { runtime });

    expect(result.text).toBe("Hello from JSON.");
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    const args = requireEmbeddedAgentArgs(runEmbeddedPiAgent);
    expect(args.extraSystemPrompt).toContain('{"spoken":"..."}');
  });

  it("extracts spoken text from fenced JSON", async () => {
    const { result } = await runGenerateVoiceResponse([
      { text: '```json\n{"spoken":"Fenced JSON works."}\n```' },
    ]);

    expect(result.text).toBe("Fenced JSON works.");
  });

  it("returns silence for an explicit empty spoken contract response", async () => {
    const { result } = await runGenerateVoiceResponse([{ text: '{"spoken":""}' }]);

    expect(result.text).toBeNull();
  });

  it("strips leading planning text when model returns plain text", async () => {
    const { result } = await runGenerateVoiceResponse([
      {
        text:
          "The user responded with short text. I should keep the response concise.\n\n" +
          "Sounds good. I can help with the next step whenever you are ready.",
      },
    ]);

    expect(result.text).toBe("Sounds good. I can help with the next step whenever you are ready.");
  });

  it("keeps plain conversational output when no JSON contract is followed", async () => {
    const { result } = await runGenerateVoiceResponse([
      { text: "Absolutely. Tell me what you want to do next." },
    ]);

    expect(result.text).toBe("Absolutely. Tell me what you want to do next.");
  });
});

describe("generateVoiceResponse agentId routing", () => {
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
