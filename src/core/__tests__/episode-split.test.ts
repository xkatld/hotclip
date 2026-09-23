import { describe, it, expect } from "vitest";
import { parseBreaks, smartSplit, fixedSplit, manualSplit, snapToSentenceBoundary, formatEpisodeNumber, applyTitleTemplate, selectBreaksGlobal, enforceDuration, cleanReason, targetRange } from "../episode/split";
import type { Transcript, EpisodeSplitConfig } from "../../shared/api-types";
import { EPISODE_SPLIT_DEFAULTS } from "../../shared/api-types";

/** 简易逐句稿:每 60 秒一句,总时长 7200 秒(2 小时) */
function makeLongTranscript(durationSec = 7200, intervalSec = 60): Transcript {
  const segments = [];
  for (let t = 0; t < durationSec; t += intervalSec) {
    segments.push({
      startSec: t,
      endSec: t + intervalSec,
      text: `第 ${Math.floor(t / intervalSec) + 1} 句话。`,
      words: [],
    });
  }
  return { segments, durationSec, language: "zh" } as unknown as Transcript;
}

describe("parseBreaks", () => {
  it("parses valid JSON with breaks array", () => {
    const raw = '{"breaks":[{"segmentId":10,"timeSec":600,"reason":"话题切换","chapterTitle":"第二章"}]}';
    const breaks = parseBreaks(raw);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].timeSec).toBe(600);
    expect(breaks[0].chapterTitle).toBe("第二章");
  });

  it("unwraps a raw OpenAI response envelope instead of reading the envelope itself", () => {
    const body = JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: '{"breaks":[{"segmentId":42,"timeSec":723.5,"reason":"转入实战","chapterTitle":"实战演示"}]}',
          },
        },
      ],
    });
    const breaks = parseBreaks(body);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].timeSec).toBe(723.5);
    expect(breaks[0].segmentId).toBe(42);
    expect(breaks[0].chapterTitle).toBe("实战演示");
  });

  it("accepts numeric strings and drops rows without a usable time", () => {
    const raw = '{"breaks":[{"timeSec":"600.5","chapterTitle":"A"},{"timeSec":"","chapterTitle":"B"},{"reason":"no time"}]}';
    const breaks = parseBreaks(raw);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].timeSec).toBe(600.5);
  });

  it("returns an empty list only when the model really reported no breaks", () => {
    expect(parseBreaks('{"breaks":[]}')).toEqual([]);
  });

  it("reads a Markdown table when the model ignores the strict-JSON instruction", () => {
    const raw = [
      "建议把这段 00:00～11:02 切成 **3 集**，采用以下两个断点：",
      "",
      "| 断点 | 位置 | 时间戳 | 说明 |",
      "|---|---|---|---|",
      '| 断点 1 | 第 34 句之前 | **03:13** | 从"第一种方式：绑定 KV 命名空间"转入"设置环境变量 / UUID / 登录访问" |',
      '| 断点 2 | 第 62 句之前 | **06:31** | 从"第一种方式收尾"转入"清理与验证" |',
    ].join("\n");
    const breaks = parseBreaks(raw);
    expect(breaks).toHaveLength(2);
    expect(breaks[0].timeSec).toBe(193);
    expect(breaks[0].segmentId).toBe(34);
    expect(breaks[0].reason).toContain("KV 命名空间");
    expect(breaks[0].chapterTitle).toBe("");
    expect(breaks[1].timeSec).toBe(391);
    expect(breaks[1].segmentId).toBe(62);
  });

  it("reads a table that carries the chapter title column", () => {
    const raw = [
      "| 时间 | 章节 | 理由 |",
      "|---|---|---|",
      "| 12:30 | 环境变量配置 | 从概念转入实操 |",
    ].join("\n");
    const breaks = parseBreaks(raw);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].timeSec).toBe(750);
    expect(breaks[0].chapterTitle).toBe("环境变量配置");
    expect(breaks[0].reason).toBe("从概念转入实操");
  });

  it("reads a headerless table by picking the column that holds a timestamp", () => {
    const raw = ["| 断点 1 | 第 8 句 | 01:05 |", "| 断点 2 | 第 20 句 | 02:40 |"].join("\n");
    const breaks = parseBreaks(raw);
    expect(breaks.map((b) => b.timeSec)).toEqual([65, 160]);
    expect(breaks[0].segmentId).toBe(8);
  });

  it("falls back to loose timestamp lines when there is no table", () => {
    const raw = ["这段可以切成两集：", "- 03:13 从 KV 绑定转入环境变量配置", "- 06:31 转入清理与验证"].join("\n");
    const breaks = parseBreaks(raw);
    expect(breaks).toHaveLength(2);
    expect(breaks[0].timeSec).toBe(193);
    expect(breaks[0].reason).toContain("KV 绑定");
  });

  it("throws on unparseable output so the caller can retry instead of silently falling back", () => {
    expect(() => parseBreaks("not json at all")).toThrow();
    expect(() => parseBreaks("{}")).toThrow();
    expect(() => parseBreaks('{"breaks":"nope"}')).toThrow();
  });

  it("sorts by timeSec", () => {
    const raw = '{"breaks":[{"timeSec":1200,"reason":"b","chapterTitle":"B"},{"timeSec":600,"reason":"a","chapterTitle":"A"}]}';
    const breaks = parseBreaks(raw);
    expect(breaks[0].timeSec).toBe(600);
    expect(breaks[1].timeSec).toBe(1200);
  });
});

