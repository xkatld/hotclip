/**
 * 分集切割逻辑:三种模式把逐句稿切成多集,纯函数可单测。
 *  - smart:  LLM 候选断点 → 全局选点(DP) → 时长硬约束后处理 → 集
 *  - fixed:  按固定间隔均分,对齐到最近句子边界
 *  - manual: 用户手动给的断点列表 → 集
 *
 * LLM 只负责"哪里有话题切换",时长归算法管:模型看不到全片,让它兼顾时长
 * 只会得到一堆带权衡过程的断点,且没有任何一集真的落在目标范围内。
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

/** 模型写句号的两种形状:提示词里的 [30],和它自己爱写的「第 30 句」。 */
function parseSegmentId(text: string): number {
  const cn = text.match(/第\s*(\d+)\s*句/);
  if (cn) return Number(cn[1]);
  const bracket = text.match(/\[\s*(\d+)\s*\]/);
  if (bracket) return Number(bracket[1]);
  const bare = cleanCell(text).match(/^(\d+)$/);
  return bare ? Number(bare[1]) : 0;
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
/** 实测模型的表头几乎不写「标题/章节」,写的是「切换内容」「切换到」「新话题」「进入话题」。 */
const TITLE_HEADER = /标题|章节|切换内容|切换到|切换点|新话题|进入话题|主题|话题切换|chapter|title|topic/i;
const ID_HEADER = /位置|句号|句编号|行号|序号|句|segment|sentence/i;

/** 表里没有单独的理由列时,拿最长的那个文字单元格当理由:总比留空强。 */
function widestTextCell(cells: string[], exclude: number[]): string {
  let best = "";
  for (let i = 0; i < cells.length; i++) {
    if (exclude.includes(i)) continue;
    if (parseClock(cells[i]) !== null) continue;
    if (cells[i].length > best.length) best = cells[i];
  }
  return best.length >= 4 ? best : "";
}

/**
 * 模型描述切换几乎都写成「从 A 切换到 B」「A → B」,整句当章节名又长又是在讲上一集。
 * 有箭头就只取右边那一段;本来就是干净标题的原样返回;太长的返回空让上层回退。
 */
export function titleFromTransition(text: string): string {
  const clean = cleanCell(text);
  if (!clean) return "";
  const parts = clean.split(/→|->|—>|切换到|转入|进入|变为/);
  const picked = parts[parts.length - 1]
    .replace(/\[\s*\d+\s*\]/g, "")
    .replace(/第\s*\d+\s*句/g, "")
    .trim()
    .replace(/^[「『"“]+|[」』"”]+$/g, "")
    .trim();
  // 实测 glm 会把句号列当标题列写成「[50]」;纯数字/纯符号不是章节名,让上层回退。
  if (!/[\p{L}\p{N}]/u.test(picked) || /^[\d\s.、)]+$/.test(picked)) return "";
  return picked.length <= 24 ? picked : "";
}

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
      if (titleCol === reasonCol) titleCol = -1;
      continue;
    }
    const at = timeCol >= 0 ? timeCol : cells.findIndex((cell) => parseClock(cell) !== null);
    const timeSec = at >= 0 ? parseClock(cells[at]) : null;
    if (timeSec === null) continue;
    const idCell = idCol >= 0 ? cells[idCol] : cells.find((cell) => /第\s*\d+\s*句|^\s*\[\s*\d+\s*\]\s*$/.test(cell)) ?? "";
    const rawTitle = titleCol >= 0 ? cells[titleCol] : "";
    const reason = reasonCol >= 0 ? cells[reasonCol] : widestTextCell(cells, [at, idCol, titleCol]);
    out.push({
      segmentId: parseSegmentId(idCell),
      timeSec,
      reason,
      chapterTitle: titleFromTransition(rawTitle) || titleFromTransition(reason),
    });
  }
  return sortBreaks(out);
}

/** 模型爱在列表末尾补一句「[18] 04:52 是结尾总结,不算切换点」——那是反例,不是断点。 */
const NEGATED_LINE = /不算|不是|不属于|不视为|排除|除外|无需|忽略|not a |exclude/i;

