import { describe, it, expect } from "vitest";
import { parseBreaks, smartSplit, fixedSplit, manualSplit, snapToSentenceBoundary, formatEpisodeNumber, applyTitleTemplate } from "../episode/split";
import type { Transcript, EpisodeSplitConfig } from "../../shared/api-types";
import { EPISODE_SPLIT_DEFAULTS } from "../../shared/api-types";

/** 简易逐句稿:每 60 秒一句,总时长 7200 秒(2 小时)�� */
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
  return { segments, durationSec, language: "zh" } as Transcript;
}

describe("parseBreaks", () => {
  it("parses valid JSON with breaks array", () => {
    const raw = '{"breaks":[{"segmentId":10,"timeSec":600,"reason":"话题切换","chapterTitle":"第二章"}]}';
    const breaks = parseBreaks(raw);
    expect(breaks).toHaveLength(1);
    expect(breaks[0].timeSec).toBe(600);
    expect(breaks[0].chapterTitle).toBe("第二章");
  });

  it("returns empty on garbage input", () => {
    expect(parseBreaks("not json at all")).toEqual([]);
    expect(parseBreaks("{}")).toEqual([]);
    expect(parseBreaks('{"breaks":"nope"}')).toEqual([]);
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
  it("uses LLM breaks when available", () => {
    const t = makeLongTranscript(3600);
    const breaks = [
      { segmentId: 10, timeSec: 600, reason: "话题A结束", chapterTitle: "第二章" },
      { segmentId: 20, timeSec: 1200, reason: "话题B结束", chapterTitle: "第三章" },
    ];
    const eps = smartSplit(t, breaks, EPISODE_SPLIT_DEFAULTS);
    expect(eps).toHaveLength(3);
    expect(eps[0].endSec).toBe(600);
    expect(eps[1].startSec).toBe(600);
    expect(eps[2].endSec).toBe(3600);
  });

  it("falls back to fixedSplit when no breaks", () => {
    const t = makeLongTranscript(7200);
    const eps = smartSplit(t, [], EPISODE_SPLIT_DEFAULTS);
    expect(eps.length).toBeGreaterThan(1);
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
