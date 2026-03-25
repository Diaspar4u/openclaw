import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";

const mockDeliverOutboundPayloads = vi.hoisted(() => vi.fn());
const mockNormalizeChannelId = vi.hoisted(() => vi.fn());

let sendTranscriptEcho: typeof import("./echo-transcript.js").sendTranscriptEcho;
let DEFAULT_ECHO_TRANSCRIPT_FORMAT: string;

function baseCfg(): OpenClawConfig {
  return {};
}

function baseCtx(overrides?: Partial<MsgContext>): MsgContext {
  return {
    Body: "test",
    Provider: "telegram",
    From: "12345",
    AccountId: "dev",
    ...overrides,
  };
}

describe("sendTranscriptEcho", () => {
  beforeAll(async () => {
    vi.resetModules();
    vi.doMock("./echo-transcript.runtime.js", () => ({
      deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
      normalizeChannelId: (...args: unknown[]) => mockNormalizeChannelId(...args),
    }));

    const mod = await import("./echo-transcript.js");
    sendTranscriptEcho = mod.sendTranscriptEcho;
    DEFAULT_ECHO_TRANSCRIPT_FORMAT = mod.DEFAULT_ECHO_TRANSCRIPT_FORMAT;
  });

  beforeEach(() => {
    mockDeliverOutboundPayloads.mockReset();
    mockDeliverOutboundPayloads.mockResolvedValue([]);
    mockNormalizeChannelId.mockReset();
    mockNormalizeChannelId.mockImplementation((ch: string) => ch.trim().toLowerCase() || null);
  });

  it("delivers echo with default format", async () => {
    const ctx = baseCtx();
    await sendTranscriptEcho({ ctx, cfg: baseCfg(), transcript: "hello world" });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledOnce();
    const call = mockDeliverOutboundPayloads.mock.calls[0][0];
    expect(call.channel).toBe("telegram");
    expect(call.to).toBe("12345");
    expect(call.payloads).toHaveLength(1);
    expect(call.payloads[0].text).toBe('📝 "hello world"');
    expect(call.bestEffort).toBe(true);
  });

  it("uses custom format", async () => {
    const ctx = baseCtx();
    await sendTranscriptEcho({
      ctx,
      cfg: baseCfg(),
      transcript: "custom msg",
      format: "🎙️ Heard: {transcript}",
    });

    const call = mockDeliverOutboundPayloads.mock.calls[0][0];
    expect(call.payloads[0].text).toBe("🎙️ Heard: custom msg");
  });

  it("passes accountId and threadId from ctx", async () => {
    const ctx = baseCtx({ AccountId: "acc1", MessageThreadId: "2181" });
    await sendTranscriptEcho({ ctx, cfg: baseCfg(), transcript: "test" });

    const call = mockDeliverOutboundPayloads.mock.calls[0][0];
    expect(call.accountId).toBe("acc1");
    expect(call.threadId).toBe("2181");
  });

  it("prefers OriginatingTo over From for delivery target", async () => {
    const ctx = baseCtx({ From: "12345", OriginatingTo: "+19999999999" });
    await sendTranscriptEcho({ ctx, cfg: baseCfg(), transcript: "test" });

    const call = mockDeliverOutboundPayloads.mock.calls[0][0];
    expect(call.to).toBe("+19999999999");
  });

  it("skips when channel is not routable (normalizeChannelId returns null)", async () => {
    mockNormalizeChannelId.mockReturnValue(null);
    const ctx = baseCtx({ Provider: "internal-system" });

    await sendTranscriptEcho({ ctx, cfg: baseCfg(), transcript: "test" });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("skips when ctx has no Provider/Surface", async () => {
    const ctx = baseCtx({ Provider: undefined, Surface: undefined });

    await sendTranscriptEcho({ ctx, cfg: baseCfg(), transcript: "test" });

    expect(mockNormalizeChannelId).not.toHaveBeenCalled();
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("skips when ctx has no From or OriginatingTo", async () => {
    const ctx = baseCtx({ From: undefined, OriginatingTo: undefined });

    await sendTranscriptEcho({ ctx, cfg: baseCfg(), transcript: "test" });

    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does not throw on delivery failure", async () => {
    mockDeliverOutboundPayloads.mockRejectedValueOnce(new Error("delivery timeout"));
    const ctx = baseCtx();

    // Should not throw
    await expect(
      sendTranscriptEcho({ ctx, cfg: baseCfg(), transcript: "test" }),
    ).resolves.toBeUndefined();
  });

  it("DEFAULT_ECHO_TRANSCRIPT_FORMAT contains {transcript} placeholder", () => {
    expect(DEFAULT_ECHO_TRANSCRIPT_FORMAT).toContain("{transcript}");
  });
});
