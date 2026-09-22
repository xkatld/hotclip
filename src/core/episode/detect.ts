/**
 * 分集检测编排器:转写结果 → 分窗口 LLM 识别话题断点 → 合并 → 分集候选列表。
 *
 * 核心策略(与爆款检测不同):
 * 两小时视频的逐句稿可能有数千句,一次 LLM 请求会超 token 上限甚至 524。
 * 因此采用**滑动窗口**:按 ~30 分钟切块,每块独立调 LLM 找断点,最后合并去重。
 * 窗口之间有 2 分钟重叠区,确保边界处的话题切换不被遗漏。
 */
import type { Transcript, LlmConfig, EpisodeCandidate, EpisodeSplitConfig } from "../../shared/api-types";
import { episodeSystemPrompt, buildWindowPrompt, isChineseTranscript } from "./prompt";
import { parseBreaks, smartSplit, fixedSplit, type RawBreak } from "./split";
import { requestLlmText, llmRequestBudget } from "../llm-transport";
import { isLocalBaseUrl } from "../../shared/llm-preflight";
import { extraParams, thinkingParams, MAX_TOKENS } from "../highlight/detect";

/** 每个窗口约 30 分钟(秒)。 */
const WINDOW_SEC = 30 * 60;
/** 相邻窗口重叠 2 分钟,防止边界遗漏。 */
const OVERLAP_SEC = 2 * 60;

/** 把逐句稿按时间切成窗口。 */
function splitWindows(transcript: Transcript): { startSec: number; endSec: number; segments: typeof transcript.segments }[] {
  const totalSec = transcript.durationSec;
  if (totalSec <= 0) return [];
  const windows: { startSec: number; endSec: number; segments: typeof transcript.segments }[] = [];
  let cursor = 0;
  while (cursor < totalSec) {
    const winEnd = Math.min(cursor + WINDOW_SEC, totalSec);
    const segs = transcript.segments.filter((s) => s.startSec >= cursor && s.startSec < winEnd + OVERLAP_SEC);
    windows.push({ startSec: cursor, endSec: winEnd, segments: segs });
    cursor = winEnd;
  }
  return windows;
}

/** 对单个窗口调一次 LLM。 */
async function detectWindow(
  llm: LlmConfig,
  systemPrompt: string,
  windowSegs: Transcript['segments'],
  windowStart: number,
  windowEnd: number,
  totalDurationSec: number,
  targetMinSec: number,
  targetMaxSec: number,
  zh: boolean,
  signal?: AbortSignal
): Promise<RawBreak[]> {
  const url = `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const timeoutMs = isLocalBaseUrl(llm.baseUrl) ? 180_000 : 90_000;
  const budget = llmRequestBudget(timeoutMs);

  const userPrompt = buildWindowPrompt(
    windowSegs,
    windowStart,
    windowEnd,
    totalDurationSec,
    targetMinSec,
    targetMaxSec,
    zh
  );

  const res = await requestLlmText(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${llm.apiKey}`,
    },
    body: JSON.stringify({
      model: llm.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: MAX_TOKENS,
      ...extraParams(llm.baseUrl),
      ...thinkingParams(llm.model),
    }),
  }, { signal, budget });

  return parseBreaks(res.text);
}

/** 合并多个窗口的断点:去重(时间太近的合并)。 */
function mergeBreaks(allBreaks: RawBreak[]): RawBreak[] {
  const sorted = allBreaks.sort((a, b) => a.timeSec - b.timeSec);
  const merged: RawBreak[] = [];
  for (const b of sorted) {
    if (merged.length === 0 || b.timeSec - merged[merged.length - 1].timeSec >= 60) {
      merged.push(b);
    }
  }
  return merged;
}

/** 分集结果,附带回退信息。 */
export interface EpisodeDetectResult {
  episodes: EpisodeCandidate[];
  fallbackReason?: string;
}

/**
 * 智能分集:分窗口调 LLM → 合并断点 → 分集。
 * 单窗口失败不阻塞,只跳过;全部失败才回退等时。
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

  // smart 模式:分窗口
  const zh = isChineseTranscript(transcript);
  const systemPrompt = episodeSystemPrompt(transcript);
  const windows = splitWindows(transcript);

  // 短视频(≤35分钟)不分窗口,一次搞定
  if (windows.length <= 1) {
    try {
      const breaks = await detectWindow(
        llm, systemPrompt, transcript.segments,
        0, transcript.durationSec, transcript.durationSec,
        config.targetMinSec, config.targetMaxSec, zh, signal
      );
      if (breaks.length === 0) {
        return {
          episodes: fixedSplit(transcript, config),
          fallbackReason: "AI 未识别到话题断点,已自动按等时切割",
        };
      }
      return { episodes: smartSplit(transcript, breaks, config) };
    } catch (err) {
      return {
        episodes: fixedSplit(transcript, config),
        fallbackReason: `AI 调用失败,已按等时切割。原因: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 长视频:逐窗口调 LLM,收集所有断点
  const allBreaks: RawBreak[] = [];
  const errors: string[] = [];

  for (let i = 0; i < windows.length; i++) {
    signal?.throwIfAborted();
    const w = windows[i];
    try {
      const breaks = await detectWindow(
        llm, systemPrompt, w.segments,
        w.startSec, w.endSec, transcript.durationSec,
        config.targetMinSec, config.targetMaxSec, zh, signal
      );
      allBreaks.push(...breaks);
    } catch (err) {
      errors.push(`窗口${i + 1}(${Math.round(w.startSec / 60)}-${Math.round(w.endSec / 60)}分): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (allBreaks.length === 0) {
    // 所有窗口都失败了
    return {
      episodes: fixedSplit(transcript, config),
      fallbackReason: errors.length > 0
        ? `AI 全部窗口失败,已按等时切割。错误: ${errors[0]}`
        : "AI 未识别到话题断点,已自动按等时切割",
    };
  }

  const merged = mergeBreaks(allBreaks);
  const episodes = smartSplit(transcript, merged, config);

  return {
    episodes,
    // 部分窗口失败时提示
    fallbackReason: errors.length > 0
      ? `${windows.length} 个窗口中 ${errors.length} 个AI调用失败,结果可能不完整`
      : undefined,
  };
}
