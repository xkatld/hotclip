import type { LlmConfig } from "../shared/api-types";
import { isLocalBaseUrl } from "../shared/llm-preflight";

/** 模型 HTTP 请求的边界：总时限、可取消等待、有限重试和响应体上限。 */
export const LLM_REMOTE_TIMEOUT_MS = 180_000;
export const LLM_LOCAL_TIMEOUT_MS = 300_000;
export const LLM_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
export const LLM_RETRY_WAIT_MAX_MS = 5_000;

export interface LlmRequestBudget { deadline: number; retriesRemaining: number }
export function llmRequestBudget(timeoutMs: number, retries = 0): LlmRequestBudget {
  return { deadline: Date.now() + timeoutMs, retriesRemaining: retries };
}

/** 加大输出预算重发后仍然只有思考过程、正文为空：结构化输出（分集/标题）不能拿思考当答案。 */
export class LlmReasoningOnlyError extends Error {
  constructor() {
    super(
      "当前模型只返回了思考过程,加大输出预算重试后正文仍然是空的。分集与标题需要结构化输出,请在模型列表换成非思考版本(通常带 instruct/chat 字样),或换常规对话模型。" +
        " / This model returned only its reasoning, with an empty body even after retrying with a larger output budget. Episode splitting needs structured output — switch to a non-thinking variant (usually named instruct/chat) or a regular chat model."
    );
    this.name = "LlmReasoningOnlyError";
  }
}

export class LlmTransportError extends Error {
  constructor(readonly kind: "timeout" | "response-too-large") {
    super(kind === "timeout"
      ? "模型响应超时，请稍后重试或选择更小的模型。/ Model response timed out; retry later or choose a smaller model."
      : "模型响应过大，已停止读取；请检查接口地址或换一个模型。/ Model response too large; check the endpoint or choose another model.");
    this.name = "LlmTransportError";
  }
}

