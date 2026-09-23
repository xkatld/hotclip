/**
 * 检测编排:把「调 detectHighlights → 结果落 session store」收成一个动作。
 * 与旧版最大的区别:参数改动只标脏,唯一的触发点是显式调用 run()——
 * 「重新检测」按钮是花 LLM 钱的那只手,用户永远知道自己按了它。
 */
import { useCallback } from "react";
import { getApi } from "../../api/provider";
import { useSession } from "../../stores/session-store";
import { useLlmStore } from "../../stores/llm-store";
import { useRenderPrefs } from "../../stores/render-prefs-store";
import { debugError, debugLog, debugSuccess, debugWarn } from "../../stores/debug-store";
import { stripIpcError } from "../../../../shared/transcribe-errors";
import { clipDurationSec } from "../../../../shared/pieces";
import type { DetectHighlightsResult, HighlightCandidate } from "../../../../shared/api-types";

function logDetectStats(result: DetectHighlightsResult): void {
  const funnel = result.funnel;
  if (funnel) debugLog(`[切片] 漏斗: 入围 ${funnel.keptSegments}/${funnel.totalSegments} 句, ${funnel.keptChars}/${funnel.totalChars} 字`);
  const vision = result.vision;
  if (vision) {
    const review = vision.candidatesReviewed ? ` 复核 ${vision.candidatesReviewed} 条 调整 ${vision.candidatesAdjusted ?? 0} 条` : "";
    debugLog(`[切片] 视觉: 抽 ${vision.framesTotal} 帧 打分 ${vision.framesScored} 峰值 ${vision.peakCount}${vision.fullScan ? " 全场扫描" : ""}${review}`);
  }
  const emotion = result.emotion;
  if (emotion) debugLog(`[切片] 表情: 帧 ${emotion.framesTotal} 人脸 ${emotion.facesScored} 峰值 ${emotion.peakCount}`);
  const danmaku = result.danmaku;
  if (danmaku) debugLog(`[切片] 弹幕: ${danmaku.count} 条 峰值 ${danmaku.peakCount}`);
  const voice = result.voice;
  if (voice) debugLog(`[切片] 语音情绪: 窗 ${voice.windowsScored}/${voice.windowsPlanned} 情绪峰 ${voice.emotionPeakCount} 事件峰 ${voice.eventPeakCount}`);
  const reference = result.reference;
  if (reference) {
    const cuts = reference.cutsPerMin === null ? "未知" : reference.cutsPerMin.toFixed(1);
    debugLog(`[切片] 参考画像: ${Math.round(reference.durationSec)}s 语速 ${reference.speechRate.toFixed(2)} 镜头 ${cuts} 钩子 ${reference.hookLine}`);
  }
  if (result.referenceError) debugWarn(`[切片] 参考分析失败: ${result.referenceError}`);
}

function logCandidates(candidates: HighlightCandidate[]): void {
  const gates: Record<"publish" | "review" | "drop" | "none", number> = { publish: 0, review: 0, drop: 0, none: 0 };
  for (const c of candidates) gates[c.gate ?? "none"] += 1;
  debugLog(`[切片] 质量门: 建议发 ${gates.publish} 需复核 ${gates.review} 不建议 ${gates.drop} 未过门 ${gates.none}`);
  debugLog(`[切片] 推荐发布 ${candidates.filter((c) => c.recommended).length} 条`);
  for (const c of candidates) {
    const stitched = c.pieces && c.pieces.length > 1 ? `${c.pieces.length} 段拼接 ` : "";
    debugLog(`  ${c.id}: ${c.score} 分 ${c.gate ?? "-"} ${Math.round(clipDurationSec(c))}s ${stitched}${c.title}`);
  }
}

export function useDetection(): { run: () => Promise<void> } {
  const { config, prefilter, vision } = useLlmStore();
  const { prefs } = useRenderPrefs();

  const run = useCallback(async (): Promise<void> => {
    const s = useSession.getState();
    if (!s.transcript || s.detecting) return;
    const transcript = s.transcript;
    const fullScan = prefs.fullScan && vision.enabled;
    const t0 = Date.now();
    s.setDetecting(true);
    s.setDetectError(null);
    debugLog(`[切片] 开始找爆点 档=${prefs.clipLength} 品类=${prefs.genreId || "默认"} 参考片=${s.referencePath ? "有" : "无"}`);
    debugLog(`[切片] 开关 预筛=${prefilter.enabled ? "开" : "关"} 视觉=${vision.enabled ? "开" : "关"} 全场扫描=${fullScan ? "开" : "关"} 分角色=${s.diarize ? "开" : "关"}`);
    debugLog(`[切片] LLM: ${config.model} @ ${config.baseUrl}`);
    debugLog(`[切片] 逐句稿: ${Math.round(transcript.durationSec)}s ${transcript.segments.length} 句 ${transcript.segments.reduce((n, seg) => n + seg.text.length, 0)} 字 ${transcript.language}`);
    try {
      const focus = prefs.briefFocus.trim();
      const exclude = prefs.briefExclude.trim();
      const result = await getApi().detectHighlights(
        transcript,
        config,
        s.file?.path,
        s.diarize,
        prefilter.enabled ? { baseUrl: prefilter.baseUrl, model: prefilter.model } : null,
        vision.enabled ? { baseUrl: vision.baseUrl, model: vision.model, apiKey: vision.apiKey || undefined } : null,
        prefs.clipLength,
        prefs.products,
        s.referencePath,
        { id: prefs.genreId, custom: prefs.genreCustom },
        focus || exclude ? { focus: focus || undefined, exclude: exclude || undefined } : null,
        fullScan
      );
      debugSuccess(`[切片] 检测完成: ${result.candidates.length} 条候选 (${Date.now() - t0}ms)`);
      logDetectStats(result);
      logCandidates(result.candidates);
      const st = useSession.getState();
      st.setCandidates(result.candidates);
      st.setStats({
        funnel: result.funnel ?? null,
        vision: result.vision ?? null,
        emotion: result.emotion ?? null,
        danmaku: result.danmaku ?? null,
        voice: result.voice ?? null,
        reference: result.reference ?? null,
        referenceError: result.referenceError ?? null,
      });
      // 复评通过的预选出片;右栏聚焦第一条推荐(没有就第一条)
      st.setSelected(new Set(result.candidates.filter((c) => c.recommended).map((c) => c.id)));
      st.setFocusedId(result.candidates.find((c) => c.recommended)?.id ?? result.candidates[0]?.id ?? null);
      // 带说话人标注的逐句稿回流(导出按说话人给字幕上色)
      if (result.transcript) st.setTranscript(result.transcript);
      st.markParamsDirty(false);
    } catch (e) {
      // IPC 包装串只会淹没真正有用的那句话——先剥壳再展示(issue #6)
      const msg = stripIpcError(e instanceof Error ? e.message : String(e));
      debugError(`[切片] 失败: ${msg}`);
      useSession.getState().setDetectError(msg);
    } finally {
      useSession.getState().setDetecting(false);
    }
  }, [config, prefilter, vision, prefs]);

  return { run };
}
