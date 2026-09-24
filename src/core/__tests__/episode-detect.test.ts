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
    expect(result.episodes[0].endSec).toBe(300);
    // chapterTitle 描述的是断点之后那一段,归属从断点开始的那一集
    expect(result.episodes[1].title).toBe("实操演示");
    expect(result.episodes[1].reason).toBe("从概念转入实操");
    expect(result.episodes[result.episodes.length - 1].endSec).toBe(720);
  });

  it("时长硬约束生效:超过 targetMax 的尾段被补切,每集都落在目标范围内", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope(
      '{"breaks":[{"segmentId":5,"timeSec":300,"reason":"从概念转入实操","chapterTitle":"实操演示"}]}'
    )));
    const result = await detectEpisodes(makeTranscript(), LLM, CONFIG);
    for (const ep of result.episodes) {
      expect(ep.durationSec).toBeGreaterThanOrEqual(CONFIG.targetMinSec);
      expect(ep.durationSec).toBeLessThanOrEqual(CONFIG.targetMaxSec);
    }
  });

  it("reason 里的权衡过程被剔除,只留事实描述", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope(
      '{"breaks":[{"segmentId":5,"timeSec":300,"reason":"从概念转入实操。建议在此断开,符合目标时长","chapterTitle":"实操演示"}]}'
    )));
    const result = await detectEpisodes(makeTranscript(), LLM, CONFIG);
    expect(result.episodes[1].reason).toBe("从概念转入实操");
  });

  it("模型每个窗口都只吐思考不给正文时,才报错让用户换模型", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "", reasoning_content: "让我先通读一遍逐句稿" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    await expect(detectEpisodes(makeTranscript(), LLM, CONFIG)).rejects.toThrow("只返回了思考过程");
  });

  it("只有部分窗口吐不出正文时,拿其余窗口的断点继续,不打断整个任务", async () => {
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      call++;
      // 2 小时 → 3 个窗口;第一个窗口只有思考,后两个正常
      if (call <= 2) {
        return new Response(JSON.stringify({
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "", reasoning_content: "想了半天" } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return envelope('{"breaks":[{"segmentId":50,"timeSec":3000,"reason":"话题切换","chapterTitle":"第二章"}]}');
    }));
    const result = await detectEpisodes(makeTranscript(7200), LLM, CONFIG);
    expect(result.episodes.length).toBeGreaterThan(0);
    expect(result.fallbackReason).toContain("AI 调用失败");
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

  it("长视频按 45 分钟窗口并行调用,窗口数与调用次数一致", async () => {
    const fetchMock = vi.fn(async () => envelope('{"breaks":[]}'));
    vi.stubGlobal("fetch", fetchMock);
    // 2 小时 → 45/45/30 三个窗口
    await detectEpisodes(makeTranscript(7200), LLM, CONFIG);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
