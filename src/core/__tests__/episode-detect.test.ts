import { afterEach, describe, expect, it, vi } from "vitest";
import { detectEpisodes } from "../episode/detect";
import type { EpisodeSplitConfig, LlmConfig, Transcript } from "../../shared/api-types";

const LLM: LlmConfig = { baseUrl: "https://api.example.com/v1", apiKey: "sk-x", model: "gpt-5.6-terra" };

const CONFIG: EpisodeSplitConfig = {
  mode: "smart",
  targetMinSec: 180,
  targetMaxSec: 300,
  fixedIntervalSec: 900,
  titleTemplate: "【{prefix}】{number} {title}",
  titlePrefix: "",
  numberFormat: "P{n}",
  subtitles: false,
  srtFile: false,
};

function makeTranscript(durationSec = 720, intervalSec = 60): Transcript {
  const segments = [];
  for (let t = 0; t < durationSec; t += intervalSec) {
    segments.push({
      id: Math.floor(t / intervalSec),
      startSec: t,
      endSec: t + intervalSec,
      text: `第 ${Math.floor(t / intervalSec) + 1} 句话,讲的是当前章节的内容。`,
      words: [],
    });
  }
  return { segments, durationSec, language: "zh", engine: "sensevoice-local" };
}

function envelope(content: string): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectEpisodes 智能分集走模型正文", () => {
  it("真实响应信封里的断点能切出 AI 分集,不再回退等时", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope(
      '{"breaks":[{"segmentId":5,"timeSec":300,"reason":"从概念转入实操","chapterTitle":"实操演示"}]}'
    )));
    const result = await detectEpisodes(makeTranscript(), LLM, CONFIG);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.episodes).toHaveLength(2);
    expect(result.episodes[0].title).toBe("实操演示");
    expect(result.episodes[0].reason).toBe("从概念转入实操");
    expect(result.episodes[0].endSec).toBe(300);
    expect(result.episodes[1].endSec).toBe(720);
  });

  it("模型明确说没有断点时,回退原因说明是内容连贯,不是解析失败", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope('{"breaks":[]}')));
    const result = await detectEpisodes(makeTranscript(), LLM, CONFIG);
    expect(result.episodes.length).toBeGreaterThan(0);
    expect(result.fallbackReason).toContain("同一个话题");
  });

  it("模型调用失败时,回退原因带出真实错误", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const result = await detectEpisodes(makeTranscript(), LLM, CONFIG);
    expect(result.episodes.length).toBeGreaterThan(0);
    expect(result.fallbackReason).toContain("HTTP 500");
  });

  it("断点按时间对齐到句子边界,不切在句子中间", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope(
      '{"breaks":[{"segmentId":5,"timeSec":302,"reason":"切换","chapterTitle":"第二段"}]}'
    )));
    const result = await detectEpisodes(makeTranscript(), LLM, CONFIG);
    expect(result.episodes[0].endSec).toBe(300);
  });
});
