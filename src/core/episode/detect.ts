/**
 * 分集检测编排器:转写结果 → LLM 识别话题断点 → 分集候选列表。
 * 与爆点检测(highlight/detect.ts)并行的另一条管线。
 */
import type { Transcript, LlmConfig, EpisodeCandidate, EpisodeSplitConfig } from "../../shared/api-types";
import { episodeSystemPrompt, buildEpisodePrompt } from "./prompt";
import { parseBreaks, smartSplit, fixedSplit } from "./split";
import { requestLlmText, llmRequestBudget } from "../llm-transport";
import { isLocalBaseUrl } from "../../shared/llm-preflight";
import { extraParams, thinkingParams, MAX_TOKENS } from "../highlight/detect";

/** 调一次 LLM 拿章节断点。 */
async function chatEpisodeDetect(
  llm: LlmConfig,
  system: string,
  user: string,
  signal?: AbortSignal
): Promise<string> {
  const url = `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  // 分集逐句稿很长,给足超时:本地模型 5 分钟,远程 3 分钟
  const timeoutMs = isLocalBaseUrl(llm.baseUrl) ? 300_000 : 180_000;
  const budget = llmRequestBudget(timeoutMs);
  const res = await requestLlmText(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
      max_tokens: MAX_TOKENS,
      ...extraParams(llm.baseUrl),
      ...thinkingParams(llm.model),
    }),
  }, { signal, budget });
  return res.text;
}

/**
 * 分集结果,附带是否回退的信息。
 * fallbackReason 非空表示 AI 未成功,已自动回退等时切割。
 */
export interface EpisodeDetectResult {
  episodes: EpisodeCandidate[];
  fallbackReason?: string;
}

/**
 * 智能分集:调 LLM 找话题断点,然后按断点切割。
 * LLM 超时/格式错误时自动回退等时切割,并返回回退原因。
 */
export async function detectEpisodes(
  transcript: Transcript,
  llm: LlmConfig,
  config: EpisodeSplitConfig,
  signal?: AbortSignal
): Promise<EpisodeDetectResult> {
  if (config.mode === "fixed") {
    return { episodes: fixedSplit(transcript, config) };
  }
  if (config.mode === "manual") {
    return { episodes: [] };
  }

  // smart 模式
  try {
    const system = episodeSystemPrompt(transcript);
    const user = buildEpisodePrompt(transcript, config.targetMinSec, config.targetMaxSec);
    const raw = await chatEpisodeDetect(llm, system, user, signal);
    const breaks = parseBreaks(raw);
    if (breaks.length === 0) {
      // LLM 返回了但没找到断点,回退等时
      return {
        episodes: fixedSplit(transcript, config),
        fallbackReason: "AI 未识别到话题断点,已自动按等时切割",
      };
    }
    return { episodes: smartSplit(transcript, breaks, config) };
  } catch (err) {
    // LLM 失败,回退等时切割,但告诉用户原因
    const reason = err instanceof Error ? err.message : String(err);
    return {
      episodes: fixedSplit(transcript, config),
      fallbackReason: `AI 调用失败,已自动按等时切割。原因: ${reason}`,
    };
  }
}
