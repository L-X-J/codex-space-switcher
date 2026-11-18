import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAllowedHosts,
  checkControlToken,
  checkCrossSite,
  checkHost,
  generateControlToken,
  injectControlToken,
} from "./local-request-guard.ts";

/**
 * 本文件验证本地请求来源校验，确保 CSRF 与 DNS rebinding 被拦截，
 * 同时不误伤 Codex CLI / App 这类没有浏览器 Origin 的客户端。
 */

const hosts = buildAllowedHosts("127.0.0.1", 14318, "");
const url = new URL("http://127.0.0.1:14318/api/accounts");

test("checkHost 放行本机地址，拒绝 DNS rebinding 域名", () => {
  assert.equal(checkHost({ headers: { host: "127.0.0.1:14318" } }, hosts).ok, true);
  assert.equal(checkHost({ headers: { host: "localhost:14318" } }, hosts).ok, true);
  assert.equal(checkHost({ headers: { host: "evil.example:14318" } }, hosts).ok, false);
  assert.equal(checkHost({ headers: { host: "127.0.0.1:80" } }, hosts).ok, false);
  assert.equal(checkHost({ headers: {} }, hosts).ok, false);
});

test("buildAllowedHosts 支持环境变量追加，且不把 0.0.0.0 当成合法 Host", () => {
  const extra = buildAllowedHosts("0.0.0.0", 14318, "my-pc.lan, 10.0.0.5:9000");
  assert.equal(extra.has("0.0.0.0:14318"), false);
  assert.equal(extra.has("my-pc.lan:14318"), true);
  assert.equal(extra.has("10.0.0.5:9000"), true);
});

test("checkCrossSite 拒绝其他网页来源，放行同源与无 Origin 客户端", () => {
  assert.equal(checkCrossSite({ headers: {} }, hosts).ok, true);
  assert.equal(
    checkCrossSite({ headers: { origin: "http://127.0.0.1:14318" } }, hosts).ok,
    true,
  );
  assert.equal(
    checkCrossSite({ headers: { origin: "https://evil.example" } }, hosts).ok,
    false,
  );
  assert.equal(checkCrossSite({ headers: { origin: "null" } }, hosts).ok, false);
  assert.equal(
    checkCrossSite({ headers: { "sec-fetch-site": "cross-site" } }, hosts).ok,
    false,
  );
  assert.equal(
    checkCrossSite({ headers: { "sec-fetch-site": "same-origin" } }, hosts).ok,
    true,
  );
  assert.equal(checkCrossSite({ headers: { origin: "app://-" } }, hosts).ok, true);
});

test("checkControlToken 要求正确 token，查询参数仅在显式允许时生效", () => {
  const token = generateControlToken();
  assert.equal(checkControlToken({ headers: {} }, url, token).ok, false);
  assert.equal(
    checkControlToken({ headers: { "x-switcher-token": "wrong" } }, url, token).ok,
    false,
  );
  assert.equal(
    checkControlToken({ headers: { "x-switcher-token": token } }, url, token).ok,
    true,
  );

  const sseUrl = new URL(`http://127.0.0.1:14318/api/events?token=${token}`);
  assert.equal(checkControlToken({ headers: {} }, sseUrl, token).ok, false);
  assert.equal(checkControlToken({ headers: {} }, sseUrl, token, true).ok, true);
});

test("injectControlToken 把 token 写入 head", () => {
  const html = injectControlToken("<html><head><title>x</title></head></html>", "abc");
  assert.match(html, /<meta name="switcher-token" content="abc" \/>\s*<\/head>/);
});
