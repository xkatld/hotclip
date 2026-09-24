import { describe, it, expect } from "vitest";
import {
  planFrameTimes,
  parseSheetVerdicts,
  parseEnergy,
  sanitizeVisibleText,
  sheetUserPrompt,
  visualPeakRanges,
  collectVisionSignal,
  VISION_MAX_FRAMES,
  VISION_MIN_SPACING_SEC,
  type VisionChatFn,
} from "../highlight/vision";
import type { MediaSignals } from "../signals";

describe("planFrameTimes", () => {
  it("无信号时均匀铺满全片且不超上限", () => {
    const times = planFrameTimes(600, undefined);
    expect(times.length).toBe(VISION_MAX_FRAMES);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(VISION_MIN_SPACING_SEC);
    }
    expect(times[0]).toBeGreaterThanOrEqual(0.5);
    expect(times[times.length - 1]).toBeLessThanOrEqual(599.5);
  });

  it("信号窗口中点优先入选", () => {
    const signals: MediaSignals = {
      loudPeaks: [{ startSec: 100, endSec: 110 }],
      cutDense: [{ startSec: 300, endSec: 320 }],
    };
    const times = planFrameTimes(600, signals);
    expect(times).toContain(105); // loudPeaks 中点
    expect(times).toContain(310); // cutDense 中点
  });

  it("信号中点彼此太近时只保留一个(最小间隔)", () => {
    const signals: MediaSignals = {
      loudPeaks: [{ startSec: 100, endSec: 104 }],
      cutDense: [{ startSec: 101, endSec: 105 }], // 中点 103,与 102 相距 1s
    };
    const times = planFrameTimes(600, signals);
    const near = times.filter((t) => t >= 100 && t <= 105);
    expect(near.length).toBe(1);
  });

  it("大量运动代表时刻最多占三分之二额度,仍保留全片均匀覆盖", () => {
    const signals: MediaSignals = {
      loudPeaks: [],
      cutDense: [],
      activityKeyframes: Array.from({ length: 40 }, (_, index) => ({ t: 10 + index * 9, score: 1 - index / 100 })),
    };
    const times = planFrameTimes(600, signals, 27, 8);
    expect(times).toHaveLength(27);
    expect(times.some((time) => time > 500)).toBe(true);
  });

  it("短片额度自动缩水,时刻夹在片内", () => {
    const times = planFrameTimes(20, undefined);
    expect(times.length).toBeGreaterThan(0);
    expect(times.length).toBeLessThan(VISION_MAX_FRAMES);
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(0.5);
      expect(t).toBeLessThanOrEqual(19.5);
    }
  });

  it("时长无效时返回空", () => {
    expect(planFrameTimes(0, undefined)).toEqual([]);
    expect(planFrameTimes(-5, undefined)).toEqual([]);
  });
});