function breaksFromLooseText(body: string): RawBreak[] {
  const out: RawBreak[] = [];
  for (const line of body.split("\n")) {
    if (splitTableRow(line).length >= 2) continue;
    if (NEGATED_LINE.test(line)) continue;
    const timeSec = parseClock(line);
    if (timeSec === null) continue;
    const reason = cleanCell(line)
      .replace(/\d{1,3}:\d{1,2}(?::\d{1,2})?/, "")
      .replace(/第\s*\d+\s*句[^\s,，。]*/g, "")
      .replace(/^\s*\d+\s*[.、)]\s*/, "")
      .replace(/\[\s*\d+\s*\]/g, "")
      .replace(/[\\/·—～~-]{1,}/g, " ")
      .replace(/^[\s:：,，]+/, "")
      .trim();
    out.push({ segmentId: parseSegmentId(line), timeSec, reason: reason.slice(0, 60), chapterTitle: titleFromTransition(reason) });
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

/** 目标时长区间:非法配置回落到 10~20 分钟,ideal 是 DP 的靠拢目标。 */
export interface TargetRange { min: number; max: number; ideal: number }
export function targetRange(config: EpisodeSplitConfig): TargetRange {
  const min = config.targetMinSec > 0 ? config.targetMinSec : 600;
  const max = config.targetMaxSec > min ? config.targetMaxSec : min + 600;
  return { min, max, ideal: (min + max) / 2 };
}

/**
 * 越界不是"不可行"而是"很贵":候选断点稀疏时硬可行性判断会直接无解,
 * 软罚分保证任何输入都能选出一组点,残留的越界交给 enforceDuration 收拾。
 */
const OUT_OF_RANGE_PENALTY = 1000;

function gapCost(gap: number, range: TargetRange): number {
  if (gap >= range.min && gap <= range.max) return Math.abs(gap - range.ideal) / range.ideal;
  const overflow = gap > range.max ? gap - range.max : range.min - gap;
  return OUT_OF_RANGE_PENALTY + overflow / range.ideal;
}

/**
 * 全局选点:从候选断点里挑一个子集,使每一集的长度尽量落在 [min,max]。
 * O(m²) DP,m 是候选数;候选过密时按"距理想长度最近"取舍,过疏时留给后处理补切。
 */
export function selectBreaksGlobal(candidates: RawBreak[], totalSec: number, range: TargetRange): RawBreak[] {
  if (candidates.length === 0 || totalSec <= 0) return [];
  const points = [0, ...candidates.map((c) => c.timeSec), totalSec];
  const n = points.length;
  const dp = new Array<number>(n).fill(Infinity);
  const from = new Array<number>(n).fill(-1);
  dp[0] = 0;
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (!Number.isFinite(dp[j])) continue;
      const cost = dp[j] + gapCost(points[i] - points[j], range);
      if (cost < dp[i]) {
        dp[i] = cost;
        from[i] = j;
      }
    }
  }
  const picked: RawBreak[] = [];
  for (let i = from[n - 1]; i > 0; i = from[i]) picked.push(candidates[i - 1]);
  return picked.reverse();
}

/** 模型爱在 reason 里写推演过程,这些句子对用户没有信息量,整句剔除。 */
const REASON_NOISE = /建议|推荐|若|如果|符合|应当|应该|大概率|考虑到|suggest|recommend|should|fits/i;
const REASON_MAX_CHARS = 40;

export function cleanReason(text: string): string {
  const clauses = text.split(/[。；;.!?！？]/).map((s) => s.trim()).filter(Boolean);
  const kept = clauses.filter((c) => !REASON_NOISE.test(c));
  return kept.join(";").slice(0, REASON_MAX_CHARS);
}

function makeEpisode(id: number, startSec: number, endSec: number, title: string, reason: string): EpisodeCandidate {
  return { id, title, startSec, endSec, durationSec: Math.round(endSec - startSec), reason };
}

function renumber(episodes: EpisodeCandidate[]): EpisodeCandidate[] {
  return episodes.map((ep, i) => ({
    ...ep,
    id: i + 1,
    durationSec: Math.round(ep.endSec - ep.startSec),
    title: ep.title || `第 ${i + 1} 集`,
  }));
}

