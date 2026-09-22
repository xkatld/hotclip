/**
 * 分集标题生成:LLM 根据每集的逐句稿内容批量生成标题。
 * 也支持纯模板模式(不调 LLM,只用序号 + 用户前缀)。
 */
import type { Transcript, LlmConfig, EpisodeCandidate, EpisodeSplitConfig, EpisodeNumberFormat } from "../../shared/api-types";
import { formatEpisodeNumber, applyTitleTemplate } from "./split";
import { isChineseTranscript } from "./prompt";
import { requestLlmText, llmRequestBudget } from "../llm-transport";
import { isLocalBaseUrl } from "../../shared/llm-preflight";
import { extraParams, thinkingParams } from "../highlight/detect";

/** 为��集生成摘要标题(批量一次 LLM 调用)。 */
async function generateTitlesViaLlm(
  transcript: Transcript,
  episodes: EpisodeCandidate[],
  llm: LlmConfig,
  signal?: AbortSignal
): Promise<string[]> {
  const zh = isChineseTranscript(transcript);
  const segs = transcript.segments;

  const blocks = episodes.map((ep) => {
    const epSegs = segs.filter((s) => s.startSec >= ep.startSec && s.endSec <= ep.endSec);
    // 取前 8 句 + 后 4 句作为摘要依据
    const sample = [...epSegs.slice(0, 8), ...epSegs.slice(-4)].map((s) => s.text).join(" ");
    return `[集 ${ep.id}] ${sample.slice(0, 500)}`;
  });

  const system = zh
    ? "你是视频分集编辑。为每集生成一个简洁的章节标题（不超过15字,概括核心内容,不要序号）。输出严格 JSON: {\"titles\":[\"标题1\",\"标题2\",...]}"
    : "You are a video episode editor. Generate a concise chapter title for each episode (≤10 words, summarize core content, no numbering). Output strict JSON: {\"titles\":[\"Title 1\",\"Title 2\",...]}";

  const user = blocks.join("\n\n");

  const url = `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const timeout = isLocalBaseUrl(llm.baseUrl) ? 120_000 : 60_000;
  const budget = llmRequestBudget(1);

  const res = await requestLlmText(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.apiKey}` },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
      max_tokens: 2000,
      ...extraParams(llm.baseUrl),
      ...thinkingParams(llm.model),
    }),
  }, { signal, budget, timeoutMs: timeout });

  try {
    const match = res.text.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const obj = JSON.parse(match[0]);
    if (Array.isArray(obj.titles)) return obj.titles.map((t: unknown) => (typeof t === "string" ? t : ""));
    return [];
  } catch {
    return [];
  }
}

/**
 * 为分集候选列表填充完整标题:先尝试 LLM 生成,失败用默认标题。
 * 返回带有格式化标题的新列表(不修改原数组)。
 */
export async function enrichEpisodeTitles(
  transcript: Transcript,
  episodes: EpisodeCandidate[],
  config: EpisodeSplitConfig,
  llm?: LlmConfig,
  signal?: AbortSignal
): Promise<EpisodeCandidate[]> {
  // 尝试用 LLM 生成标题
  let aiTitles: string[] = [];
  if (llm) {
    try {
      aiTitles = await generateTitlesViaLlm(transcript, episodes, llm, signal);
    } catch {
      // fail-open: 用既有标题
    }
  }

  return episodes.map((ep, i) => {
    const rawTitle = aiTitles[i] || ep.title || `第 ${ep.id} 集`;
    const num = formatEpisodeNumber(ep.id, config.numberFormat, episodes.length);
    const fullTitle = config.titlePrefix
      ? applyTitleTemplate(config.titleTemplate, config.titlePrefix, num, rawTitle)
      : `${num} ${rawTitle}`;
    return { ...ep, title: fullTitle };
  });
}
