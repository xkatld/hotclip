import { create } from "zustand";

export interface DebugLogEntry {
  id: number;
  time: string;
  level: "info" | "warn" | "error" | "success";
  message: string;
}

interface DebugState {
  visible: boolean;
  logs: DebugLogEntry[];
  nextId: number;
  toggleVisible: () => void;
  log: (level: DebugLogEntry["level"], message: string) => void;
  clear: () => void;
}

function now(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

const MAX_LOGS = 500;

export const useDebugStore = create<DebugState>((set, get) => ({
  visible: false,
  logs: [],
  nextId: 1,
  toggleVisible: () => set({ visible: !get().visible }),
  log: (level, message) => {
    const entry: DebugLogEntry = { id: get().nextId, time: now(), level, message };
    const logs = [...get().logs, entry].slice(-MAX_LOGS);
    set({ logs, nextId: get().nextId + 1 });
  },
  clear: () => set({ logs: [], nextId: 1 }),
}));

export function debugLog(message: string): void {
  useDebugStore.getState().log("info", message);
}

export function debugWarn(message: string): void {
  useDebugStore.getState().log("warn", message);
}

export function debugError(message: string): void {
  useDebugStore.getState().log("error", message);
}

export function debugSuccess(message: string): void {
  useDebugStore.getState().log("success", message);
}
