/**
 * 分集切割逻辑:三种模式把逐句稿切成多集,纯函数可单测。
 *  - smart:  LLM 返回的断点列表 → 集
 *  - fixed:  按固定间隔均分,对齐到最近句子边界
 *  - manual: 用户手动给的断点列表 → 集
 */
import type { Transcript, EpisodeCandidate, EpisodeSplitConfig, EpisodeNumberFormat } from "../../shared/api-types";
import { unwrapLlmBody } from "../llm-transport";

/** LLM 返回的原始断点。 */
export interface RawBreak {
  segmentId: number;
  timeSec: number;
  reason: string;
  chapterTitle: string;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function cleanCell(text: string): string {
  return text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
}

/** 单元格里读时间:MM:SS / HH:MM:SS / 纯秒数,允许加粗与「秒」后缀。 */
export function parseClock(text: string): number | null {
  const clean = cleanCell(text);
  const clock = clean.match(/(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?/);
  if (clock) {
    const first = Number(clock[1]);
    const second = Number(clock[2]);
    const third = clock[3] === undefined ? null : Number(clock[3]);
    return third === null ? first * 60 + second : first * 3600 + second * 60 + third;
  }
  const plain = clean.match(/^(\d+(?:\.\d+)?)\s*(?:s|秒)?$/i);
  return plain ? Number(plain[1]) : null;
}

function parseSegmentId(text: string): number {
  const match = text.match(/第\s*(\d+)\s*句/);
  return match ? Number(match[1]) : 0;
}

function sortBreaks(rows: RawBreak[]): RawBreak[] {
  return rows.sort((a, b) => a.timeSec - b.timeSec);
}

function breaksFromJson(body: string): RawBreak[] | null {
  const match = body.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: { breaks?: unknown };
  try {
    parsed = JSON.parse(match[0]) as { breaks?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.breaks)) return null;
  const out: RawBreak[] = [];
  for (const item of parsed.breaks) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const timeSec = toFiniteNumber(row.timeSec);
    if (timeSec === null) continue;
    out.push({
      segmentId: toFiniteNumber(row.segmentId) ?? 0,
      timeSec,
      reason: typeof row.reason === "string" ? cleanCell(row.reason) : "",
      chapterTitle: typeof row.chapterTitle === "string" ? cleanCell(row.chapterTitle) : "",
    });
  }
  return sortBreaks(out);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  return trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cleanCell);
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => cell === "" || /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")));
}

const TIME_HEADER = /时间|time|timestamp/i;
const REASON_HEADER = /说明|理由|依据|reason|why|note/i;
const TITLE_HEADER = /标题|章节|chapter|title/i;
const ID_HEADER = /位置|句号|句|segment|sentence/i;

/** 模型爱用 Markdown 表格回答,按表头定位列把行读成断点。 */
export function breaksFromTable(body: string): RawBreak[] {
  const out: RawBreak[] = [];
  let timeCol = -1;
  let reasonCol = -1;
  let titleCol = -1;
  let idCol = -1;
  for (const line of body.split("\n")) {
    const cells = splitTableRow(line);
    if (cells.length < 2 || isSeparatorRow(cells)) continue;
    if (timeCol < 0 && cells.some((cell) => TIME_HEADER.test(cell)) && cells.some((cell) => REASON_HEADER.test(cell) || TITLE_HEADER.test(cell) || ID_HEADER.test(cell))) {
      timeCol = cells.findIndex((cell) => TIME_HEADER.test(cell));
      reasonCol = cells.findIndex((cell) => REASON_HEADER.test(cell));
      titleCol = cells.findIndex((cell) => TITLE_HEADER.test(cell));
      idCol = cells.findIndex((cell) => ID_HEADER.test(cell));
      continue;
    }
    const at = timeCol >= 0 ? timeCol : cells.findIndex((cell) => parseClock(cell) !== null);
    const timeSec = at >= 0 ? parseClock(cells[at]) : null;
    if (timeSec === null) continue;
    const idCell = idCol >= 0 ? cells[idCol] : cells.find((cell) => /第\s*\d+\s*句/.test(cell)) ?? "";
    out.push({
      segmentId: parseSegmentId(idCell),
      timeSec,
      reason: reasonCol >= 0 ? cells[reasonCol] : "",
      chapterTitle: titleCol >= 0 ? cells[titleCol] : "",
    });
  }
  return sortBreaks(out);
}

