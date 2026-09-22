/**
 * 分集参数面板:模式选择 + 时长范围 + 标题模板 + 导出选项 + 开始按钮。
 */
import { useState } from "react";
import { LuLoaderCircle, LuScissors } from "react-icons/lu";
import { useT } from "../../i18n/store";
import { useSession } from "../../stores/session-store";
import { useRenderPrefs } from "../../stores/render-prefs-store";
import { useLlmStore } from "../../stores/llm-store";
import { getApi } from "../../api/provider";
import { Segmented, SwitchRow } from "../ui";
import type { EpisodeMode, EpisodeNumberFormat } from "../../../../shared/api-types";
import { EPISODE_SPLIT_DEFAULTS } from "../../../../shared/api-types";

const NUMBER_FORMATS: EpisodeNumberFormat[] = ["P{n}", "第{n}集", "{n}", "{nn}"];

export function EpisodeParams(): React.JSX.Element {
  const t = useT("episode");
  const { transcript, episodeDetecting, setEpisodes, setEpisodeDetecting, setEpisodeSelected } = useSession();
  const { config: llmConfig } = useLlmStore();

  const [mode, setMode] = useState<EpisodeMode>("smart");
  const [minMin, setMinMin] = useState(10);
  const [maxMin, setMaxMin] = useState(20);
  const [intervalMin, setIntervalMin] = useState(15);
  const [prefix, setPrefix] = useState("");
  const [numFmt, setNumFmt] = useState<EpisodeNumberFormat>("P{n}");
  const [srtFile, setSrtFile] = useState(false);

  const canStart = !!transcript && !episodeDetecting;

  const [error, setError] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    if (!transcript) return;
    setEpisodeDetecting(true);
    setError(null);
    try {
      const cfg = {
        ...EPISODE_SPLIT_DEFAULTS,
        mode,
        targetMinSec: minMin * 60,
        targetMaxSec: maxMin * 60,
        fixedIntervalSec: intervalMin * 60,
        titlePrefix: prefix,
        numberFormat: numFmt,
        srtFile,
      };

      let episodes: import("../../../../shared/api-types").EpisodeCandidate[];

      if (mode === "smart") {
        // 智能模式: LLM 识别断点 → 分集 → AI 生成标题
        episodes = await getApi().episodeDetect({ transcript, llm: llmConfig, config: cfg });
        // LLM 生成每集标题(失败不阻塞——用默认标题)
        try {
          episodes = await getApi().episodeTitles({ transcript, episodes, config: cfg, llm: llmConfig });
        } catch { /* title generation is optional */ }
      } else if (mode === "fixed") {
        episodes = await getApi().episodeSplitFixed({ transcript, config: cfg });
      } else {
        // manual: 暂用空断点(后续支持用户交互添加)
        episodes = [];
      }

      setEpisodes(episodes);
      // 自动全选
      if (episodes.length > 0) {
        setEpisodeSelected(new Set(episodes.map((ep) => ep.id)));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Episode detect failed:", msg);
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

      {/* 分集模式 */}
      <Segmented<EpisodeMode>
        value={mode}
        options={[
          { value: "smart", label: t("modeSmart"), title: t("modeSmartHint") },
          { value: "fixed", label: t("modeFixed"), title: t("modeFixedHint") },
          { value: "manual", label: t("modeManual"), title: t("modeManualHint") },
        ]}
        onChange={setMode}
      />

      {/* 目标时长 */}
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold text-mut">{t("targetRange")}</span>
        <div className="flex items-center gap-2">
          <input
            type="number" min={1} max={120} value={minMin}
            onChange={(e) => setMinMin(Math.max(1, Number(e.target.value)))}
            className="w-16 rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-center text-[12px] outline-none focus:border-ember/60"
          />
          <span className="text-[11px] text-mut">~</span>
          <input
            type="number" min={1} max={120} value={maxMin}
            onChange={(e) => setMaxMin(Math.max(1, Number(e.target.value)))}
            className="w-16 rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-center text-[12px] outline-none focus:border-ember/60"
          />
          <span className="text-[11px] text-mut">{t("min")}</span>
        </div>
      </div>

      {/* 等时间隔(仅 fixed 模式) */}
      {mode === "fixed" && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-mut">{t("fixedInterval")}</span>
          <div className="flex items-center gap-2">
            <input
              type="number" min={1} max={120} value={intervalMin}
              onChange={(e) => setIntervalMin(Math.max(1, Number(e.target.value)))}
              className="w-16 rounded-lg border border-line bg-panel-2 px-2 py-1.5 text-center text-[12px] outline-none focus:border-ember/60"
            />
            <span className="text-[11px] text-mut">{t("min")}</span>
          </div>
        </div>
      )}

      {/* 标题前缀 */}
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold text-mut">{t("titlePrefix")}</span>
        <input
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          placeholder={t("titlePrefixPlaceholder")}
          className="w-full rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-[12px] outline-none focus:border-ember/60"
        />
      </div>

      {/* 序号格式 */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-mut">{t("numberFormat")}</span>
        <Segmented<EpisodeNumberFormat>
          value={numFmt}
          options={NUMBER_FORMATS.map((f) => ({ value: f, label: f.replace("{n}", "1").replace("{nn}", "01") }))}
          onChange={setNumFmt}
        />
      </div>

      {/* 导出选项 */}
      <SwitchRow label={t("optSrt")} on={srtFile} onToggle={() => setSrtFile(!srtFile)} />

      {/* 错误提示 */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
          {error}
        </div>
      )}

      {/* 开始按钮 */}
      <button
        type="button"
        disabled={!canStart}
        onClick={() => void start()}
        className="flex h-9 items-center justify-center gap-1.5 rounded-lg btn-flame text-[12.5px] font-bold text-white disabled:opacity-40"
      >
        {episodeDetecting ? (
          <>
            <LuLoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {t("detecting")}
          </>
        ) : (
          <>
            <LuScissors className="h-3.5 w-3.5" />
            {t("startDetect")}
          </>
        )}
      </button>
    </div>
  );
}
