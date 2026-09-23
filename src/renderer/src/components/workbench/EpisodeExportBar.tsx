import { useEffect, useState } from "react";
import { LuFolderOpen, LuScissors } from "react-icons/lu";
import { useT } from "../../i18n/store";
import { useSession } from "../../stores/session-store";
import { getApi } from "../../api/provider";
import { debugLog, debugError, debugSuccess } from "../../stores/debug-store";

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:00`;
  return `${m}:00`;
}

export function EpisodeExportBar(): React.JSX.Element {
  const t = useT("episode");
  const {
    file,
    transcript,
    episodes,
    episodeSelected,
    episodeExporting,
    episodeConfig,
    setEpisodeExporting,
  } = useSession();

  const all = episodes ?? [];
  const picked = all.filter((e) => episodeSelected.has(e.id));
  const totalSec = picked.reduce((a, e) => a + e.durationSec, 0);

  const [exportProgress, setExportProgress] = useState<{ current: number; total: number } | null>(null);
  const [exportDone, setExportDone] = useState<{ count: number; outDir: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = getApi().onEpisodeExportProgress((p: any) => {
      if (p && typeof p.current === "number" && typeof p.total === "number") {
        setExportProgress({ current: p.current, total: p.total });
        debugLog(`[导出] 进度: ${p.current}/${p.total} - ${p.episode?.title ?? ""}`);
      }
    });
    return unsub;
  }, []);

  const handleExport = async (): Promise<void> => {
    if (!file || !transcript || picked.length === 0) return;
    setEpisodeExporting(true);
    setExportDone(null);
    setExportError(null);
    setExportProgress(null);
    debugLog(`[导出] 开始导出 ${picked.length} 集`);
    debugLog(`[导出] 配置: prefix="${episodeConfig.titlePrefix}" fmt=${episodeConfig.numberFormat} srt=${episodeConfig.srtFile}`);
    const t0 = Date.now();
    try {
      const outDir = await getApi().defaultOutDir();
      const episodeOutDir = `${outDir}/episodes`;
      debugLog(`[导出] 输出目录: ${episodeOutDir}`);
      const results = await getApi().episodeExport({
        inputPath: file.path,
        episodes: picked,
        transcript,
        outDir: episodeOutDir,
        config: episodeConfig,
      });
      debugSuccess(`[导出] 完成, ${picked.length} 集, 耗时 ${Date.now() - t0}ms`);
      if (Array.isArray(results)) {
        results.forEach((r: any) => debugLog(`  -> ${r.outputPath ?? r.title}`));
      }
      setExportDone({ count: picked.length, outDir: episodeOutDir });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Episode export failed:", msg);
      debugError(`[导出] 失败: ${msg}`);
      setExportError(msg);
    } finally {
      setEpisodeExporting(false);
      setExportProgress(null);
    }
  };

  const handleReveal = (): void => {
    if (exportDone) {
      getApi().revealClip(exportDone.outDir);
    }
  };

  const progressLabel = exportProgress
    ? t("exporting", { current: String(exportProgress.current), total: exportProgress.total })
    : t("exporting", { current: "…", total: picked.length });

  return (
    <div className="flex shrink-0 flex-col border-t border-line/70 bg-panel/70 backdrop-blur">
      {exportError && (
        <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-4 py-2">
          <span className="text-[11px] text-red-400">{exportError}</span>
        </div>
      )}
      {exportDone && (
        <div className="flex items-center gap-2 border-b border-green-500/20 bg-green-500/10 px-4 py-2">
          <span className="text-[11px] text-green-400">
            {t("exportDone")} — {exportDone.count} 集
          </span>
          <button
            type="button"
            onClick={handleReveal}
            className="ml-auto flex items-center gap-1 rounded-md bg-green-500/20 px-2.5 py-1 text-[11px] font-semibold text-green-400 hover:bg-green-500/30"
          >
            <LuFolderOpen className="h-3.5 w-3.5" />
            {t("openFolder") ?? "打开文件夹"}
          </button>
        </div>
      )}
      <div className="flex h-12 items-center gap-3 px-4">
        <span className="shrink-0 text-[12px] font-semibold text-fg/90">
          {t("exportBarInfo", { n: picked.length, total: all.length, duration: formatDuration(totalSec) })}
        </span>
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          disabled={picked.length === 0 || episodeExporting}
          onClick={() => void handleExport()}
          className="btn-flame flex h-8.5 shrink-0 items-center gap-1.5 rounded-lg px-5 text-[13px] font-extrabold whitespace-nowrap text-white disabled:opacity-40"
        >
          <LuScissors className="h-4 w-4" />
          {episodeExporting ? progressLabel : t("exportSelected", { n: picked.length })}
        </button>
      </div>
    </div>
  );
}