function breaksFromLooseText(body: string): RawBreak[] {
  const out: RawBreak[] = [];
  for (const line of body.split("\n")) {
    if (splitTableRow(line).length >= 2) continue;
    const timeSec = parseClock(line);
    if (timeSec === null) continue;
    const reason = cleanCell(line)
      .replace(/\d{1,3}:\d{1,2}(?::\d{1,2})?/, "")
      .replace(/第\s*\d+\s*句[^\s,，。]*/g, "")
      .replace(/[\\/·—～~-]{1,}/g, " ")
      .trim();
    out.push({ segmentId: parseSegmentId(line), timeSec, reason: reason.slice(0, 60), chapterTitle: "" });
  }
  return sortBreaks(out);
}

/**
 * 从模型正文里提取断点列表,三级容错:JSON → Markdown 表格 → 松散时间戳行。
 * 模型经常无视「严格 JSON」改吐表格,而表格里的断点位置、句号、理由一样不少,
 * 只认 JSON 等于把正确答案扔掉。三级都读不出才抛错,交给 chatCompleteJson 重发。
 */
export function parseBreaks(raw: string): RawBreak[] {
  const body = unwrapLlmBody(raw);
  const fromJson = breaksFromJson(body);
  if (fromJson) return fromJson;
  const fromTable = breaksFromTable(body);
  if (fromTable.length > 0) return fromTable;
  const fromLoose = breaksFromLooseText(body);
  if (fromLoose.length > 0) return fromLoose;
  throw new Error(`模型未返回可识别的断点列表 / unreadable breaks: ${body.slice(0, 200)}`);
}

/**
 * 把断点时间对齐到最近的句子边界(句末时刻),避免把一句话切成两半。
 * 在 ±toleranceSec 范围内找最近的句子结束时间。
 */
export function snapToSentenceBoundary(timeSec: number, transcript: Transcript, toleranceSec = 5): number {
  let best = timeSec;
  let bestDist = Infinity;
  for (const seg of transcript.segments) {
    const dist = Math.abs(seg.endSec - timeSec);
    if (dist < bestDist && dist <= toleranceSec) {
      best = seg.endSec;
      bestDist = dist;
    }
  }
  return best;
}

/** 智能分集:LLM 断点 → 集列表。断点不足时回退到等时。 */
export function smartSplit(
  transcript: Transcript,
  breaks: RawBreak[],
  config: EpisodeSplitConfig
): EpisodeCandidate[] {
  const totalSec = transcript.durationSec;
  if (totalSec <= 0) return [];

  // 对齐断点到句子边界
  const snapped = breaks
    .map((b) => ({ ...b, timeSec: snapToSentenceBoundary(b.timeSec, transcript) }))
    .filter((b) => b.timeSec > 0 && b.timeSec < totalSec - 10); // 去掉开头和接近结尾的

  // 去重(太近的合并)
  const MIN_GAP = 30;
  const deduped: RawBreak[] = [];
  for (const b of snapped) {
    if (deduped.length === 0 || b.timeSec - deduped[deduped.length - 1].timeSec >= MIN_GAP) {
      deduped.push(b);
    }
  }

  if (deduped.length === 0) {
    // LLM 没找到断点,回退等时;间隔取用户设的目标范围中点,不用等时模式的独立间隔
    return fixedSplit(transcript, config, resolveTargetInterval(config));
  }

  const episodes: EpisodeCandidate[] = [];
  let prevSec = 0;

  for (let i = 0; i < deduped.length; i++) {
    const bp = deduped[i];
    episodes.push({
      id: episodes.length + 1,
      title: bp.chapterTitle || `第 ${episodes.length + 1} 集`,
      startSec: prevSec,
      endSec: bp.timeSec,
      durationSec: Math.round(bp.timeSec - prevSec),
      reason: bp.reason,
    });
    prevSec = bp.timeSec;
  }

  // 最后一集
  if (totalSec - prevSec > 10) {
    episodes.push({
      id: episodes.length + 1,
      title: `第 ${episodes.length + 1} 集`,
      startSec: prevSec,
      endSec: totalSec,
      durationSec: Math.round(totalSec - prevSec),
      reason: "",
    });
  }

  return episodes;
}