/** Retry-After 同时支持秒数与 HTTP 日期；非法值不作为服务端等待指示。 */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value?.trim()) return null;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }
  // 避免 Date.parse 把负数或畸形数字解释成日期。
  if (!/[A-Za-z]/.test(value)) return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) return "";
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let complete = false;
  try {
    const declared = Number(response.headers.get("content-length"));
    if (declared > maxBytes) throw new LlmTransportError("response-too-large");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > maxBytes) throw new LlmTransportError("response-too-large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

/** 只对明确的限流/暂时不可用响应重试；断网、超时和已成功返回的正文不重发。 */
export async function requestLlmText(url: string, init: Omit<RequestInit, "signal">, options: {
  signal?: AbortSignal; budget?: LlmRequestBudget; maxBytes?: number;
} = {}): Promise<{ ok: boolean; status: number; headers: Headers; text: string }> {
  const budget = options.budget ?? llmRequestBudget(LLM_REMOTE_TIMEOUT_MS);
  const timeout = new AbortController();
  const remaining = budget.deadline - Date.now();
  options.signal?.throwIfAborted();
  if (remaining <= 0) throw new LlmTransportError("timeout");
  const timer = setTimeout(() => timeout.abort(), remaining);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  try {
    for (;;) {
      signal.throwIfAborted();
      const response = await fetch(url, { ...init, signal });
      const text = await readBounded(response, response.ok ? options.maxBytes ?? LLM_RESPONSE_MAX_BYTES : 64 * 1024, signal);
      const wait = retryAfterMs(response.headers.get("retry-after")) ?? 1_000;
      const quotaFailure = /insufficient_quota|quota_exhausted|billing_hard_limit|credit[_ ]balance|余额不足|欠费/i.test(text);
      if ((response.status === 429 || response.status === 503) && !quotaFailure && budget.retriesRemaining > 0 &&
          wait <= LLM_RETRY_WAIT_MAX_MS && wait < budget.deadline - Date.now()) {
        budget.retriesRemaining--;
        await waitForRetry(wait, signal);
        continue;
      }
      return { ok: response.ok, status: response.status, headers: response.headers, text };
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (timeout.signal.aborted) throw new LlmTransportError("timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 对用户保留服务端诊断，但不把供应商回显的 Key 带进错误提示。 */
export function modelErrorDetail(text: string, apiKey: string, maxLength = 300): string {
  let detail = text;
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof body?.error === "string" ? body.error : body?.error?.message ?? body?.message;
    if (typeof message === "string") detail = message;
  } catch { /* 非 JSON 错误仍保留有界诊断。 */ }
  if (apiKey) detail = detail.split(apiKey).join("[redacted]");
  return detail.replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]").slice(0, maxLength);
}

/**
 * 输出预算。思考型模型把 reasoning 也算进 max_tokens,4000 在长窗口下会被
 * 思考烧光、正文一个字都吐不出来(实测 45 分钟窗口 mt=500 时 content 为空)。
 * max_tokens 只是上限、按实际生成量计费,给大不花钱,给小直接丢答案。
 * 16000 是各家普遍接受的上限;个别供应商会按自己的模型上限拒掉,再降档重发。
 */
export const MAX_TOKENS = 16000;
export const RETRY_MAX_TOKENS = 64000;
export const FALLBACK_MAX_TOKENS = 4000;
export const JSON_ATTEMPTS = 2;

/** 供应商按自己的模型上限拒绝 max_tokens 时的特征,用于降档重发。 */
function isMaxTokensRejection(message: string): boolean {
  return /HTTP 400/i.test(message) && /max_tokens|max_completion_tokens|maximum.*token|token.*limit/i.test(message);
}

/**
 * fetch 抛错时把底层原因摊平成一行。undici 把 ECONNRESET / ENOTFOUND / 证书错误
 * 全都包成一句 "fetch failed",不展开 cause 用户看到的报错等于没有信息。
 */
function networkDetail(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    const code = (cur as NodeJS.ErrnoException).code;
    const one = code ? `${cur.message} (${code})` : cur.message;
    if (one && !parts.includes(one)) parts.push(one);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.length > 0 ? `底层原因 / cause: ${parts.join(" <- ")}` : "";
}

export function extraParams(baseUrl: string): Record<string, unknown> {
  return /pollinations\.ai/i.test(baseUrl) ? { reasoning_effort: "low" } : {};
}

export function thinkingParams(model: string): Record<string, unknown> {
  return /(?:^|[/:-])qwen3(?:[.:-]|$)|(?:^|[/:-])qwq(?:[.:-]|$)/i.test(model)
    ? { enable_thinking: false }
    : {};
}

export interface ChatAttempt {
  content: string;
  reasoning: string;
  finishReason: string;
}

interface ChatEnvelope {
  choices?: Array<{
    finish_reason?: string;
    text?: string;
    message?: {
      content?: string | Array<{ text?: unknown }>;
      reasoning_content?: string;
      reasoning?: string;
    };
  }>;
}

export function readChatEnvelope(text: string): ChatAttempt | null {
  let data: ChatEnvelope;
  try {
    data = JSON.parse(text) as ChatEnvelope;
  } catch {
    return null;
  }
  const choice = data?.choices?.[0];
  const message = choice?.message;
  const content = Array.isArray(message?.content)
    ? message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
    : typeof message?.content === "string"
      ? message.content
      : typeof choice?.text === "string"
        ? choice.text
        : "";
  const reasoning =
    (typeof message?.reasoning_content === "string" && message.reasoning_content) ||
    (typeof message?.reasoning === "string" && message.reasoning) ||
    "";
  return {
    content: content.trim(),
    reasoning: reasoning.trim(),
    finishReason: String(choice?.finish_reason ?? ""),
  };
}

export function unwrapLlmBody(text: string): string {
  const envelope = readChatEnvelope(text);
  return envelope && envelope.content ? envelope.content : text;
}

export interface ChatRequestOptions {
  /** 省略则请求体里完全不带 temperature。思考型模型(以及 Anthropic 网关)只接受 temperature=1,带 0.2/0.6 会直接 HTTP 400。 */
  temperature?: number;
  /** 结构化输出专用：确认模型只会吐思考过程后抛 LlmReasoningOnlyError，而不是拿思考当答案去解析。 */
  rejectReasoningFallback?: boolean;
}

/** 只保留给外部调用方参考;chatComplete 默认不带 temperature,交给供应商用自己的默认值。 */
export const DEFAULT_CHAT_TEMPERATURE = 0.6;

async function chatAttempt(
  llm: LlmConfig,
  system: string,
  user: string,
  signal: AbortSignal | undefined,
  maxTokens: number,
  budget: LlmRequestBudget,
  includeThinkingParam = true,
  temperature?: number
): Promise<ChatAttempt> {
  const url = `${llm.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let res: Awaited<ReturnType<typeof requestLlmText>>;
  try {
    res = await requestLlmText(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(temperature === undefined ? {} : { temperature }),
        max_tokens: maxTokens,
        ...extraParams(llm.baseUrl),
        ...(includeThinkingParam ? thinkingParams(llm.model) : {}),
      }),
    }, { signal, budget });
  } catch (e) {
    signal?.throwIfAborted();
    if (e instanceof LlmTransportError) throw e;
    const hint = isLocalBaseUrl(llm.baseUrl)
      ? "本机 LLM 服务没有响应:若用 Ollama,请先到 ollama.com 安装并启动,再运行 ollama pull 拉取模型;或点「连接 AI 模型」换云端供应商,填 API Key 即用。/ Local LLM not responding: install & start Ollama (ollama.com) and pull the model, or switch to a cloud provider with an API key."
      : "请检查网络连接,并确认 Base URL 填写正确。/ Check your network and verify the Base URL.";
    // 带上 cause:底层是 ECONNRESET 还是 DNS 失败,不保留就永远查不出来。
    throw new Error(`无法连接 LLM 服务 / cannot reach LLM endpoint\n${hint}\n${networkDetail(e)}`, { cause: e });
  }
  const text = res.text;
  if (!res.ok) {
    const retryWait = retryAfterMs(res.headers.get("retry-after"));
    const hint = isLocalBaseUrl(llm.baseUrl) && res.status === 404
      ? `\n本机可能还没拉取这个模型:先运行 ollama pull ${llm.model} / model likely not pulled yet: run ollama pull ${llm.model}`
      : res.status === 429 || res.status === 503
        ? retryWait !== null && retryWait > 0
          ? `\n服务商建议等待 ${Math.ceil(retryWait / 1000)} 秒后重试。/ Retry after ${Math.ceil(retryWait / 1000)} seconds.`
          : "\n服务暂时不可用或额度受限，请稍后重试并检查服务状态与额度。/ Check service availability and quota, then retry later."
        : "";
    throw new Error(`LLM 请求失败 / LLM request failed (HTTP ${res.status}): ${modelErrorDetail(text, llm.apiKey)}${hint}`);
  }
  const envelope = readChatEnvelope(text);
  if (!envelope) throw new Error("LLM 返回非 JSON 响应，请检查 Base URL。/ Non-JSON response; check the Base URL.");
  return envelope;
}

export async function chatComplete(llm: LlmConfig, system: string, user: string, signal?: AbortSignal, options: ChatRequestOptions = {}): Promise<string> {
  const temperature = options.temperature;
  const budget = llmRequestBudget(isLocalBaseUrl(llm.baseUrl) ? LLM_LOCAL_TIMEOUT_MS : LLM_REMOTE_TIMEOUT_MS, 1);
  let includeThinkingParam = Object.keys(thinkingParams(llm.model)).length > 0;
  let firstMaxTokens = MAX_TOKENS;
  const attempt = (maxTokens: number): Promise<ChatAttempt> =>
    chatAttempt(llm, system, user, signal, maxTokens, budget, includeThinkingParam, temperature);
  let first: ChatAttempt;
  try {
    first = await attempt(firstMaxTokens);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 供应商按自己的模型上限拒了 max_tokens：降档重发，别让预算上调反而打不通。
    if (isMaxTokensRejection(message)) {
      firstMaxTokens = FALLBACK_MAX_TOKENS;
      first = await attempt(firstMaxTokens);
    } else if (includeThinkingParam && /HTTP 400/i.test(message) && /thinking|unknown parameter|unsupported/i.test(message)) {
      includeThinkingParam = false;
      first = await attempt(firstMaxTokens);
    } else {
      throw e;
    }
  }
  if (first.content) return first.content;
  // finish_reason=length 表示思考把预算烧光了，正文还没开始写——这是预算问题不是模型问题，
  // 必须先加大预算重发。在这里抛错等于把一次本来能成的调用判死刑。
  if (options.rejectReasoningFallback && first.reasoning && first.finishReason !== "length") {
    throw new LlmReasoningOnlyError();
  }
  if (first.reasoning && first.finishReason !== "length") return first.reasoning;
  let retry: ChatAttempt | null = null;
  try {
    retry = await attempt(RETRY_MAX_TOKENS);
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e instanceof LlmTransportError) throw e;
    if (isMaxTokensRejection(e instanceof Error ? e.message : String(e))) {
      try {
        retry = await attempt(Math.max(firstMaxTokens, FALLBACK_MAX_TOKENS));
      } catch { /* 降档也失败就走下面的统一提示。 */ }
    }
  }
  if (retry?.content) return retry.content;
  // 加大到 RETRY_MAX_TOKENS 仍然只有思考没有正文，才算实锤这个模型给不出结构化输出。
  if (options.rejectReasoningFallback && retry?.reasoning) throw new LlmReasoningOnlyError();
  if (retry?.reasoning && retry.finishReason !== "length") return retry.reasoning;
  const filtered = first.finishReason === "content_filter" || retry?.finishReason === "content_filter";
  const thinking =
    Boolean(first.reasoning || retry?.reasoning) ||
    first.finishReason === "length" ||
    retry?.finishReason === "length";
  const hint = filtered
    ? "内容被服务商的安全审查拦截了,请换一家供应商或换一段素材。/ Blocked by the provider's content filter — try another provider or different footage."
    : thinking
      ? "当前模型是「深度思考」模型,思考过程就把输出预算烧完了。请在模型列表换它的非思考版本(通常带 instruct/chat 字样,或平台上可关闭深度思考),或换常规对话模型。/ This is a reasoning model that spends the whole output budget thinking — switch to its non-thinking variant (usually named instruct/chat) or a regular chat model."
      : "服务商返回了空内容,可点重试;若持续出现请换个模型。/ The provider returned empty content — retry, or switch models if it persists.";
  throw new Error(`LLM 未返回内容 / empty LLM response\n${hint}`);
}

export async function chatCompleteJson<T>(
  llm: LlmConfig,
  system: string,
  user: string,
  parse: (content: string) => T,
  signal?: AbortSignal,
  options: ChatRequestOptions = {}
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < JSON_ATTEMPTS; i++) {
    const content = await chatComplete(llm, system, user, signal, options);
    try {
      return parse(content);
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}
