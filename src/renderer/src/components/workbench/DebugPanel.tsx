import { useEffect, useRef, useState } from "react";
import { LuTrash2, LuX } from "react-icons/lu";
import { useDebugStore, type DebugLogEntry } from "../../stores/debug-store";

const LEVEL_STYLE: Record<DebugLogEntry["level"], string> = {
  info: "text-blue-400",
  warn: "text-yellow-400",
  error: "text-red-400",
  success: "text-green-400",
};

const LEVEL_TAG: Record<DebugLogEntry["level"], string> = {
  info: "INFO",
  warn: "WARN",
  error: "FAIL",
  success: " OK ",
};

type LogSource = "all" | "clip" | "episode";

const SOURCES: Array<{ key: LogSource; label: string }> = [
  { key: "all", label: "全部" },
  { key: "clip", label: "切片" },
  { key: "episode", label: "分集" },
];

const CLIP_PREFIX = "[切片]";
const EPISODE_PREFIXES = ["[分集]", "[导出]"];

function sourceOf(message: string): LogSource {
  if (message.includes(CLIP_PREFIX)) return "clip";
  if (EPISODE_PREFIXES.some((prefix) => message.includes(prefix))) return "episode";
  return "all";
}

function matches(entry: DebugLogEntry, filter: LogSource): boolean {
  return filter === "all" || sourceOf(entry.message) === filter;
}

export function DebugPanel(): React.JSX.Element | null {
  const { visible, logs, toggleVisible, clear } = useDebugStore();
  const [filter, setFilter] = useState<LogSource>("all");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  if (!visible) return null;

  const shown = logs.filter((entry) => matches(entry, filter));

  return (
    <div className="flex w-[320px] shrink-0 flex-col border-l border-line/70 bg-[#0d0d0d]">
      <div className="flex h-8 items-center justify-between border-b border-line/50 px-3">
        <span className="text-[10px] font-bold tracking-widest text-mut/70">DEBUG</span>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={clear} className="rounded p-0.5 text-mut/50 hover:text-mut" title="Clear">
            <LuTrash2 className="h-3 w-3" />
          </button>
          <button type="button" onClick={toggleVisible} className="rounded p-0.5 text-mut/50 hover:text-mut" title="Close">
            <LuX className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-line/50 px-2">
        {SOURCES.map((source) => (
          <button
            key={source.key}
            type="button"
            onClick={() => setFilter(source.key)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-bold transition-colors ${
              filter === source.key ? "bg-ember/15 text-ember" : "text-mut/50 hover:text-mut"
            }`}
          >
            {source.label}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-mut/40 tabular-nums">{shown.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-[10px] leading-[1.6]">
        {shown.length === 0 && (
          <p className="py-4 text-center text-mut/40">No logs</p>
        )}
        {shown.map((entry) => (
          <div key={entry.id} className="flex gap-1.5">
            <span className="shrink-0 text-mut/40">{entry.time}</span>
            <span className={`shrink-0 ${LEVEL_STYLE[entry.level]}`}>[{LEVEL_TAG[entry.level]}]</span>
            <span className="min-w-0 break-all text-fg/80">{entry.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
