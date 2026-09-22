/**
 * 分集检测提示词:让 LLM 从逐句稿中识别话题转换点,输出章节断点列表。
 * 与爆点检测完全不同——不找"炸点",找"内容切换的接缝"。
 */
import type { Transcript } from "../transcribe/types";

function isChineseTranscript(transcript: Transcript): boolean {
  const sample = transcript.segments.slice(0, 20).map((s) => s.text).join("");
  const cjk = (sample.match(/[一-鿿]/g) ?? []).length;
  return sample.length > 0 && cjk / sample.length > 0.3;
}
export { isChineseTranscript };

export const EPISODE_SYSTEM_PROMPT_ZH = `你是一位专业视频分集编辑。给你一份长视频的逐句稿（带时间戳），你要找出所有适合作为"分集断点"的位置。

【什么是分集断点】
视频中话题/章节/知识点自然切换的时刻。典型信号：
- 明确的过渡语："好，接下来我们看…"、"下一个知识点是…"、"这部分就到这里"
- 话题突然切换：前面讲A，后面开始讲完全不同的B
- 明显的停顿或总结后开启新内容
- 场景或演示切换

【规则】
1. 断点必须落在句子边界上（给出 segmentId）
2. 每个断点附一句话说明为什么这里适合断开
3. 为断点之后的章节生成一个简洁的标题（概括该段核心内容，不超过20字）
4. 按视频时间顺序列出所有断点
5. 视频开头（0秒）不算断点——它是第一集的自然起点
6. 不要强行凑数：如果整段视频就是一个连贯主题，可以只返回很少的断点甚至空列表

【输出格式】严格 JSON：
{
  "breaks": [
    { "segmentId": 42, "timeSec": 723.5, "reason": "从基础概念转入实战演示", "chapterTitle": "实战演示与操作步骤" }
  ]
}`;

export const EPISODE_SYSTEM_PROMPT_EN = `You are a professional video episode editor. Given a long video's sentence-level transcript (with timestamps), find all natural "episode break" points.

【What counts as a break point】
Moments where the topic/chapter/subject naturally transitions. Typical signals:
- Explicit transitions: "Now let's move on to…", "The next topic is…", "That wraps up this section"
- Topic shifts: the speaker switches from subject A to a completely different subject B
- Notable pauses or summaries followed by new content
- Scene or demonstration changes

【Rules】
1. Each break must land on a sentence boundary (provide the segmentId)
2. For each break, give a one-line reason why it's a good split point
3. Generate a concise chapter title for the section AFTER the break (≤10 words, summarizing core content)
4. List all breaks in chronological order
5. The video start (0s) is NOT a break — it's the natural start of episode 1
6. Don't pad: if the entire video is one continuous topic, return few or zero breaks

【Output format】Strict JSON:
{
  "breaks": [
    { "segmentId": 42, "timeSec": 723.5, "reason": "Transitions from basics to hands-on demo", "chapterTitle": "Hands-on Demo & Steps" }
  ]
}`;

/**
 * 构建分集检测的 user prompt:把逐句稿压缩成"编号 时间 文本"格式。
 * 长视频(>1h)的逐句稿可能超 token 上限,按 4000 句截断并提示 LLM。
 */
export function buildEpisodePrompt(transcript: Transcript, targetMinSec: number, targetMaxSec: number): string {
  const zh = isChineseTranscript(transcript);
  const segs = transcript.segments;
  const MAX_SEGS = 4000;
  const truncated = segs.length > MAX_SEGS;
  const usable = truncated ? segs.slice(0, MAX_SEGS) : segs;

  const lines = usable.map((s, i) => {
    const mm = Math.floor(s.startSec / 60);
    const ss = Math.floor(s.startSec % 60);
    const ts = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    return `[${i}] ${ts} ${s.text}`;
  });

  const targetMin = Math.round(targetMinSec / 60);
  const targetMax = Math.round(targetMaxSec / 60);
  const totalMin = Math.round(transcript.durationSec / 60);

  const header = zh
    ? `这是一份 ${totalMin} 分钟的视频逐句稿(共 ${usable.length} 句${truncated ? "，已截断" : ""})。\n请找出所有话题切换的断点,使每一集的时长尽量在 ${targetMin}~${targetMax} 分钟之间。\n\n`
    : `This is a ${totalMin}-minute video transcript (${usable.length} sentences${truncated ? ", truncated" : ""}).\nFind all topic-transition break points so each episode is roughly ${targetMin}–${targetMax} minutes.\n\n`;

  return header + lines.join("\n");
}

export function episodeSystemPrompt(transcript: Transcript): string {
  return isChineseTranscript(transcript) ? EPISODE_SYSTEM_PROMPT_ZH : EPISODE_SYSTEM_PROMPT_EN;
}
