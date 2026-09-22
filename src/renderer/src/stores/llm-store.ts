/**
 * LLM connection settings (persisted to localStorage).
 * Presets: Atlas Cloud (recommended default), Ollama local, custom.
 */
import { create } from "zustand";
import type { LlmConfig } from "../../../shared/api-types";
import { isLocalBaseUrl } from "../../../shared/llm-preflight";

const STORAGE_KEY = "hotclip-llm";
const PREFILTER_KEY = "hotclip-prefilter";
const VISION_KEY = "hotclip-vision";

/** 两级漏斗第一级的本地端点设置(默认 Ollama + qwen3:4b,默认关)。 */
export interface PrefilterSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  /** 云端端点的 API Key(本地 Ollama 留空即可)。 */
  apiKey?: string;
}

export const PREFILTER_DEFAULTS: PrefilterSettings = {
  enabled: false,
  baseUrl: "http://localhost:11434/v1",
  model: "qwen3:4b",
};

/** 视觉爆点信号的端侧 VL 端点设置(默认 Ollama + qwen3.5:4b,默认关)。 */
export const VISION_DEFAULTS: PrefilterSettings = {
  enabled: false,
  baseUrl: "http://localhost:11434/v1",
  model: "qwen3.5:4b",
};

function loadLocalEndpoint(key: string, defaults: PrefilterSettings): PrefilterSettings {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PrefilterSettings>;
      return {
        enabled: p.enabled === true,
        baseUrl: typeof p.baseUrl === "string" && p.baseUrl ? p.baseUrl : defaults.baseUrl,
        model: typeof p.model === "string" && p.model ? p.model : defaults.model,
        apiKey: typeof p.apiKey === "string" ? p.apiKey : undefined,
      };
    }
  } catch {
    /* 回落默认 */
  }
  return { ...defaults };
}

export interface LlmPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** 出厂建议模型。模型 id 会随厂商换代失效——UI 上的「拉取模型」才是准的。 */
  model: string;
  /** 申请 key 的地址;本地端点为空。 */
  keyUrl: string;
}

/**
 * 供应商预设:只保留 OpenAI 兼容接口 + Ollama 本地两种模式。
 * 任何提供 OpenAI 兼容 API 的服务(DeepSeek / 通义 / 硅基 / OpenRouter 等)
 * 都可以直接填 Base URL + Key 使用,无需内置每家预设。
 */
export const LLM_PRESET_LIST: LlmPreset[] = [
  {
    id: "openai-compatible",
    label: "OpenAI 兼容 API",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen3:8b",
    keyUrl: "",
  },
];

/** 按 baseUrl 认出当前选的是哪家(用户改过 baseUrl 就认不出,返回 undefined)。 */
export function presetForBaseUrl(baseUrl: string): LlmPreset | undefined {
  return LLM_PRESET_LIST.find((p) => p.baseUrl === baseUrl);
}

/** 兼容旧引用:默认指向 Ollama 本地。 */
export const LLM_PRESETS = { atlas: LLM_PRESET_LIST[1] } as const;

function load(): LlmConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LlmConfig>;
      if (typeof parsed.baseUrl === "string" && typeof parsed.model === "string") {
        return { baseUrl: parsed.baseUrl, apiKey: parsed.apiKey ?? "", model: parsed.model };
      }
    }
  } catch {
    /* fall through to defaults */
  }
  return { baseUrl: LLM_PRESETS.atlas.baseUrl, apiKey: "", model: LLM_PRESETS.atlas.model };
}

interface LlmState {
  config: LlmConfig;
  setConfig: (partial: Partial<LlmConfig>) => void;
  prefilter: PrefilterSettings;
  setPrefilter: (partial: Partial<PrefilterSettings>) => void;
  vision: PrefilterSettings;
  setVision: (partial: Partial<PrefilterSettings>) => void;
}

export const useLlmStore = create<LlmState>((set, get) => ({
  config: load(),
  setConfig: (partial) => {
    const config = { ...get().config, ...partial };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      /* persistence is best-effort */
    }
    set({ config });
  },
  prefilter: loadLocalEndpoint(PREFILTER_KEY, PREFILTER_DEFAULTS),
  setPrefilter: (partial) => {
    const prefilter = { ...get().prefilter, ...partial };
    try {
      localStorage.setItem(PREFILTER_KEY, JSON.stringify(prefilter));
    } catch {
      /* persistence is best-effort */
    }
    set({ prefilter });
  },
  vision: loadLocalEndpoint(VISION_KEY, VISION_DEFAULTS),
  setVision: (partial) => {
    const vision = { ...get().vision, ...partial };
    try {
      localStorage.setItem(VISION_KEY, JSON.stringify(vision));
    } catch {
      /* persistence is best-effort */
    }
    set({ vision });
  },
}));

/** Ready = enough fields to attempt a call (Ollama needs no key). */
export function isLlmReady(config: LlmConfig): boolean {
  const needsKey = !isLocalBaseUrl(config.baseUrl);
  return Boolean(config.baseUrl && config.model && (!needsKey || config.apiKey));
}