describe("snapToSentenceBoundary", () => {
  const t = makeLongTranscript(600, 60);

  it("snaps to nearest sentence end", () => {
    // 句子结束于 60, 120, 180...
    expect(snapToSentenceBoundary(62, t)).toBe(60);
    expect(snapToSentenceBoundary(118, t)).toBe(120);
  });

  it("returns original time if no sentence within tolerance", () => {
    // tolerance 默认 5 秒,30 秒离最近句界太远
    expect(snapToSentenceBoundary(30, t, 2)).toBe(30);
  });
});

describe("fixedSplit", () => {
  it("splits 2h video into ~15min episodes", () => {
    const t = makeLongTranscript(7200);
    const eps = fixedSplit(t, { ...EPISODE_SPLIT_DEFAULTS, fixedIntervalSec: 900 });
    expect(eps.length).toBeGreaterThanOrEqual(7);
    expect(eps.length).toBeLessThanOrEqual(9);
    // 每集起止连续
    for (let i = 1; i < eps.length; i++) {
      expect(eps[i].startSec).toBe(eps[i - 1].endSec);
    }
    // 最后一集到达末尾
    expect(eps[eps.length - 1].endSec).toBe(7200);
  });

  it("merges short tail into last episode", () => {
    const t = makeLongTranscript(1000, 60);
    const eps = fixedSplit(t, { ...EPISODE_SPLIT_DEFAULTS, fixedIntervalSec: 900 });
    // 1000s / 900s = 1.1, 尾巴太短应该并入
    expect(eps).toHaveLength(1);
    expect(eps[0].endSec).toBe(1000);
  });
});

describe("smartSplit", () => {
  const RANGE: EpisodeSplitConfig = { ...EPISODE_SPLIT_DEFAULTS, targetMinSec: 600, targetMaxSec: 1200 };

  it("uses LLM breaks that already satisfy the target range", () => {
    const t = makeLongTranscript(3600);
    const breaks = [
      { segmentId: 20, timeSec: 1200, reason: "话题A结束", chapterTitle: "第二章" },
      { segmentId: 40, timeSec: 2400, reason: "话题B结束", chapterTitle: "第三章" },
    ];
    const eps = smartSplit(t, breaks, RANGE);
    expect(eps).toHaveLength(3);
    expect(eps[0].endSec).toBe(1200);
    expect(eps[1].startSec).toBe(1200);
    expect(eps[2].endSec).toBe(3600);
  });

  it("assigns chapterTitle to the episode that starts at the break, not the one before it", () => {
    const t = makeLongTranscript(3600);
    const breaks = [{ segmentId: 20, timeSec: 1200, reason: "转入实操", chapterTitle: "实操演示" }];
    const eps = smartSplit(t, breaks, { ...RANGE, targetMaxSec: 2400 });
    expect(eps[0].title).toBe("第 1 集");
    expect(eps[1].title).toBe("实操演示");
    expect(eps[1].reason).toBe("转入实操");
  });

  it("drops candidate breaks that would make an episode shorter than the minimum", () => {
    const t = makeLongTranscript(3600);
    // 每 2 分钟一个候选:照单全收会切出 29 集,每集只有 120 秒
    const breaks = Array.from({ length: 29 }, (_, i) => ({
      segmentId: (i + 1) * 2,
      timeSec: (i + 1) * 120,
      reason: "切换",
      chapterTitle: `章 ${i + 1}`,
    }));
    const eps = smartSplit(t, breaks, RANGE);
    expect(eps.length).toBeLessThanOrEqual(6);
    for (const ep of eps) {
      expect(ep.durationSec).toBeGreaterThanOrEqual(600);
      expect(ep.durationSec).toBeLessThanOrEqual(1200);
    }
  });

  it("force-cuts a stretch that has no candidate break inside it", () => {
    const t = makeLongTranscript(3600);
    // 只有一个候选,余下 2400 秒远超 targetMax
    const breaks = [{ segmentId: 20, timeSec: 1200, reason: "唯一切换", chapterTitle: "第二章" }];
    const eps = smartSplit(t, breaks, RANGE);
    expect(eps.length).toBeGreaterThanOrEqual(3);
    for (const ep of eps) {
      expect(ep.durationSec).toBeLessThanOrEqual(1200);
    }
    expect(eps[eps.length - 1].endSec).toBe(3600);
  });

  it("keeps episode boundaries contiguous and ids sequential after post-processing", () => {
    const t = makeLongTranscript(7200);
    const breaks = [
      { segmentId: 5, timeSec: 300, reason: "太早", chapterTitle: "A" },
      { segmentId: 60, timeSec: 3600, reason: "中段", chapterTitle: "B" },
    ];
    const eps = smartSplit(t, breaks, RANGE);
    expect(eps[0].startSec).toBe(0);
    expect(eps[eps.length - 1].endSec).toBe(7200);
    eps.forEach((ep, i) => {
      expect(ep.id).toBe(i + 1);
      if (i > 0) expect(ep.startSec).toBe(eps[i - 1].endSec);
    });
  });

  it("falls back to fixedSplit when no breaks", () => {
    const t = makeLongTranscript(7200);
    const eps = smartSplit(t, [], EPISODE_SPLIT_DEFAULTS);
    expect(eps.length).toBeGreaterThan(1);
  });
});

