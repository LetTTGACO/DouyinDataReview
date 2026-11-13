import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toolNamed } from "./tools.mjs";
import { CollectorStore } from "../store.mjs";
import { startCollectorServer } from "../server.mjs";
import { createEmptyRecords } from "../normalizer.mjs";

function read(messages, args = {}) {
  const collector = { snapshot: { chatMessages: messages }, assertReadPermission: vi.fn() };
  const api = vi.fn(() => { throw new Error("local reads must not use the network"); });
  return { collector, api, result: toolNamed("read_chat").run({ collector: () => collector, api }, { conversationId: "group", ...args }) };
}
const message = (id, extra = {}) => ({ id, conversationId: "group", conversationType: "group", senderName: "群成员", sentAt: `2026-11-10T00:${id.padStart(2, "0")}:00Z`, type: "text", text: null, ...extra });

describe("read_chat saved attachments", () => {
  it("keeps the legacy share title and exposes video metadata for follow-up tools without network requests", async () => {
    const share = { title: "示例视频", author: "示例作者", coverUrl: "https://p3.douyinpic.com/cover.jpg", url: "https://www.douyin.com/video/7123456789012345678" };
    const { result, collector, api } = read([message("1", { type: "share", text: "示例视频", share })]);
    expect(await result).toMatchObject({ ok: true, total: 1, items: [{ id: "1", sender: "群成员", kind: "share", text: "示例视频", shared: "示例视频",
      share: { ...share, videoId: "7123456789012345678" } }] });
    expect(collector.assertReadPermission).toHaveBeenCalledWith("chat");
    expect(api).not.toHaveBeenCalled();
  });

  it("returns saved image, sticker and shared comment attachments while preserving conversation/time pagination", async () => {
    const comment = { id: "comment-1", author: "评论作者", text: "评论正文", mediaUrl: "https://p3.douyinpic.com/comment.jpg", mediaType: "image", sourceType: "video" };
    const messages = [message("1", { type: "image", mediaUrl: "https://p3.douyinpic.com/image.jpg" }),
      message("2", { type: "sticker", mediaUrl: "https://p3.douyinpic.com/sticker.gif" }),
      message("3", { type: "comment", comment, share: { title: "来源视频", url: "https://www.douyin.com/video/7123456789012345678" } }),
      message("4", { text: "较新消息" }), message("5", { conversationId: "another", text: "其他群消息" })];
    const { result } = read(messages, { before: "2026-11-10T00:04:00Z", limit: 2 });
    expect(await result).toMatchObject({ total: 3, items: [{ id: "2", mediaUrl: "https://p3.douyinpic.com/sticker.gif" },
      { id: "3", kind: "comment", comment, share: { title: "来源视频", url: "https://www.douyin.com/video/7123456789012345678", videoId: "7123456789012345678" } }] });
    expect((await read(messages, { limit: 1, before: "2026-11-10T00:02:00Z" }).result).items[0].mediaUrl).toBe("https://p3.douyinpic.com/image.jpg");
  });

  it("retains short links and incomplete shares without inventing video IDs or returning credential material", async () => {
    const short = "https://v.douyin.com/example/";
    const { result } = read([message("1", { type: "share", share: { title: null, author: "作者", coverUrl: null, url: short, privateToken: "do-not-return" } }),
      message("2", { type: "voice", voiceResource: { skey: "do-not-return" }, raw: "do-not-return" }),
      message("3", { type: "share", share: { title: "旧分享标题" } }), message("4", { text: "普通文字" })]);
    const output = await result;
    expect(output.items[0].share).toEqual({ title: null, author: "作者", coverUrl: null, url: short });
    expect(output.items[2]).toMatchObject({ shared: "旧分享标题", share: { title: "旧分享标题", author: null, coverUrl: null, url: null } });
    expect(output.items[3]).not.toHaveProperty("share");
    expect(JSON.stringify(output)).not.toMatch(/do-not-return|voiceResource|privateToken/);
  });

  it("uses the same metadata for friend conversations and does not infer IDs from unrelated hosts", async () => {
    const { result } = read([message("1", { conversationId: "friend", conversationType: "friend", type: "share",
      share: { url: "https://example.com/video/7123456789012345678" } })], { conversationId: "friend" });
    expect((await result).items[0].share).not.toHaveProperty("videoId");
  });

  it("returns saved group share metadata through the actual authenticated MCP endpoint", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dy-read-chat-mcp-"));
    let server;
    try {
      const share = { title: "群聊视频", author: "视频作者", coverUrl: "https://p3.douyinpic.com/cover.jpg", url: "https://www.douyin.com/video/7123456789012345678" };
      const store = new CollectorStore(dir);
      await store.groupChatStorage.save(["101"]);
      await store.save(createEmptyRecords(), [], { chatConversations: [{ id: "101", kind: "group", name: "测试群" }],
        chatMessages: [message("1", { conversationId: "101", senderId: "111", senderName: null, type: "share", share })] });
      server = await startCollectorServer({ port: 0, dataDirectory: dir, browserSources: [], desktopSupported: false });
      await fetch(`${server.baseUrl}/mcp`, { method: "POST", body: "{}" });
      const secret = (await readFile(path.join(dir, "mcp-token"), "utf8")).trim();
      const response = await fetch(`${server.baseUrl}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_chat", arguments: { conversationId: "101" } } }) });
      expect(response.status).toBe(200);
      const rpc = await response.json();
      expect(rpc.result.isError).toBe(false);
      const result = JSON.parse(rpc.result.content[0].text);
      expect(result).toMatchObject({ ok: true, total: 1, items: [{ sender: "对方", senderId: "111", kind: "share", shared: "群聊视频", share: { ...share, videoId: "7123456789012345678" } }] });
    } finally {
      await server?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