describe("parseSheetVerdicts", () => {
  it("保留短而去重的高置信屏显文字,忽略垃圾并封顶", () => {
    const content = JSON.stringify({
      cells: [{ i: 1, energy: 7, note: "产品特写", visibleText: ["  HotClip  ", "hotclip", "无文字", 3, "¥19.9", "A", "B", "C", "D"] }],
    });
    expect(parseSheetVerdicts(content, 1)).toEqual([
      { i: 1, energy: 7, note: "产品特写", visibleText: ["HotClip", "¥19.9", "A", "B", "C"] },
    ]);
    expect(sanitizeVisibleText("not-an-array")).toEqual([]);
  });
  it("解析标准九宫格批量输出", () => {
    const content = '{"cells":[{"i":1,"energy":8,"note":"两人激烈争论"},{"i":2,"energy":3,"note":"静态口播"}]}';
    expect(parseSheetVerdicts(content, 9)).toEqual([
      { i: 1, energy: 8, note: "两人激烈争论" },
      { i: 2, energy: 3, note: "静态口播" },
    ]);
  });

  it("剥掉 think 块与包裹文本后仍能解析", () => {
    const content = '<think>先看第一格…</think>结果:{"cells":[{"i":1,"energy":3,"note":"口播"}]}';
    expect(parseSheetVerdicts(content, 9)).toEqual([{ i: 1, energy: 3, note: "口播" }]);
  });

  it("越界格号丢弃、重复格取首个、energy 夹回 0-10", () => {
    const content =
      '{"cells":[{"i":0,"energy":9},{"i":10,"energy":9},{"i":2,"energy":99},{"i":2,"energy":1},{"i":3,"energy":-4}]}';
    expect(parseSheetVerdicts(content, 9)).toEqual([
      { i: 2, energy: 10, note: "" },
      { i: 3, energy: 0, note: "" },
    ]);
  });

  it("cellCount 之外的格被过滤(最后一张不满格)", () => {
    const content = '{"cells":[{"i":1,"energy":5},{"i":8,"energy":5}]}';
    expect(parseSheetVerdicts(content, 2)).toEqual([{ i: 1, energy: 5, note: "" }]);
  });

  it("垃圾输出返回 null", () => {
    expect(parseSheetVerdicts("这一批都很精彩", 9)).toBeNull();
    expect(parseSheetVerdicts('{"cells":"没有数组"}', 9)).toBeNull();
    expect(parseSheetVerdicts('{"cells":[{"i":1,"note":"没有分数"}]}', 9)).toBeNull();
    expect(parseSheetVerdicts("", 9)).toBeNull();
  });
});

/**
 * 下面这些正文是 2026-09-23 对 htai91 网关上 claude-sonnet-5 / glm-5.3-flash /
 * kimi-k3 / deepseek-flash 实际调用抓回来的原样输出。
 * 实测 28 次成功调用无一返回 JSON —— 全是 Markdown,表格与列表才是主路径。
 */