describe("selectBreaksGlobal", () => {
  it("prefers the candidate nearest the ideal length when several are available", () => {
    const range = targetRange({ ...EPISODE_SPLIT_DEFAULTS, targetMinSec: 600, targetMaxSec: 1200 });
    const candidates = [700, 900, 1100, 1800, 2000, 2700].map((timeSec) => ({
      segmentId: 0, timeSec, reason: "", chapterTitle: "",
    }));
    const picked = selectBreaksGlobal(candidates, 3600, range);
    expect(picked.map((p) => p.timeSec)).toContain(900);
    expect(picked.map((p) => p.timeSec)).not.toContain(700);
  });

  it("returns nothing when there are no candidates", () => {
    const range = targetRange(EPISODE_SPLIT_DEFAULTS);
    expect(selectBreaksGlobal([], 3600, range)).toEqual([]);
  });
});

describe("cleanReason", () => {
  it("drops clauses that carry the model's deliberation", () => {
    expect(cleanReason("从概念转入实操。建议在此断开,若时长不足可合并")).toBe("从概念转入实操");
  });

  it("returns empty when every clause is deliberation", () => {
    expect(cleanReason("建议切在这里。符合目标时长范围")).toBe("");
  });

  it("truncates to 40 characters", () => {
    expect(cleanReason("话题切换".repeat(20)).length).toBe(40);
  });
});

describe("enforceDuration", () => {
  const range = targetRange({ ...EPISODE_SPLIT_DEFAULTS, targetMinSec: 600, targetMaxSec: 1200 });

  it("merges a too-short episode into the shorter neighbour", () => {
    const t = makeLongTranscript(3600);
    const eps = [
      { id: 1, title: "A", startSec: 0, endSec: 1100, durationSec: 1100, reason: "" },
      { id: 2, title: "B", startSec: 1100, endSec: 1200, durationSec: 100, reason: "" },
      { id: 3, title: "C", startSec: 1200, endSec: 3600, durationSec: 2400, reason: "" },
    ];
    const out = enforceDuration(eps, t, [], range);
    for (const ep of out) {
      expect(ep.durationSec).toBeGreaterThanOrEqual(600);
      expect(ep.durationSec).toBeLessThanOrEqual(1200);
    }
    expect(out[out.length - 1].endSec).toBe(3600);
  });
});

describe("manualSplit", () => {
  it("splits at user-given breakpoints", () => {
    const t = makeLongTranscript(3600);
    const eps = manualSplit(t, [1200, 2400]);
    expect(eps).toHaveLength(3);
    expect(eps[0].endSec).toBe(1200);
    expect(eps[1].startSec).toBe(1200);
    expect(eps[1].endSec).toBe(2400);
    expect(eps[2].endSec).toBe(3600);
  });

  it("deduplicates and sorts breakpoints", () => {
    const t = makeLongTranscript(3600);
    const eps = manualSplit(t, [2400, 1200, 2400, 1200]);
    expect(eps).toHaveLength(3);
  });
});

describe("formatEpisodeNumber", () => {
  it("formats P{n}", () => expect(formatEpisodeNumber(3, "P{n}", 10)).toBe("P3"));
  it("formats 第{n}集", () => expect(formatEpisodeNumber(3, "第{n}集", 10)).toBe("第3集"));
  it("formats {nn} with padding", () => expect(formatEpisodeNumber(3, "{nn}", 100)).toBe("003"));
  it("formats {n}", () => expect(formatEpisodeNumber(3, "{n}", 10)).toBe("3"));
});

describe("applyTitleTemplate", () => {
  it("fills template placeholders", () => {
    expect(applyTitleTemplate("【{prefix}】{number} {title}", "弱口令", "P1", "入门基础"))
      .toBe("【弱口令】P1 入门基础");
  });
});
