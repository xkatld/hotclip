/**
 * 分集导出底栏:已选统计 + 导出按钮。
 */
import { LuScissors } from "react-icons/lu";
import { useT } from "../../i18n/store";
import { useSession } from "../../stores/session-store";

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:00`;
  return `${m}:00`;
}

export function EpisodeExportBar({ onExport }: { onExport: () => void }): React.JSX.Element {
  const t = useT("episode");
  const { episodes, episodeSelected, episodeExporting } = useSession();
  const all = episodes ?? [];
  const picked = all.filter((e) => episodeSelected.has(e.id));
  const totalSec = picked.reduce((a, e) => a + e.durationSec, 0);

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-t border-line/70 bg-panel/70 px-4 backdrop-blur">
      <span className="shrink-0 text-[12px] font-semibold text-fg/90">
        {t("exportBarInfo", { n: picked.length, total: all.length, duration: formatDuration(totalSec) })}
      </span>
      <span className="min-w-0 flex-1" />
      <button
        type="button"
        disabled={picked.length === 0 || episodeExporting}
        onClick={onExport}
        className="btn-flame flex h-8.5 shrink-0 items-center gap-1.5 rounded-lg px-5 text-[13px] font-extrabold whitespace-nowrap text-white disabled:opacity-40"
      >
        <LuScissors className="h-4 w-4" />
        {episodeExporting ? t("exporting", { current: "…", total: picked.length }) : t("exportSelected", { n: picked.length })}
      </button>
    </div>
  );
}
