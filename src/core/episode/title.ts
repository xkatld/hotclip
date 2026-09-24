import type { Transcript, TranscriptSegment, LlmConfig, EpisodeCandidate, EpisodeSplitConfig, EpisodeTitleResult } from "../../shared/api-types";
import { formatEpisodeNumber, applyTitleTemplate } from "./split";
import { isChineseTranscript } from "./prompt";
import { chatCompleteJson } from "../llm-transport";
import { extractJson } from "../highlight/prompt";

function sampleEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  if (count < 2) return items.slice(0, count);
  const step = (items.length - 1) / (count - 1);
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(items[Math.round(i * step)]);
  return out;
}

function cleanTitle(text: string): string {
  return text
    .replace(/[*_`#>]/g, "")
    .replace(/^[\s"'“”「」《》]+|[\s"'“”「」《》]+$/g, "")
    .replace(/^(?:标题|章节|title|chapter)\s*[:：]?\s*/i, "")
    .replace(/^第\s*\d+\s*集\s*[:：.、-]?\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 一条标题:id 缺失时按出现顺序配集号。 */
export interface TitleRow {
  id: number | null;
  title: string;
}

function toId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function rowsFromJson(content: string): TitleRow[] | null {
  let parsed: { titles?: unknown };
  try {
    parsed = JSON.parse(extractJson(content)) as { titles?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.titles)) return null;
  return parsed.titles.map((value) => {
    if (typeof value === "string") return { id: null, title: cleanTitle(value) };
    if (typeof value === "object" && value !== null) {
      const row = value as Record<string, unknown>;
      return {
        id: toId(row.id),
        title: typeof row.title === "string" ? cleanTitle(row.title) : "",
      };
    }
    return { id: null, title: "" };
  });
}

function rowsFromTable(content: string): TitleRow[] {
  const out: TitleRow[] = [];
  let titleCol = -1;
  let idCol = -1;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.includes("|")) continue;
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (cells.length < 2 || cells.every((cell) => cell === "" || /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")))) continue;
    if (titleCol < 0) {
      const found = cells.findIndex((cell) => /标题|章节|title|chapter/i.test(cell));
      if (found >= 0) {
        titleCol = found;
        idCol = cells.findIndex((cell) => /^(?:集|序号|id|no\.?|#)$/i.test(cell));
        continue;
      }
      const widest = cells.reduce((best, cell, i) => (cell.length > cells[best].length ? i : best), 0);
      if (cells[widest].length >= 4) {
        titleCol = widest;
        continue;
      }
      continue;
    }
    const value = cleanTitle(cells[titleCol]);
    if (value) out.push({ id: idCol >= 0 ? toId(cells[idCol]) : null, title: value });
  }
  return out;
}

function rowsFromList(content: string): TitleRow[] {
  const out: TitleRow[] = [];
  for (const line of content.split("\n")) {
    const match = line.trim().match(/^(?:\d+\s*[.、)]|[-*])\s*(.+)$/) ?? line.trim().match(/^第\s*\d+\s*集\s*[:：]?\s*(.+)$/);
    if (!match) continue;
    const value = cleanTitle(match[1]);
    if (value && value.length <= 40) out.push({ id: null, title: value });
  }
  return out;
}

/** 三级容错读标题:id 键控 JSON → Markdown 表格 → 编号列表。 */
export function parseTitleRows(content: string): TitleRow[] {
  const fromJson = rowsFromJson(content);
  if (fromJson) return fromJson;
  const fromTable = rowsFromTable(content);
  if (fromTable.length > 0) return fromTable;
  const fromList = rowsFromList(content);
  if (fromList.length > 0) return fromList;
  throw new Error(`模型未返回可识别的标题列表 / unreadable titles: ${content.slice(0, 200)}`);
}

function episodeSample(segments: TranscriptSegment[], ep: EpisodeCandidate): string {
  const inside = segments.filter((s) => s.startSec >= ep.startSec && s.endSec <= ep.endSec);
  const head = inside.slice(0, 3);
  const tail = inside.slice(-2);
  const middle = sampleEvenly(inside.slice(3, Math.max(3, inside.length - 2)), 8);
  const seen = new Set<number>();
  const lines: string[] = [];
  for (const seg of [...head, ...middle, ...tail]) {
    if (seen.has(seg.id)) continue;
    seen.add(seg.id);
    lines.push(seg.text.replace(/\s+/g, " ").trim());
  }
  return lines.join(" ").slice(0, 1200);
}

const TITLE_SYSTEM_ZH = `你是短视频系列的分集编辑。给你每一集的台词摘录,为每一集写一个可以直接当视频标题用的中文标题。

【要求】
1. 12-20 字,必须有具体信息:对象、工具、结论、数字,至少占一样
2. 句式像正经视频标题:可用「主题:亮点」或「主题｜亮点」,也可以是对比或疑问句
3. 用台词里真实出现的名词与术语,不要编造没提过的内容
4. 不要照抄台词原句,不要以 以及/然后/如果/好/那么/所以 这类口语词开头
5. 不要出现 第X集、序号、引号、书名号、Markdown 符号
6. 每集标题互不重复

【示例】
台词摘录: 今天讲 Cloudflare Workers 怎么绑定 KV 命名空间,再配置环境变量和 UUID 做登录访问
标题: Cloudflare Workers:KV 绑定与环境变量配置
台词摘录: 我把这次线上事故从头到尾复了一遍,根因是一个没加索引的查询
标题: 一次线上事故的完整复盘:一个没加索引的查询
台词摘录: 三种免费图床我都试了一遍,说下速度和稳定性
标题: 三种免费图床横评:速度和稳定性实测

【输出】只输出 JSON 本体,第一个字符是 {,最后一个字符是 },不要 Markdown 表格、不要代码块、不要任何解释
每个对象的 id 必须原样抄用输入里那一集的 id,顺序不限,一集一条不要多给
{"titles":[{"id":1,"title":"标题1"},{"id":2,"title":"标题2"}]}`;

const TITLE_SYSTEM_EN = `You are a video series editor. Given the transcript excerpt of each episode, write a title that could be published as-is.

【Rules】
1. 8-16 words with concrete specifics: an object, tool, conclusion or number
2. Shape it like a real video title: "Topic: Highlight" or "Topic | Highlight", a comparison, or a question
3. Use nouns and terms that actually appear in the transcript; never invent content
4. Do not copy a transcript line verbatim; do not start with and/so/well/now
5. No episode numbers, quotes, or Markdown symbols
6. Every title must be distinct

【Examples】
Excerpt: Cloudflare Workers KV namespace binding plus environment variables and a UUID for login
Title: Cloudflare Workers: KV Bindings and Environment Variables
Excerpt: Walking through a production incident whose root cause was one unindexed query
Title: Full Postmortem of a Production Incident: One Unindexed Query
Excerpt: I tried three free image hosts and compared their speed and stability
Title: Three Free Image Hosts Compared: Speed and Stability

【Output】Raw JSON only, first character {, last character }, no Markdown table, no code fence, no prose
Copy each episode's id verbatim from the input; any order, exactly one entry per episode
{"titles":[{"id":1,"title":"Title 1"},{"id":2,"title":"Title 2"}]}`;

async function generateTitlesViaLlm(
  transcript: Transcript,
  episodes: EpisodeCandidate[],
  llm: LlmConfig,
  signal?: AbortSignal
): Promise<TitleRow[]> {
  const zh = isChineseTranscript(transcript);
  const blocks = episodes.map((ep) => {
    const minutes = Math.max(1, Math.round(ep.durationSec / 60));
    const head = `[集 id=${ep.id}] 时长约 ${minutes} 分钟`;
    const reason = ep.reason ? `\n断点理由: ${ep.reason}` : "";
    return `${head}${reason}\n台词摘录: ${episodeSample(transcript.segments, ep)}`;
  });
  // 不传 temperature:思考型模型只接受 temperature=1,带 0.3 会被直接 HTTP 400 拒掉。
  return chatCompleteJson(llm, zh ? TITLE_SYSTEM_ZH : TITLE_SYSTEM_EN, blocks.join("\n\n"), parseTitleRows, signal, {
    rejectReasoningFallback: true,
  });
}

/**
 * 不合格标题的形状:成对引号是模型在转述台词,冒号后跟"应是/应统一/大概率"
 * 是把推理结论当标题写,超长则是整句照搬。这三种一律丢掉走 chapterTitle。
 */
const TITLE_QUOTED = /[“”"].+[“”"]|「.+」|《.+》/;
const TITLE_DELIBERATION = /[:：]\s*(?:应是|应统一|大概率)/;
const TITLE_MAX_CHARS = 30;

export function isBadTitle(title: string): boolean {
  if (!title) return true;
  if (title.length > TITLE_MAX_CHARS) return true;
  return TITLE_QUOTED.test(title) || TITLE_DELIBERATION.test(title);
}

/** 标题行 → 集 id;模型没给 id 时按出现顺序补,条数超标视为污染整批丢弃。 */
function mapTitlesById(rows: TitleRow[], episodes: EpisodeCandidate[]): Map<number, string> {
  const map = new Map<number, string>();
  if (rows.length > episodes.length) return map;
  const validIds = new Set(episodes.map((ep) => ep.id));
  rows.forEach((row, i) => {
    const id = row.id !== null && validIds.has(row.id) ? row.id : episodes[i]?.id;
    if (id === undefined || map.has(id)) return;
    if (isBadTitle(row.title)) return;
    map.set(id, row.title);
  });
  return map;
}

function fallbackTitle(transcript: Transcript, ep: EpisodeCandidate): string {
  const current = ep.title.trim();
  if (current && !/^第\s*\d+\s*集$/.test(current)) return current;
  const first = transcript.segments
    .find((s) => s.startSec >= ep.startSec && s.startSec < ep.endSec)
    ?.text.replace(/\s+/g, "")
    .trim() ?? "";
  if (!first) return `第 ${ep.id} 集`;
  const sentence = first.match(/^.{6,24}?[。！？!?]/);
  return sentence ? sentence[0].replace(/[。！？!?]$/, "") : first.slice(0, 24);
}

export async function enrichEpisodeTitles(
  transcript: Transcript,
  episodes: EpisodeCandidate[],
  config: EpisodeSplitConfig,
  llm?: LlmConfig,
  signal?: AbortSignal
): Promise<EpisodeTitleResult> {
  let rows: TitleRow[] = [];
  let titleWarning: string | undefined;
  if (llm) {
    try {
      rows = await generateTitlesViaLlm(transcript, episodes, llm, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      titleWarning = e instanceof Error ? e.message : String(e);
    }
  }

  const byId = mapTitlesById(rows, episodes);
  if (rows.length > episodes.length) {
    titleWarning = `模型返回了 ${rows.length} 条标题但只有 ${episodes.length} 集,已全部改用章节名。`;
  }

  const titled = episodes.map((ep) => {
    const rawTitle = byId.get(ep.id) ?? fallbackTitle(transcript, ep);
    const num = formatEpisodeNumber(ep.id, config.numberFormat, episodes.length);
    const fullTitle = config.titlePrefix
      ? applyTitleTemplate(config.titleTemplate, config.titlePrefix, num, rawTitle)
      : `${num} ${rawTitle}`;
    return { ...ep, title: fullTitle };
  });

  return { episodes: titled, titleWarning };
}
