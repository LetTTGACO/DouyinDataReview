import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DouyinCollector } from "./douyinCollector.mjs";
import { CollectorStore } from "./store.mjs";
import { DirectHistoryError } from "./directHistory.mjs";

const NOW = Date.parse("2026-11-10T12:00:00+08:00");
const DAY = 86_400_000;
const cleanup = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanup.splice(0).map(work => work())); });
const watch = (id, days) => ({ aweme_id: id, create_time: 1_600_000_000, history_info: { view_time: (NOW - days * DAY) / 1_000 } });
const page = (items, more = false, cursor = "1") => ({ status_code: 0, aweme_list: items, has_more: Number(more), max_cursor: cursor, cursor });

async function fixture() {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const directory = await mkdtemp(path.join(tmpdir(), "dy-initial-records-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const store = new CollectorStore(directory);
  const collector = new DouyinCollector({ dataDirectory: directory, store });
  collector.snapshot = await store.load();
  collector.syncRunId = 1;
  collector.progressPersistIntervalMs = 0;
  const api = { request: vi.fn(async () => ({ status_code: 0, data: [], extra: { has_more: false } })),
    collectRecordPages: vi.fn(async (_type, onPage) => { await onPage(page([]), 1); return 1; }) };
  collector.ensureDirectApi = vi.fn(async () => api);
  collector.readDirectHistory = vi.fn(async () => page([]));
  collector.readCompletedWatchTimes = vi.fn(async () => null);
  collector.myComments.update = vi.fn(async () => undefined);
  return { collector, api, store, directory };
}

function lists(api, count, overlap = false) {
  api.collectRecordPages.mockImplementation(async (type, onPage) => {
    for (let n = 0; n < Math.ceil(count / 90); n++) {
      const items = Array.from({ length: Math.min(90, count - n * 90) }, (_, i) => ({ aweme_id: `${type}-${n * 90 + i}`,
        play_progress: { last_modified_time: 1_700_000_000 + i } }));
      if (overlap && n > 0) items.unshift({ aweme_id: `${type}-0` });
      if (!await onPage(page(items, (n + 1) * 90 < count, String(n + 1)), n + 1)) return n + 1;
    }
    return Math.ceil(count / 90);
  });
}

it("imports seven days of watches and exactly 200 unique likes/favorites, stopping remote pagination", async () => {
  const { collector, api, store } = await fixture();
  lists(api, 400, true);
  collector.readDirectHistory.mockImplementation(async (_api, cursor) => {
    if (cursor === "0") return page([watch("recent", 1), watch("cutoff", 7), { aweme_id: "undated", create_time: NOW / 1_000 }], true);
    if (cursor === "1") return page([watch("old", 8), watch("also-recent", 2)], true, "2");
    throw new Error("must stop at seven-day boundary");
  });
  await collector.runDirectRecords(1);
  const saved = await store.load();
  expect(saved.records.watch_history.map(r => r.videoId).sort()).toEqual(["also-recent", "cutoff", "recent"]);
  for (const type of ["liked_videos", "favorite_videos"]) {
    expect(saved.records[type]).toHaveLength(200);
    expect(new Set(saved.records[type].map(r => r.videoId))).toEqual(new Set(Array.from({ length: 200 }, (_, i) => `${type}-${i}`)));
  }
  expect(collector.readDirectHistory).toHaveBeenCalledTimes(2);
  expect(collector.readCompletedWatchTimes).toHaveBeenCalledWith(api, 1, NOW - 7 * DAY);
  expect(saved.directSync).toEqual({ watch_history: true, liked_videos: true, favorite_videos: true });
  expect(collector.status.message).toContain("最近 7 天");
  expect(collector.getNewRecords(0, 0).records).toHaveLength(403);
});

it("uses the stored initial boundary after restart, without capping subsequent incremental reads", async () => {
  const { collector, api, store } = await fixture();
  collector.readDirectHistory.mockResolvedValue(page([watch("known", 6)]));
  lists(api, 210);
  await collector.runDirectRecords(1);
  collector.snapshot = await store.load();
  vi.mocked(Date.now).mockReturnValue(NOW + 30 * DAY);
  collector.readDirectHistory.mockImplementation(async (_api, cursor) => cursor === "0"
    ? page([watch("new", -29)], true)
    : page([watch("gap", -10), watch("known", 6)], true, "2"));
  api.collectRecordPages.mockImplementation(async (type, onPage) => {
    for (let n = 0; n < 3; n++) {
      const items = Array.from({ length: 90 }, (_, i) => ({ aweme_id: `${type}-new-${n * 90 + i}` }));
      if (n === 2) items.push({ aweme_id: `${type}-0` });
      if (!await onPage(page(items, true, String(n + 1)), n + 1)) return n + 1;
    }
    throw new Error("must stop at known record");
  });
  await collector.runDirectRecords(1);
  expect(collector.snapshot.records.watch_history.map(r => r.videoId)).toEqual(["new", "gap", "known"]);
  expect(collector.snapshot.records.liked_videos).toHaveLength(470);
  expect(collector.snapshot.records.favorite_videos).toHaveLength(470);
  expect(collector.status.message).toContain("新增记录");
});

it("keeps existing local data during a bounded first read and allows an explicit complete read", async () => {
  const { collector, api, store } = await fixture();
  const local = (type, id) => ({ id: `${type}:${id}`, videoId: id, title: id, author: null, occurredAt: null, url: null });
  collector.snapshot = await store.save({ watch_history: [local("watch_history", "old-local-watch")],
    liked_videos: [local("liked_videos", "old-local-like")], favorite_videos: [local("favorite_videos", "old-local-favorite")] });
  lists(api, 270);
  collector.readDirectHistory.mockResolvedValue(page([watch("recent", 1), watch("old", 40)]));
  await collector.runDirectRecords(1);
  expect(collector.snapshot.records.liked_videos).toHaveLength(201);
  expect(collector.snapshot.records.favorite_videos).toHaveLength(201);
  expect(collector.snapshot.records.watch_history.map(r => r.videoId).sort()).toEqual(["old-local-watch", "recent"]);
  await collector.runDirectRecords(1, { full: true });
  expect(collector.snapshot.records.liked_videos).toHaveLength(270);
  expect(collector.snapshot.records.favorite_videos).toHaveLength(270);
  expect(collector.snapshot.records.watch_history.map(r => r.videoId).sort()).toEqual(["old", "old-local-watch", "recent"]);
  expect(collector.status.message).toContain("全部可见记录");
});

it("retries an interrupted initial read through its range instead of stopping at partially saved records", async () => {
  const { collector, store } = await fixture();
  collector.readDirectHistory.mockResolvedValueOnce(page([watch("partial", 1)], true))
    .mockRejectedValueOnce(new DirectHistoryError("rate_limited", "稍后重试"));
  await expect(collector.runDirectRecords(1)).rejects.toThrow("稍后重试");
  collector.snapshot = await store.load();
  expect(collector.snapshot.directSync.watch_history).toBe(false);
  collector.readDirectHistory.mockImplementation(async (_api, cursor) => cursor === "0"
    ? page([watch("partial", 1)], true)
    : page([watch("missing", 2), watch("old", 8)], true, "2"));
  await collector.runDirectRecords(1);
  expect(collector.snapshot.records.watch_history.map(r => r.videoId).sort()).toEqual(["missing", "partial"]);
  expect(collector.snapshot.directSync.watch_history).toBe(true);
});

it("recovers an interrupted incremental history read through its original boundary after restart", async () => {
  const { collector, store } = await fixture();
  collector.readDirectHistory.mockResolvedValue(page([watch("known", 6)]));
  await collector.runDirectRecords(1);
  // 最新的一条可能是直播，它不在视频观看历史接口里，不能拿它作恢复边界。
  collector.snapshot.records.watch_history.unshift({ id: "watch_history:live-anchor", videoId: "live-anchor", title: "直播", author: null,
    occurredAt: new Date(NOW).toISOString(), occurredAtSource: "platform_action", mediaType: "live", url: null });
  vi.mocked(Date.now).mockReturnValue(NOW + 30 * DAY);
  collector.readDirectHistory.mockResolvedValueOnce(page([watch("partial", -29)], true))
    .mockRejectedValueOnce(new DirectHistoryError("rate_limited", "稍后重试"));
  await expect(collector.runDirectRecords(1)).rejects.toThrow("稍后重试");
  collector.snapshot = await store.load();
  expect(collector.snapshot.pendingWatchHistoryBoundary).toContain("known");
  // 聊天和其他存盘操作也要保留恢复边界。
  await collector.saveSnapshot(snapshot => [snapshot.records, snapshot.warnings, { directSync: snapshot.directSync }]);
  collector.snapshot = await store.load();
  collector.readDirectHistory.mockImplementation(async (_api, cursor) => cursor === "0"
    ? page([watch("partial", -29)], true)
    : page([watch("missing", -10), watch("known", 6)], true, "2"));
  await collector.runDirectRecords(1);
  expect(collector.snapshot.records.watch_history.filter(r => r.mediaType !== "live").map(r => r.videoId)).toEqual(["partial", "missing", "known"]);
  expect(collector.snapshot.directSync.watch_history).toBe(true);
  expect((await store.load()).pendingWatchHistoryBoundary).toBeUndefined();
});

it("limits supplementary live history and completion scans to the same seven-day range", async () => {
  const { collector, api } = await fixture();
  const live = (id, days) => ({ UserLiveRecord: { user_id_str: id, nickname: "主播" }, latest_watch_time_str: String((NOW - days * DAY) * 1_000) });
  api.request.mockResolvedValue({ status_code: 0, data: [live("recent", 1), live("old", 8)], extra: { has_more: true, max_time_str: "1" } });
  await collector.runDirectRecords(1);
  expect(api.request).toHaveBeenCalledTimes(1);
  expect(collector.snapshot.records.watch_history.map(r => r.videoId)).toEqual(["live-recent"]);
  expect(collector.readCompletedWatchTimes).toHaveBeenCalledWith(api, 1, NOW - 7 * DAY);
});

it("does not scan undated history to the end or substitute publication times", async () => {
  const { collector } = await fixture();
  collector.readDirectHistory.mockResolvedValue(page([{ aweme_id: "undated", create_time: NOW / 1_000 }], true));
  await collector.runDirectRecords(1);
  expect(collector.readDirectHistory).toHaveBeenCalledTimes(1);
  expect(collector.snapshot.records.watch_history).toEqual([]);
  expect(collector.snapshot.directSync.watch_history).toBe(false);
  expect(collector.status.message).toContain("观看时间");
});
