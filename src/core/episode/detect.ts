import type { Transcript, LlmConfig, EpisodeCandidate, EpisodeSplitConfig } from "../../shared/api-types";
import { episodeSystemPrompt, buildWindowPrompt, isChineseTranscript } from "./prompt";
import { parseBreaks, smartSplit, fixedSplit, resolveTargetInterval, type RawBreak } from "./split";
import { chatCompleteJson } from "../llm-transport";

const WINDOW_SEC = 30 * 60;
const OVERLAP_SEC = 2 * 60;

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
  targetMinSec: number,
  targetMaxSec: number,
  zh: boolean,
  signal?: AbortSignal
): Promise<RawBreak[]> {
  const userPrompt = buildWindowPrompt(
    segments,
    windowStart,
    windowEnd,
    totalDurationSec,
    targetMinSec,
    targetMaxSec,
    zh
  );
  return chatCompleteJson(llm, systemPrompt, userPrompt, parseBreaks, signal, { temperature: 0.2 });
}

function mergeBreaks(allBreaks: RawBreak[]): RawBreak[] {
  const sorted = [...allBreaks].sort((a, b) => a.timeSec - b.timeSec);
  const merged: RawBreak[] = [];
  for (const b of sorted) {
    if (merged.length === 0 || b.timeSec - merged[merged.length - 1].timeSec >= 60) {
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

  for (let i = 0; i < windows.length; i++) {
    signal?.throwIfAborted();
    const w = windows[i];
    try {
      const breaks = await detectWindow(
        llm,
        systemPrompt,
        w.segments,
        w.startSec,
        w.endSec,
        transcript.durationSec,
        config.targetMinSec,
        config.targetMaxSec,
        zh,
        signal
      );
      allBreaks.push(...breaks);
    } catch (err) {
      if (signal?.aborted) throw err;
      const at = `${Math.round(w.startSec / 60)}-${Math.round(w.endSec / 60)} 分`;
      errors.push(`第 ${i + 1} 段 ${at}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