/** 补切点:优先用区间内最接近理想长度的候选断点,没有候选才落到句界中点。 */
function pickCutPoint(
  ep: EpisodeCandidate,
  candidates: RawBreak[],
  transcript: Transcript,
  range: TargetRange
): RawBreak | null {
  const lo = ep.startSec + range.min;
  const hi = ep.endSec - range.min;
  if (hi <= lo) return null;
  const ideal = ep.startSec + range.ideal;
  let best: RawBreak | null = null;
  for (const c of candidates) {
    if (c.timeSec <= lo || c.timeSec >= hi) continue;
    if (best === null || Math.abs(c.timeSec - ideal) < Math.abs(best.timeSec - ideal)) best = c;
  }
  if (best) return best;
  const mid = snapToSentenceBoundary(Math.min(Math.max(ideal, lo), hi), transcript, 10);
  if (mid <= ep.startSec || mid >= ep.endSec) return null;
  return { segmentId: 0, timeSec: mid, reason: "", chapterTitle: "" };
}

const MAX_ENFORCE_PASSES = 8;

/**
 * 时长硬约束:过短的并入相邻较短一侧,过长的补切。合并与补切会互相触发,
 * 用固定轮数封顶避免来回震荡;轮数用尽时留下的偏差好过死循环。
 */
export function enforceDuration(
  episodes: EpisodeCandidate[],
  transcript: Transcript,
  candidates: RawBreak[],
  range: TargetRange
): EpisodeCandidate[] {
  let current = [...episodes];
  for (let pass = 0; pass < MAX_ENFORCE_PASSES; pass++) {
    let changed = false;

    for (let i = 0; i < current.length && current.length > 1; i++) {
      if (current[i].endSec - current[i].startSec >= range.min) continue;
      const prev = i > 0 ? current[i - 1] : null;
      const next = i + 1 < current.length ? current[i + 1] : null;
      const intoPrev = next === null || (prev !== null && prev.durationSec <= next.durationSec);
      const keep = intoPrev ? current[i - 1] : current[i];
      const drop = intoPrev ? current[i] : current[i + 1];
      const merged = makeEpisode(keep.id, keep.startSec, drop.endSec, keep.title, keep.reason);
      current.splice(intoPrev ? i - 1 : i, 2, merged);
      changed = true;
      i = Math.max(-1, i - 2);
    }

    for (let i = 0; i < current.length; i++) {
      const ep = current[i];
      if (ep.endSec - ep.startSec <= range.max) continue;
      const cut = pickCutPoint(ep, candidates, transcript, range);
      if (cut === null) continue;
      current.splice(i, 1,
        makeEpisode(ep.id, ep.startSec, cut.timeSec, ep.title, ep.reason),
        makeEpisode(ep.id, cut.timeSec, ep.endSec, cut.chapterTitle, cleanReason(cut.reason)));
      changed = true;
    }

    if (!changed) break;
  }
  return renumber(current);
}

/** 智能分集:LLM 候选断点 → 全局选点 → 时长硬约束。断点不足时回退到等时。 */
export function smartSplit(
  transcript: Transcript,
  breaks: RawBreak[],
  config: EpisodeSplitConfig
): EpisodeCandidate[] {
  const totalSec = transcript.durationSec;
  if (totalSec <= 0) return [];

  const range = targetRange(config);

  // 对齐断点到句子边界,去掉开头和接近结尾的
  const snapped = breaks
    .map((b) => ({ ...b, timeSec: snapToSentenceBoundary(b.timeSec, transcript) }))
    .sort((a, b) => a.timeSec - b.timeSec)
    .filter((b) => b.timeSec > 0 && b.timeSec < totalSec - 10);

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

  const picked = selectBreaksGlobal(deduped, totalSec, range);
  const episodes: EpisodeCandidate[] = [];
  let prevSec = 0;
  let title = "";
  let reason = "";

  for (const bp of picked) {
    episodes.push(makeEpisode(episodes.length + 1, prevSec, bp.timeSec, title, reason));
    prevSec = bp.timeSec;
    title = bp.chapterTitle;
    reason = cleanReason(bp.reason);
  }
  if (totalSec - prevSec > 10 || episodes.length === 0) {
    episodes.push(makeEpisode(episodes.length + 1, prevSec, totalSec, title, reason));
  }

  return enforceDuration(episodes, transcript, deduped, range);
}

/**
 * 智能分集回退时用的间隔:取用户设的目标时长范围中点,而不是等时模式的
 * 独立 fixedIntervalSec(那个值在智能模式下输入框是隐藏的,默认 15 分钟,
 * 与用户在智能模式实际填的目标范围毫无关系——这就是"调了范围也不生效"的根因)。
 */
export function resolveTargetInterval(config: EpisodeSplitConfig): number {
  return Math.round(targetRange(config).ideal);
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
