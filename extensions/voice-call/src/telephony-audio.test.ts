import { describe, expect, it } from "vitest";
import {
  convertPcmToMulaw8k,
  convertPcmChunkToMulaw8k,
  createPcmToMulawStreamState,
  flushPcmToMulawStream,
  resamplePcmTo8k,
} from "./telephony-audio.js";

function makeSinePcm(
  sampleRate: number,
  frequencyHz: number,
  durationSeconds: number,
  amplitude = 12_000,
): Buffer {
  const samples = Math.floor(sampleRate * durationSeconds);
  const output = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude);
    output.writeInt16LE(value, i * 2);
  }
  return output;
}

function rmsPcm(buffer: Buffer): number {
  const samples = Math.floor(buffer.length / 2);
  if (samples === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = buffer.readInt16LE(i * 2);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

/** Single-pass linear reference matching convertPcmChunkToMulaw8k's algorithm */
function linearSinglePass(pcm: Buffer, sampleRate: number): Buffer {
  const state = createPcmToMulawStreamState();
  const result = convertPcmChunkToMulaw8k(pcm, sampleRate, state);
  const flushed = flushPcmToMulawStream(state, sampleRate);
  const parts: Buffer[] = [];
  if (result.length > 0) parts.push(result);
  if (flushed.length > 0) parts.push(flushed);
  return parts.length > 0 ? Buffer.concat(parts) : Buffer.alloc(0);
}

describe("telephony-audio resamplePcmTo8k", () => {
  it("returns identical buffer for 8k input", () => {
    const pcm8k = makeSinePcm(8_000, 1_000, 0.2);
    const resampled = resamplePcmTo8k(pcm8k, 8_000);
    expect(resampled).toBe(pcm8k);
  });

  it("preserves low-frequency speech-band energy when downsampling", () => {
    const input = makeSinePcm(48_000, 1_000, 0.6);
    const output = resamplePcmTo8k(input, 48_000);
    expect(output.length).toBe(9_600);
    expect(rmsPcm(output)).toBeGreaterThan(7_500);
  });

  it("attenuates out-of-band high frequencies before 8k telephony conversion", () => {
    const lowTone = resamplePcmTo8k(makeSinePcm(48_000, 1_000, 0.6), 48_000);
    const highTone = resamplePcmTo8k(makeSinePcm(48_000, 6_000, 0.6), 48_000);
    const ratio = rmsPcm(highTone) / rmsPcm(lowTone);
    expect(ratio).toBeLessThan(0.1);
  });
});

describe("telephony-audio convertPcmToMulaw8k", () => {
  it("converts to 8k mu-law frame length", () => {
    const input = makeSinePcm(24_000, 1_000, 0.5);
    const mulaw = convertPcmToMulaw8k(input, 24_000);
    // 0.5s @ 8kHz => 4000 8-bit samples
    expect(mulaw.length).toBe(4_000);
  });
});

describe("incremental PCM-to-mulaw conversion", () => {
  it("produces identical output to single-pass for even-aligned chunks", () => {
    const sampleRate = 24000;
    const numSamples = 300;
    const pcm = Buffer.alloc(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      const value = Math.round(Math.sin((i / numSamples) * Math.PI * 4) * 16000);
      pcm.writeInt16LE(value, i * 2);
    }

    // Linear single-pass reference (streaming path uses linear interpolation)
    const reference = linearSinglePass(pcm, sampleRate);

    const chunkSize = 100;
    const state = createPcmToMulawStreamState();
    const chunks: Buffer[] = [];

    for (let offset = 0; offset < pcm.length; offset += chunkSize) {
      const chunk = pcm.subarray(offset, Math.min(offset + chunkSize, pcm.length));
      const result = convertPcmChunkToMulaw8k(chunk, sampleRate, state);
      if (result.length > 0) {
        chunks.push(result);
      }
    }
    const flushed = flushPcmToMulawStream(state, sampleRate);
    if (flushed.length > 0) chunks.push(flushed);

    const incremental = Buffer.concat(chunks);
    expect(incremental).toEqual(reference);
  });

  it("handles odd-byte chunks via leftover stashing", () => {
    const sampleRate = 8000;
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(100, 0);
    pcm.writeInt16LE(200, 2);
    pcm.writeInt16LE(300, 4);
    pcm.writeInt16LE(400, 6);

    const reference = linearSinglePass(pcm, sampleRate);

    const state = createPcmToMulawStreamState();
    const chunks: Buffer[] = [];

    const c1 = convertPcmChunkToMulaw8k(pcm.subarray(0, 3), sampleRate, state);
    if (c1.length > 0) chunks.push(c1);

    const c2 = convertPcmChunkToMulaw8k(pcm.subarray(3, 6), sampleRate, state);
    if (c2.length > 0) chunks.push(c2);

    const c3 = convertPcmChunkToMulaw8k(pcm.subarray(6, 8), sampleRate, state);
    if (c3.length > 0) chunks.push(c3);

    const flushed = flushPcmToMulawStream(state, sampleRate);
    if (flushed.length > 0) chunks.push(flushed);

    const incremental = Buffer.concat(chunks);
    expect(incremental).toEqual(reference);
  });

  it("handles leftover byte at end of stream", () => {
    const sampleRate = 8000;
    const pcm = Buffer.alloc(3);
    pcm.writeInt16LE(500, 0);
    pcm[2] = 0x42;

    const reference = linearSinglePass(pcm.subarray(0, 2), sampleRate);

    const state = createPcmToMulawStreamState();
    const result = convertPcmChunkToMulaw8k(pcm, sampleRate, state);
    const flushed = flushPcmToMulawStream(state);

    expect(state.leftover).toBeNull();
    expect(flushed.length).toBe(0);
    expect(result).toEqual(reference);
  });

  it("flush clears leftover state", () => {
    const state = createPcmToMulawStreamState();
    convertPcmChunkToMulaw8k(Buffer.from([0x42]), 8000, state);
    expect(state.leftover).not.toBeNull();

    flushPcmToMulawStream(state);
    expect(state.leftover).toBeNull();
  });

  it("empty chunk produces empty output", () => {
    const state = createPcmToMulawStreamState();
    const result = convertPcmChunkToMulaw8k(Buffer.alloc(0), 8000, state);
    expect(result.length).toBe(0);
  });

  it("defers interpolation at chunk edge instead of clamping s1", () => {
    const sampleRate = 20000;
    const fullPcm = Buffer.alloc(10);
    for (let i = 0; i < 5; i++) {
      fullPcm.writeInt16LE((i + 1) * 1000, i * 2);
    }

    const reference = linearSinglePass(fullPcm, sampleRate);

    const state = createPcmToMulawStreamState();
    const chunks: Buffer[] = [];

    const c1 = convertPcmChunkToMulaw8k(fullPcm.subarray(0, 6), sampleRate, state);
    if (c1.length > 0) chunks.push(c1);

    const c2 = convertPcmChunkToMulaw8k(fullPcm.subarray(6, 10), sampleRate, state);
    if (c2.length > 0) chunks.push(c2);

    const flushed = flushPcmToMulawStream(state, sampleRate);
    if (flushed.length > 0) chunks.push(flushed);

    const incremental = Buffer.concat(chunks);
    expect(incremental).toEqual(reference);
  });

  it("flush emits audio from deferred interpolation samples", () => {
    const sampleRate = 4000;
    const pcm = Buffer.alloc(6);
    pcm.writeInt16LE(1000, 0);
    pcm.writeInt16LE(2000, 2);
    pcm.writeInt16LE(3000, 4);

    const state = createPcmToMulawStreamState();
    const c1 = convertPcmChunkToMulaw8k(pcm, sampleRate, state);

    expect(state.interpLeftover).not.toBeNull();

    const flushed = flushPcmToMulawStream(state, sampleRate);

    expect(flushed.length).toBeGreaterThan(0);
    expect(state.interpLeftover).toBeNull();

    const reference = linearSinglePass(pcm, sampleRate);
    const parts: Buffer[] = [];
    if (c1.length > 0) parts.push(c1);
    if (flushed.length > 0) parts.push(flushed);
    expect(Buffer.concat(parts)).toEqual(reference);
  });

  it("flush emits deferred sample at boundary when downsampling", () => {
    const sampleRate = 20000;
    const pcm = Buffer.alloc(6);
    pcm.writeInt16LE(1000, 0);
    pcm.writeInt16LE(2000, 2);
    pcm.writeInt16LE(3000, 4);

    const state = createPcmToMulawStreamState();
    const c1 = convertPcmChunkToMulaw8k(pcm, sampleRate, state);

    expect(state.interpLeftover).not.toBeNull();

    const flushed = flushPcmToMulawStream(state, sampleRate);

    expect(flushed.length).toBeGreaterThan(0);
    expect(state.interpLeftover).toBeNull();

    const reference = linearSinglePass(pcm, sampleRate);
    const parts: Buffer[] = [];
    if (c1.length > 0) parts.push(c1);
    if (flushed.length > 0) parts.push(flushed);
    expect(Buffer.concat(parts)).toEqual(reference);
  });

  it("non-aligned chunks produce consistent output across boundaries", () => {
    const sampleRate = 24000;
    const numSamples = 100;
    const pcm = Buffer.alloc(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      pcm.writeInt16LE(Math.round(Math.sin((i / numSamples) * Math.PI * 2) * 10000), i * 2);
    }

    const reference = linearSinglePass(pcm, sampleRate);

    const chunkBytes = 14;
    const state = createPcmToMulawStreamState();
    const chunks: Buffer[] = [];

    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
      const result = convertPcmChunkToMulaw8k(chunk, sampleRate, state);
      if (result.length > 0) chunks.push(result);
    }
    const flushed = flushPcmToMulawStream(state, sampleRate);
    if (flushed.length > 0) chunks.push(flushed);

    const incremental = Buffer.concat(chunks);
    expect(incremental).toEqual(reference);
  });
});