describe("parseSheetVerdicts 读真实模型输出", () => {
  it("读多余打分列的表格,只取综合能量那一列", () => {
    const content = `## 逐格爆点能量评估

| 格 | 时刻 | 画面内容 | 视觉冲击 | 情绪张力 | 综合能量 | 性质 |
|---|---|---|---|---|---|---|
| 1 | 00:03 | 深色首屏,橙色 CTA | 5 | 6 | **5.5** | 承诺型钩子 |
| 2 | 00:12 | 「选择转写引擎」表单列表 | 2.5 | 3 | **3.0** | 能量谷底 |
| 7 | 00:57 | 爆炸粒子 + 手机矩阵 | 9 | 8.5 | **9.0** | 全片最高能 |`;
    expect(parseSheetVerdicts(content, 9)).toEqual([
      { i: 1, energy: 5.5, note: "深色首屏,橙色 CTA" },
      { i: 2, energy: 3, note: "「选择转写引擎」表单列表" },
      { i: 7, energy: 9, note: "爆炸粒子 + 手机矩阵" },
    ]);
  });

  it("读星级加十分制混写的表格", () => {
    const content = `| 格数 | 时刻 | 画面内容 | 能量值 | 评估说明 |
|------|------|---------|--------|---------|
| 1 | 00:03 | 上传长视频界面 | ★☆☆☆☆ (2/10) | 纯功能性UI |
| 2 | 00:12 | 选择转写引擎设置 | ★★☆☆☆ (4) | 配置类界面 |
| 3 | 00:21 | 数据分析图表 | **9.5 / 10** | 数据爆点 |`;
    expect(parseSheetVerdicts(content, 9)).toEqual([
      { i: 1, energy: 2, note: "上传长视频界面" },
      { i: 2, energy: 4, note: "选择转写引擎设置" },
      { i: 3, energy: 9.5, note: "数据分析图表" },
    ]);
  });

  it("kimi-k3 用百分制写分数时折回十分制", () => {
    const content = `| 格 | 时刻 | 画面内容 | 爆点能量 | 评估要点 |
|---|---|---|---|---|
| 1 | 00:03 | 上传页 | ★★★☆☆ (55) | 功能开场 |
| 3 | 00:21 | 分析看板 | ★★★★☆ (70) | 首个视觉回报点 |`;
    expect(parseSheetVerdicts(content, 9)).toEqual([
      { i: 1, energy: 5.5, note: "上传页" },
      { i: 3, energy: 7, note: "分析看板" },
    ]);
  });

  it("deepseek-flash 写成分块列表时按格分块读,分数在下一行也能对上", () => {
    const content = `基于您提供的 9 张画面截图,我为您逐格评估。

**1. 00:03（第1格）**
*   **画面内容**：深色背景的软件界面,中央一个橙色按钮。
*   **爆点能量：低（⭐）**
*   **分析**：典型的引导入口画面。

**3. 00:21（第3格）**
*   **画面内容**：波形分析图 + 92分评分面板。
*   **爆点能量：中高（7/10）**
*   **分析**：首个视觉回报点。`;
    // 「画面内容:…92分评分面板」里的 92 不能被当成分数读成 9.2
    expect(parseSheetVerdicts(content, 9)).toEqual([
      { i: 1, energy: 1, note: "深色背景的软件界面,中央一个橙色按钮。" },
      { i: 3, energy: 7, note: "波形分析图 + 92分评分面板。" },
    ]);
  });

  it("超过百分制的数字判为读错,不夹成 10 顶成最高能帧", () => {
    expect(parseEnergy("**250**")).toBeNull();
    expect(parseEnergy("能量爆表")).toBeNull();
    expect(parseEnergy("")).toBeNull();
  });

  it("认得实测见过的各种分数写法", () => {
    expect(parseEnergy("2.5/10")).toBe(2.5);
    expect(parseEnergy("⚡ 2.5/10")).toBe(2.5);
    expect(parseEnergy("**3.0 / 10**")).toBe(3);
    expect(parseEnergy("★★☆☆☆ (2)")).toBe(2);
    expect(parseEnergy("⭐⭐")).toBe(2);
    expect(parseEnergy("★★★☆☆")).toBe(6);
    expect(parseEnergy("55/100")).toBe(5.5);
  });
});

describe("sheetUserPrompt", () => {
  it("报出每格的 mm:ss 时刻", () => {
    const p = sheetUserPrompt([65, 130.6]);
    expect(p).toContain("1=01:05");
    expect(p).toContain("2=02:10");
  });
});

describe("visualPeakRanges", () => {
  it("高能帧扩成时段并按间隔合并", () => {
    const ranges = visualPeakRanges(
      [
        { t: 100, energy: 8 },
        { t: 106, energy: 9 }, // 与上一段间隔 < merge gap → 并段
        { t: 300, energy: 7 },
        { t: 50, energy: 3 }, // 低于阈值,忽略
      ],
      600
    );
    expect(ranges.length).toBe(2);
    expect(ranges[0].startSec).toBeCloseTo(96.5);
    expect(ranges[0].endSec).toBeCloseTo(109.5);
    expect(ranges[1].startSec).toBeCloseTo(296.5);
  });

  it("时段夹在 [0, duration] 内", () => {
    const ranges = visualPeakRanges([{ t: 1, energy: 9 }, { t: 599, energy: 9 }], 600);
    expect(ranges[0].startSec).toBe(0);
    expect(ranges[ranges.length - 1].endSec).toBe(600);
  });

  it("没有高能帧返回空数组", () => {
    expect(visualPeakRanges([{ t: 10, energy: 2 }], 600)).toEqual([]);
  });
});

