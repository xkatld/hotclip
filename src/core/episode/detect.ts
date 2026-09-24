import type { Transcript, LlmConfig, EpisodeCandidate, EpisodeSplitConfig } from "../../shared/api-types";
import { episodeSystemPrompt, buildWindowPrompt, isChineseTranscript } from "./prompt";
import { parseBreaks, smartSplit, fixedSplit, resolveTargetInterval, type RawBreak } from "./split";
import { chatCompleteJson, LlmReasoningOnlyError } from "../llm-transport";

/**
 * 窗口只是为了不把两小时逐句稿一次性塞进上下文,不是分集单位。
 * 加大到 45 分钟让模型在更长的语境里判断话题走向;5 分钟重叠保证
 * 骑在窗口边界上的切换点至少被一侧完整看到。
 */
const WINDOW_SEC = 45 * 60;
const OVERLAP_SEC = 5 * 60;
/** 窗口之间并行;上限只是防跑飞,常见素材(6 小时 = 8 窗口)等同于全并行。 */
const WINDOW_CONCURRENCY = 16;

interface WindowSegment {
  id: number;
  startSec: number;
  endSec: number;
  text: string;
}

interface Window {
  startSec: number;
  endSec: number;
  segments: WindowSegment[];
}

/** 逐句稿带上全片序号:模型回填的 segmentId 必须能对回原片,不能用窗口内下标。 */
function indexSegments(transcript: Transcript): WindowSegment[] {
  return transcript.segments.map((s, i) => ({
    id: Number.isFinite(s.id) ? s.id : i,
    startSec: s.startSec,
    endSec: s.endSec,
    text: s.text,
  }));
}

function splitWindows(transcript: Transcript): Window[] {
  const totalSec = transcript.durationSec;
  if (totalSec <= 0) return [];
  const indexed = indexSegments(transcript);
  const windows: Window[] = [];
  let cursor = 0;
  while (cursor < totalSec) {
    const winEnd = Math.min(cursor + WINDOW_SEC, totalSec);
    windows.push({
      startSec: cursor,
      endSec: winEnd,
      segments: indexed.filter((s) => s.startSec >= cursor && s.startSec < winEnd + OVERLAP_SEC),
    });
    cursor = winEnd;
  }
  return windows;
}

async function detectWindow(
  llm: LlmConfig,
  systemPrompt: string,
  segments: WindowSegment[],
  windowStart: number,
  windowEnd: number,
  totalDurationSec: number,
  zh: boolean,
  signal?: AbortSignal
): Promise<RawBreak[]> {
  const userPrompt = buildWindowPrompt(segments, windowStart, windowEnd, totalDurationSec, zh);
  // 不传 temperature:这一层的模型很多是思考型,只接受 temperature=1,带 0.2 会被直接 HTTP 400 拒掉。
  return chatCompleteJson(llm, systemPrompt, userPrompt, parseBreaks, signal, {
    rejectReasoningFallback: true,
  });
}

/** 有上限的并发执行,结果按输入顺序返回,单个失败不拖垮其他窗口。 */
async function runWithLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * 只去掉重叠区里同一个切换点被两侧窗口各报一次的重复,不做密度筛选。
 * 全局选点要的是尽量全的候选池,这里删掉的每个点 DP 都再也看不到。
 */
const DUPLICATE_GAP_SEC = 20;

function mergeBreaks(allBreaks: RawBreak[]): RawBreak[] {
  const sorted = [...allBreaks].sort((a, b) => a.timeSec - b.timeSec);
  const merged: RawBreak[] = [];
  for (const b of sorted) {
    if (merged.length === 0 || b.timeSec - merged[merged.length - 1].timeSec >= DUPLICATE_GAP_SEC) {
      merged.push(b);
    }
  }
  return merged;
}

export interface EpisodeDetectResult {
  episodes: EpisodeCandidate[];
  fallbackReason?: string;
}

export async function detectEpisodes(
  transcript: Transcript,
  llm: LlmConfig,
  config: EpisodeSplitConfig,
  signal?: AbortSignal
): Promise<EpisodeDetectResult> {
  if (config.mode === "fixed") return { episodes: fixedSplit(transcript, config) };
  if (config.mode === "manual") return { episodes: [] };

  const fallbackInterval = resolveTargetInterval(config);
  const fallback = (reason: string): EpisodeDetectResult => ({
    episodes: fixedSplit(transcript, config, fallbackInterval),
    fallbackReason: reason,
  });

  if (transcript.durationSec <= 0 || transcript.segments.length === 0) {
    return fallback("逐句稿为空,无法识别话题断点,已按目标时长范围自动切割");
  }

  const zh = isChineseTranscript(transcript);
  const systemPrompt = episodeSystemPrompt(transcript);
  const windows = splitWindows(transcript);
  if (windows.length === 0) {
    return fallback("逐句稿为空,无法识别话题断点,已按目标时长范围自动切割");
  }

  const allBreaks: RawBreak[] = [];
  const errors: string[] = [];
  let reasoningOnly = 0;

  const settled = await runWithLimit(windows, WINDOW_CONCURRENCY, (w) =>
    detectWindow(llm, systemPrompt, w.segments, w.startSec, w.endSec, transcript.durationSec, zh, signal));

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      allBreaks.push(...outcome.value);
      continue;
    }
    signal?.throwIfAborted();
    if (outcome.reason instanceof LlmReasoningOnlyError) reasoningOnly++;
    const w = windows[i];
    const at = `${Math.round(w.startSec / 60)}-${Math.round(w.endSec / 60)} 分`;
    errors.push(`第 ${i + 1} 段 ${at}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
  }

  // 一个窗口吐不出正文不代表这个模型没救:别的窗口照样能给候选点。
  // 只有全部窗口都栽在同一个原因上,才值得打断任务让用户换模型。
  if (reasoningOnly === windows.length) throw new LlmReasoningOnlyError();

  if (errors.length === windows.length) {
    return fallback(`AI 调用失败,已按目标时长范围自动切割。原因: ${errors[0]}`);
  }

  const merged = mergeBreaks(allBreaks);
  if (merged.length === 0) {
    return fallback("AI 判断整段内容是同一个话题,没有可用的章节断点,已按目标时长范围自动切割");
  }

  return {
    episodes: smartSplit(transcript, merged, config),
    fallbackReason: errors.length > 0
      ? `${windows.length} 段中有 ${errors.length} 段 AI 调用失败,结果可能不完整: ${errors[0]}`
      : undefined,
  };
}
