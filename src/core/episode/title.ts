import type { Transcript, LlmConfig, EpisodeCandidate, EpisodeSplitConfig } from "../../shared/api-types";
import { formatEpisodeNumber, applyTitleTemplate } from "./split";
import { isChineseTranscript } from "./prompt";
import { requestLlmText, llmRequestBudget } from "../llm-transport";
import { isLocalBaseUrl } from "../../shared/llm-preflight";
import { extraParams, thinkingParams } from "../highlight/detect";

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
    const sample = [...epSegs.slice(0, 8), ...epSegs.slice(-4)].map((s) => s.text).join(" ");
    return `[集 ${ep.id}] ${sample.slice(0, 500)}`;
  });

  const system = zh
    ? "你是视频分集编辑。为每集生成一个简洁的章节标题（不超过15字,概括核心内容,不要序号）。输出严格 JSON: {\"titles\":[\"标题1\",\"标题2\",...]}"
    : "You are a video episode editor. Generate a concise chapter title for each episode (≤10 words, summarize core content, no numbering). Output strict JSON: {\"titles\":[\"Title 1\",\"Title 2\",...]}";

  const user = blocks.join("\n\n");

  const url = `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const timeoutMs = isLocalBaseUrl(llm.baseUrl) ? 120_000 : 60_000;
  const budget = llmRequestBudget(timeoutMs);

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
  }, { signal, budget });

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

export async function enrichEpisodeTitles(
  transcript: Transcript,
  episodes: EpisodeCandidate[],
  config: EpisodeSplitConfig,
  llm?: LlmConfig,
  signal?: AbortSignal
): Promise<EpisodeCandidate[]> {
  let aiTitles: string[] = [];
  if (llm) {
    try {
      aiTitles = await generateTitlesViaLlm(transcript, episodes, llm, signal);
    } catch {
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