describe("collectVisionSignal (接触表批量)", () => {
  const config = { baseUrl: "http://localhost:11434/v1", model: "qwen3-vl:4b" };
  const okSheet = async (): Promise<string> => "ZmFrZQ=="; // "fake" 的 base64
  /** 满格九个分的批量输出(不满格由解析端按 cellCount 过滤)。 */
  const cellsJson = (energy: number): string =>
    JSON.stringify({ cells: Array.from({ length: 9 }, (_, k) => ({ i: k + 1, energy, note: "" })) });

  it("正常路径:一表九帧批量研判并圈出高能时段", async () => {
    let calls = 0;
    const chat: VisionChatFn = async () => {
      calls++;
      return cellsJson(9);
    };
    const outcome = await collectVisionSignal({
      videoPath: "/v.mp4",
      durationSec: 300,
      config,
      composeSheet: okSheet,
      chat,
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.stats.framesScored).toBe(outcome!.stats.framesTotal);
    // 27 帧只用 3 次调用——接触表批量的意义所在
    expect(calls).toBe(Math.ceil(outcome!.stats.framesTotal / 9));
    expect(outcome!.visualPeaks.length).toBeGreaterThan(0);
    expect(outcome!.stats.peakCount).toBe(outcome!.visualPeaks.length);
  });

  it("把选中视频轨与颜色预览契约传给每张接触表", async () => {
    const seen: unknown[] = [];
    await collectVisionSignal({
      videoPath: "/v.mkv",
      durationSec: 30,
      config,
      analysis: { videoStreamIndex: 4 },
      composeSheet: async (_path, _times, analysis) => {
        seen.push(analysis);
        return "jpeg";
      },
      chat: async () => cellsJson(8),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((value) => (value as { videoStreamIndex?: number }).videoStreamIndex === 4)).toBe(true);
  });

  it("端点全挂 → fail-open 返回 null", async () => {
    const chat: VisionChatFn = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const outcome = await collectVisionSignal({
      videoPath: "/v.mp4",
      durationSec: 300,
      config,
      composeSheet: okSheet,
      chat,
    });
    expect(outcome).toBeNull();
  });

  it("个别表失败不影响整体", async () => {
    let n = 0;
    const chat: VisionChatFn = async () => {
      n++;
      if (n === 2) throw new Error("单表超时");
      return cellsJson(2);
    };
    const outcome = await collectVisionSignal({
      videoPath: "/v.mp4",
      durationSec: 300,
      config,
      composeSheet: okSheet,
      chat,
    });
    expect(outcome).not.toBeNull();
    expect(outcome!.stats.framesScored).toBeLessThan(outcome!.stats.framesTotal);
    expect(outcome!.visualPeaks).toEqual([]); // 全是低分,不给假信号
  });

  it("拼图全失败(如纯音频) → null", async () => {
    const chat: VisionChatFn = async () => cellsJson(9);
    const outcome = await collectVisionSignal({
      videoPath: "/audio.mp3",
      durationSec: 300,
      config,
      composeSheet: async () => null,
      chat,
    });
    expect(outcome).toBeNull();
  });

  it("上游取消原样上抛", async () => {
    const ac = new AbortController();
    ac.abort();
    const chat: VisionChatFn = async () => cellsJson(5);
    await expect(
      collectVisionSignal({
        videoPath: "/v.mp4",
        durationSec: 300,
        config,
        signal: ac.signal,
        composeSheet: okSheet,
        chat,
      })
    ).rejects.toThrow();
  });

  it("预算耗尽带着已得结果收工", async () => {
    let calls = 0;
    const chat: VisionChatFn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 40));
      return cellsJson(8);
    };
    const outcome = await collectVisionSignal({
      videoPath: "/v.mp4",
      durationSec: 600,
      config,
      composeSheet: okSheet,
      chat,
      budgetMs: 30, // 只够跑一张表
    });
    expect(calls).toBeLessThan(Math.ceil(VISION_MAX_FRAMES / 9));
    // 首张表总能完成 → 至少九帧在手,信号成立
    expect(outcome).not.toBeNull();
    expect(outcome!.stats.framesScored).toBeGreaterThanOrEqual(9);
    expect(outcome!.stats.framesScored).toBeLessThan(outcome!.stats.framesTotal);
  });
});