/**
 * 智能分集回退时用的间隔:取用户设的目标时长范围中点,而不是等时模式的
 * 独立 fixedIntervalSec(那个值在智能模式下输入框是隐藏的,默认 15 分钟,
 * 与用户在智能模式实际填的目标范围毫无关系——这就是"调了范围也不生效"的根因)。
 */
export function resolveTargetInterval(config: EpisodeSplitConfig): number {
  const lo = config.targetMinSec > 0 ? config.targetMinSec : 600;
  const hi = config.targetMaxSec > lo ? config.targetMaxSec : lo + 600;
  return Math.round((lo + hi) / 2);
}

/** 等时分集:按固定间隔切割,在最近句子边界微调。intervalSecOverride 优先于 config.fixedIntervalSec。 */
export function fixedSplit(transcript: Transcript, config: EpisodeSplitConfig, intervalSecOverride?: number): EpisodeCandidate[] {
  const totalSec = transcript.durationSec;
  const interval = intervalSecOverride ?? config.fixedIntervalSec ?? 900;
  if (totalSec <= 0 || interval <= 0) return [];

  const episodes: EpisodeCandidate[] = [];
  let prevSec = 0;

  while (prevSec < totalSec - 10) {
    let endSec = prevSec + interval;
    if (totalSec - endSec < config.targetMinSec) {
      // 剩余不足一集最短时长,并入末集
      endSec = totalSec;
    } else {
      endSec = snapToSentenceBoundary(endSec, transcript, 10);
    }
    episodes.push({
      id: episodes.length + 1,
      title: `第 ${episodes.length + 1} 集`,
      startSec: prevSec,
      endSec,
      durationSec: Math.round(endSec - prevSec),
      reason: "",
    });
    prevSec = endSec;
  }

  return episodes;
}

/** 手动分集:用户给的断点秒数 → 集列表。 */
export function manualSplit(transcript: Transcript, breakpoints: number[]): EpisodeCandidate[] {
  const totalSec = transcript.durationSec;
  if (totalSec <= 0) return [];

  const sorted = [...new Set(breakpoints)]
    .map((t) => snapToSentenceBoundary(t, transcript))
    .filter((t) => t > 0 && t < totalSec - 10)
    .sort((a, b) => a - b);

  const episodes: EpisodeCandidate[] = [];
  let prevSec = 0;

  for (const bp of sorted) {
    episodes.push({
      id: episodes.length + 1,
      title: `第 ${episodes.length + 1} 集`,
      startSec: prevSec,
      endSec: bp,
      durationSec: Math.round(bp - prevSec),
      reason: "",
    });
    prevSec = bp;
  }

  if (totalSec - prevSec > 10) {
    episodes.push({
      id: episodes.length + 1,
      title: `第 ${episodes.length + 1} 集`,
      startSec: prevSec,
      endSec: totalSec,
      durationSec: Math.round(totalSec - prevSec),
      reason: "",
    });
  }

  return episodes;
}

/** 格式化集号。 */
export function formatEpisodeNumber(n: number, format: EpisodeNumberFormat, total: number): string {
  switch (format) {
    case "P{n}": return `P${n}`;
    case "第{n}集": return `第${n}集`;
    case "{nn}": return String(n).padStart(String(total).length, "0");
    case "{n}": default: return String(n);
  }
}

/** 应用标题模板。 */
export function applyTitleTemplate(
  template: string,
  prefix: string,
  number: string,
  title: string
): string {
  return template
    .replace("{prefix}", prefix)
    .replace("{number}", number)
    .replace("{title}", title)
    .replace(/【】/g, "").replace(/\[\]/g, "").replace(/^\s+/, ""); // 前缀为空时清理空括号对
}
