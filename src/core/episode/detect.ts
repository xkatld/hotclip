/**
 * 分集检测编排器:转写结果 → LLM 识别话题断点 → 分集候选列表。
 * 与爆点检测(highlight/detect.ts)并行的另一条管线。
 */
import type { Transcript, LlmConfig, EpisodeCandidate, EpisodeSplitConfig } from "../../shared/api-types";
import { episodeSystemPrompt, buildEpisodePrompt } from "./prompt";
import { parseBreaks, smartSplit, fixedSplit, manualSplit } from "./split";
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
  const timeout = isLocalBaseUrl(llm.baseUrl) ? 120_000 : 60_000;
  const budget = llmRequestBudget(1);
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
  }, { signal, budget, timeoutMs: timeout });
  return res.text;
}

/**
 * 智能分集:调 LLM 找话题断点,然后按断点切割。
 * 失败时(LLM 超时/返回格式错误)自动回退到等时切割��
 */
export async function detectEpisodes(
  transcript: Transcript,
  llm: LlmConfig,
  config: EpisodeSplitConfig,
  signal?: AbortSignal
): Promise<EpisodeCandidate[]> {
  if (config.mode === "fixed") {
    return fixedSplit(transcript, config);
  }
  if (config.mode === "manual") {
    // manual 模式由 UI 层直接调 manualSplit,这里不��走到
    return [];
  }

  // smart 模式
  try {
    const system = episodeSystemPrompt(transcript);
    const user = buildEpisodePrompt(transcript, config.targetMinSec, config.targetMaxSec);
    const raw = await chatEpisodeDetect(llm, system, user, signal);
    const breaks = parseBreaks(raw);
    return smartSplit(transcript, breaks, config);
  } catch {
    // LLM 失败,回退等时
    return fixedSplit(transcript, config);
  }
}
