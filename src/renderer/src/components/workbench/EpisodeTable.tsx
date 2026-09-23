/**
 * 分集结果表:勾选 + 标题编辑 + 时间范围 + 时长。
 */
import { useT } from "../../i18n/store";
import { useSession } from "../../stores/session-store";

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m > 0 ? `${m}分${s > 0 ? s + "秒" : ""}` : `${s}秒`;
}

export function EpisodeTable({ onSeek }: { onSeek?: (sec: number) => void }): React.JSX.Element | null {
  const t = useT("episode");
  const { episodes, episodeSelected, episodeFocusedId, toggleEpisodeSelected, setEpisodeFocusedId, patchEpisode } = useSession();

  if (!episodes || episodes.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-bold text-mut">{t("resultTitle")}</span>
        <span className="text-[10.5px] text-mut">{t("resultCount", { n: episodes.length })} · {t("seekHint")}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {episodes.map((ep) => {
          const selected = episodeSelected.has(ep.id);
          const focused = episodeFocusedId === ep.id;
          return (
            <div
              key={ep.id}
              onClick={() => {
                setEpisodeFocusedId(ep.id);
                onSeek?.(ep.startSec);
              }}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                focused
                  ? "border-ember/60 bg-ember/5"
                  : selected
                    ? "border-line/80 bg-panel-2/60"
                    : "border-transparent hover:bg-panel-2/40"
              }`}
            >
              <input
                type="checkbox"
                checked={selected}
                onChange={() => toggleEpisodeSelected(ep.id)}
                onClick={(e) => e.stopPropagation()}
                className="h-3.5 w-3.5 shrink-0 accent-ember"
              />
              <div className="min-w-0 flex-1">
                <input
                  value={ep.title}
                  onChange={(e) => patchEpisode(ep.id, { title: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full bg-transparent text-[12px] font-semibold text-fg outline-none"
                />
                <div className="mt-0.5 flex gap-3 text-[10.5px] text-mut tabular-nums">
                  <span>{formatTime(ep.startSec)} → {formatTime(ep.endSec)}</span>
                  <span>{formatDuration(ep.durationSec)}</span>
                  <span className={ep.reason ? "text-sky-400/80" : "text-mut/60"}>
                    {ep.reason ? t("fromAi") : t("fromFixed")}
                  </span>
                </div>
                {ep.reason && <p className="mt-0.5 text-[10px] text-mut/60">{t("epReason")}: {ep.reason}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
