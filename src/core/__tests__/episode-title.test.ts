import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTitles, enrichEpisodeTitles } from "../episode/title";
import type { EpisodeCandidate, EpisodeSplitConfig, LlmConfig, Transcript } from "../../shared/api-types";

const LLM: LlmConfig = { baseUrl: "https://api.example.com/v1", apiKey: "sk-x", model: "deepseek-flash" };

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

function makeTranscript(): Transcript {
  return {
    language: "zh",
    engine: "sensevoice-local",
    durationSec: 600,
    segments: [
      { id: 0, startSec: 0, endSec: 60, text: "这一段讲的是环境变量配置。后面还有别的内容。", words: [] },
      { id: 1, startSec: 60, endSec: 120, text: "先绑定 KV 命名空间,再写 UUID。", words: [] },
      { id: 2, startSec: 300, endSec: 360, text: "接下来看清理与验证的步骤。", words: [] },
      { id: 3, startSec: 360, endSec: 420, text: "最后跑一遍完整流程。", words: [] },
    ],
  };
}

const EPISODES: EpisodeCandidate[] = [
  { id: 1, title: "第 1 集", startSec: 0, endSec: 300, durationSec: 300, reason: "" },
  { id: 2, title: "第 2 集", startSec: 300, endSec: 600, durationSec: 300, reason: "" },
];

function envelope(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseTitles", () => {
  it("reads the strict JSON shape", () => {
    expect(parseTitles('{"titles":["KV 绑定与环境变量配置","清理与验证流程"]}')).toEqual(["KV 绑定与环境变量配置", "清理与验证流程"]);
  });

  it("reads a Markdown table by the title column", () => {
    const raw = ["| 集 | 标题 |", "|---|---|", "| 1 | **KV 绑定与环境变量配置** |", "| 2 | 清理与验证流程 |"].join("\n");
    expect(parseTitles(raw)).toEqual(["KV 绑定与环境变量配置", "清理与验证流程"]);
  });

  it("reads a numbered list and strips numbering plus episode prefixes", () => {
    const raw = ["1. KV 绑定与环境变量配置", "2. 第 2 集:清理与验证流程"].join("\n");
    expect(parseTitles(raw)).toEqual(["KV 绑定与环境变量配置", "清理与验证流程"]);
  });

  it("throws when nothing readable is in the response", () => {
    expect(() => parseTitles("我觉得这几集讲得都挺清楚的,不需要标题")).toThrow();
  });
});

describe("enrichEpisodeTitles", () => {
  it("applies AI titles in order", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope('{"titles":["KV 绑定与环境变量配置","清理与验证流程"]}')));
    const result = await enrichEpisodeTitles(makeTranscript(), EPISODES, CONFIG, LLM);
    expect(result.titleWarning).toBeUndefined();
    expect(result.episodes.map((ep) => ep.title)).toEqual(["P1 KV 绑定与环境变量配置", "P2 清理与验证流程"]);
  });

  it("falls back to a whole first sentence and reports why", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const result = await enrichEpisodeTitles(makeTranscript(), EPISODES, CONFIG, LLM);
    expect(result.titleWarning).toContain("HTTP 500");
    expect(result.episodes[0].title).toBe("P1 这一段讲的是环境变量配置");
    expect(result.episodes[1].title).toBe("P2 接下来看清理与验证的步骤");
  });

  it("keeps the AI chapter title when the title call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const withChapter = [{ ...EPISODES[0], title: "环境变量配置" }, EPISODES[1]];
    const result = await enrichEpisodeTitles(makeTranscript(), withChapter, CONFIG, LLM);
    expect(result.episodes[0].title).toBe("P1 环境变量配置");
  });
});
