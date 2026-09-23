import { useState } from "react";
import { LuLoaderCircle, LuScissors } from "react-icons/lu";
import { useT } from "../../i18n/store";
import { useSession } from "../../stores/session-store";
import { useLlmStore } from "../../stores/llm-store";
import { getApi } from "../../api/provider";
import { Segmented, SwitchRow } from "../ui";
import { debugLog, debugError, debugSuccess, debugWarn } from "../../stores/debug-store";
import type { EpisodeMode, EpisodeNumberFormat, EpisodeCandidate } from "../../../../shared/api-types";

const NUMBER_FORMATS: EpisodeNumberFormat[] = ["P{n}", "第{n}集", "{n}", "{nn}"];

function formatClock(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function EpisodeParams(): React.JSX.Element {
  const t = useT("episode");
  const {
    transcript,
    episodeDetecting,
    episodeConfig,
    setEpisodes,
    setEpisodeDetecting,
    setEpisodeSelected,
    setEpisodeConfig,
  } = useSession();
  const { config: llmConfig } = useLlmStore();

  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const mode = episodeConfig.mode;
  const minMin = Math.round(episodeConfig.targetMinSec / 60);
  const maxMin = Math.round(episodeConfig.targetMaxSec / 60);
  const intervalMin = Math.round((episodeConfig.fixedIntervalSec ?? 900) / 60);
  const prefix = episodeConfig.titlePrefix;
  const numFmt = episodeConfig.numberFormat;
  const srtFile = episodeConfig.srtFile;
  const parsedChars = transcript ? transcript.segments.reduce((n, s) => n + s.text.length, 0) : 0;
  const estimateCount = transcript && transcript.durationSec > 0
    ? Math.max(1, Math.round(transcript.durationSec / Math.max(60, (episodeConfig.targetMinSec + episodeConfig.targetMaxSec) / 2)))
    : 0;

  const canStart = !!transcript && !episodeDetecting;

  const start = async (): Promise<void> => {
    if (!transcript) return;
    setEpisodeDetecting(true);
    setError(null);
    setWarning(null);
    debugLog(`[分集] 开始检测 mode=${mode} range=${minMin}~${maxMin}min`);
    debugLog(`[分集] LLM: ${llmConfig.model} @ ${llmConfig.baseUrl}`);
    const t0 = Date.now();
    try {
      const cfg = episodeConfig;

      let episodes: EpisodeCandidate[];

      if (mode === "smart") {
        debugLog("[分集] 智能模式: 调用 episodeDetect...");
        const result = await getApi().episodeDetect({ transcript, llm: llmConfig, config: cfg });
        episodes = result.episodes;
        debugLog(`[分集] 检测完成: ${episodes.length} 集 (${Date.now() - t0}ms)`);
        if (result.fallbackReason) {
          debugWarn(`[分集] 回退: ${result.fallbackReason}`);
          setWarning(result.fallbackReason);
        }
        if (episodes.length > 0) {
          debugLog("[分集] 调用 episodeTitles 生成标题...");
          const t1 = Date.now();
          try {
            const titled = await getApi().episodeTitles({ transcript, episodes, config: cfg, llm: llmConfig });
            episodes = titled.episodes;
            debugSuccess(`[分集] 标题生成完成 (${Date.now() - t1}ms)`);
            if (titled.titleWarning) debugWarn(`[分集] 标题回退到原文摘句: ${titled.titleWarning}`);
            episodes.forEach((ep) => debugLog(`  ${ep.id}: ${ep.title} [${formatClock(ep.startSec)} → ${formatClock(ep.endSec)}]${ep.reason ? ` ${ep.reason}` : ""}`));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            debugWarn(`[分集] 标题生成失败: ${msg}`);
          }
        }
      } else if (mode === "fixed") {
        debugLog("[分集] 等时模式: 调用 episodeSplitFixed...");
        episodes = await getApi().episodeSplitFixed({ transcript, config: cfg });
        debugLog(`[分集] 等时切割完成: ${episodes.length} 集`);
      } else {
        episodes = [];
        debugLog("[分集] 手动模式: 等待用户标记");
      }

      setEpisodes(episodes);
      if (episodes.length > 0) {
        setEpisodeSelected(new Set(episodes.map((ep) => ep.id)));
        debugSuccess(`[分集] 完成, 共 ${episodes.length} 集, 总耗时 ${Date.now() - t0}ms`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Episode detect failed:", msg);
      debugError(`[分集] 失败: ${msg}`);
      setError(msg);
    } finally {
      setEpisodeDetecting(false);
    }
  };

  if (!transcript) {
    return <p className="mt-8 text-center text-[11.5px] text-mut/70">{t("noTranscript")}</p>;
  }

  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-[12.5px] leading-relaxed text-mut">{t("desc")}</p>

      <div className="flex flex-col gap-1 rounded-lg border border-line/60 bg-panel-2/50 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-mut tabular-nums">
          <span className="font-bold text-fg/80">{t("parsedSource")}</span>
          <span>{t("parsedDuration")} {formatClock(transcript.durationSec)}</span>
          <span>{t("parsedSegments")} {transcript.segments.length}</span>
          <span>{t("parsedChars")} {parsedChars}</span>
          <span>{t("parsedEngine")} {transcript.engine}</span>
          <span>{t("parsedLang")} {transcript.language}</span>
        </div>
        <span className="text-[10px] text-mut/70">{t("parsedHint", { n: estimateCount })}</span>
      </div>

      <Segmented<EpisodeMode>
        value={mode}
        options={[
          { value: "smart", label: t("modeSmart"), title: t("modeSmartHint") },
          { value: "fixed", label: t("modeFixed"), title: t("modeFixedHint") },
          { value: "manual", label: t("modeManual"), title: t("modeManualHint") },
        ]}
        onChange={(v) => setEpisodeConfig({ mode: v })}
      />

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold text-mut">{t("targetRange")}</span>
        <div className="flex items-center gap-2">
          <input type="number" min={1} max={120} value={minMin}
            onChange={(e) => setEpisodeConfig({ targetMinSec: Math.max(1, Number(e.target.value)) * 60 })}
            className="w-16 rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-center text-[12px] outline-none focus:border-ember/60" />
          <span className="text-[11px] text-mut">~</span>
          <input type="number" min={1} max={120} value={maxMin}
            onChange={(e) => setEpisodeConfig({ targetMaxSec: Math.max(1, Number(e.target.value)) * 60 })}
            className="w-16 rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-center text-[12px] outline-none focus:border-ember/60" />
          <span className="text-[11px] text-mut">{t("min")}</span>
        </div>
      </div>

      {mode === "fixed" && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-mut">{t("fixedInterval")}</span>
          <div className="flex items-center gap-2">
            <input type="number" min={1} max={120} value={intervalMin}
              onChange={(e) => setEpisodeConfig({ fixedIntervalSec: Math.max(1, Number(e.target.value)) * 60 })}
              className="w-16 rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-center text-[12px] outline-none focus:border-ember/60" />
            <span className="text-[11px] text-mut">{t("min")}</span>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold text-mut">{t("titlePrefix")}</span>
        <input value={prefix} onChange={(e) => setEpisodeConfig({ titlePrefix: e.target.value })}
          placeholder={t("titlePrefixPlaceholder")}
          className="w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-[12px] outline-none focus:border-ember/60" />
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-mut">{t("numberFormat")}</span>
        <Segmented<EpisodeNumberFormat>
          value={numFmt}
          options={NUMBER_FORMATS.map((f) => ({ value: f, label: f.replace("{n}", "1").replace("{nn}", "01") }))}
          onChange={(v) => setEpisodeConfig({ numberFormat: v })} />
      </div>

      <SwitchRow label={t("optSrt")} on={srtFile} onToggle={() => setEpisodeConfig({ srtFile: !srtFile })} />

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">{error}</div>
      )}
      {warning && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-[11px] text-yellow-400">{warning}</div>
      )}

      <button type="button" disabled={!canStart} onClick={() => void start()}
        className="flex h-9 items-center justify-center gap-1.5 rounded-lg btn-flame text-[12.5px] font-bold text-white disabled:opacity-40">
        {episodeDetecting ? (
          <><LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />{t("detecting")}</>
        ) : (
          <><LuScissors className="h-3.5 w-3.5" />{t("startDetect")}</>
        )}
      </button>
    </div>
  );
}
