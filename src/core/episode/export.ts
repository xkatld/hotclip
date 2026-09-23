/**
 * 分集导出:把每集从源视频中切出为独立 mp4。
 * 优先 stream copy(无损秒切),断点不在关键帧时自动 re-encode。
 * 复用 core/cut.ts 做实际 ffmpeg 调用。
 */
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { Transcript, EpisodeCandidate, EpisodeExportResult, EpisodeSplitConfig } from "../../shared/api-types";
import { cutClip } from "../cut";
import { sanitizeFilename } from "../export";
import { buildSrt, srtLinesFromWords } from "../srt";
import { sliceWords } from "../subtitle";

/** 分集导出进度回调。 */
export interface EpisodeExportProgress {
  current: number;
  total: number;
  episode: EpisodeCandidate;
}

/**
 * 导出选中的分集。返回每集的导出结果。
 * 优先 stream copy;字幕相关选项需要 re-encode。
 */
export async function exportEpisodes(
  inputPath: string,
  episodes: EpisodeCandidate[],
  transcript: Transcript,
  outDir: string,
  config: EpisodeSplitConfig,
  options?: {
    fontsDir?: string;
    signal?: AbortSignal;
    onProgress?: (p: EpisodeExportProgress) => void;
  }
): Promise<EpisodeExportResult[]> {
  await mkdir(outDir, { recursive: true });

  const results: EpisodeExportResult[] = [];

  // 生成 episodes.json 元数据
  const meta = episodes.map((ep) => ({
    id: ep.id,
    title: ep.title,
    startSec: ep.startSec,
    endSec: ep.endSec,
    durationSec: ep.durationSec,
  }));
  await writeFile(join(outDir, "episodes.json"), JSON.stringify(meta, null, 2), "utf-8");

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    options?.signal?.throwIfAborted();
    options?.onProgress?.({ current: i + 1, total: episodes.length, episode: ep });

    // ep.title 由 enrichEpisodeTitles 组装,集号已经在里面,这里再拼一次会出现 "01 01 标题"
    const safeName = sanitizeFilename(ep.title, `episode-${ep.id}`);
    const outputPath = join(outDir, `${safeName}.mp4`);

    // 分集是完整内容,不做跳剪/不裁画幅/不加字幕烧录——原样切出
    // 优先 stream copy(mode: "copy"),速度极快;如果 copy 失败 cutClip 内部会回退 re-encode
    await cutClip(inputPath, outputPath, ep.startSec, ep.endSec, {
      mode: "copy",
    }, options?.signal);

    const result: EpisodeExportResult = {
      id: ep.id,
      title: ep.title,
      outputPath,
      startSec: ep.startSec,
      endSec: ep.endSec,
      durationSec: ep.durationSec,
    };

    // 可选:导出 SRT 字幕文件
    if (config.srtFile) {
      const words = sliceWords(transcript, ep.startSec, ep.endSec);
      if (words.length > 0) {
        // SRT 时间戳需要相对于本集起点(0 开始)
        const shifted = words.map((w) => ({ ...w, startSec: w.startSec - ep.startSec, endSec: w.endSec - ep.startSec }));
        const srtContent = buildSrt(srtLinesFromWords(shifted));
        const srtPath = join(outDir, `${safeName}.srt`);
        await writeFile(srtPath, srtContent, "utf-8");
        result.srtPath = srtPath;
      }
    }

    results.push(result);
  }

  return results;
}
