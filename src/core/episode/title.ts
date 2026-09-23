import type { Transcript, LlmConfig, EpisodeCandidate, EpisodeSplitConfig } from "../../shared/api-types";
import { formatEpisodeNumber, applyTitleTemplate } from "./split";
import { isChineseTranscript } from "./prompt";
import { chatCompleteJson } from "../llm-transport";
import { extractJson } from "../highlight/prompt";

function sampleEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const step = (items.length - 1) / (count - 1);
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(items[Math.round(i * step)]);
  return out;
}

function parseTitles(content: string): string[] {
  let parsed: { titles?: unknown };
  try {
    parsed = JSON.parse(extractJson(content)) as { titles?: unknown };
  } catch {
    throw new Error(`模型返回的标题列表不是合法 JSON / invalid JSON: ${content.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed.titles)) throw new Error("模型输出缺少 titles 数组 / missing titles array");
  return parsed.titles.map((t) => (typeof t === "string" ? t.trim() : ""));
}

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
    const sample = sampleEvenly(epSegs, 12).map((s) => s.text).join(" ");
    const head = `[集 ${ep.id}] ${Math.round(ep.startSec / 60)}-${Math.round(ep.endSec / 60)} 分`;
    const reason = ep.reason ? `\n断点理由: ${ep.reason}` : "";
    return `${head}${reason}\n${sample.slice(0, 900)}`;
  });

  const system = zh
    ? "你是视频分集编辑。为每集生成一个简洁的章节标题,不超过15字,概括核心内容,不要序号,不要引号。只输出 JSON 本体,不要代码块,不要任何解释。输出格式: {\"titles\":[\"标题1\",\"标题2\"]}"
    : "You are a video episode editor. Generate a concise chapter title for each episode, at most 10 words, summarizing the core content, no numbering, no quotes. Output raw JSON only, no code fence, no prose. Format: {\"titles\":[\"Title 1\",\"Title 2\"]}";

  return chatCompleteJson(llm, system, blocks.join("\n\n"), parseTitles, signal);
}

function fallbackTitle(transcript: Transcript, ep: EpisodeCandidate): string {
  const current = ep.title.trim();
  if (current && !/^第\s*\d+\s*集$/.test(current)) return current;
  const first = transcript.segments.find((s) => s.startSec >= ep.startSec && s.startSec < ep.endSec);
  const text = first?.text.replace(/\s+/g, "").trim() ?? "";
  return text ? text.slice(0, 16) : `第 ${ep.id} 集`;
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
      aiTitles = [];
    }
  }

  return episodes.map((ep, i) => {
    const rawTitle = aiTitles[i]?.trim() || fallbackTitle(transcript, ep);
    const num = formatEpisodeNumber(ep.id, config.numberFormat, episodes.length);
    const fullTitle = config.titlePrefix
      ? applyTitleTemplate(config.titleTemplate, config.titlePrefix, num, rawTitle)
      : `${num} ${rawTitle}`;
    return { ...ep, title: fullTitle };
  });
}
