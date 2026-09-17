/**
 * dsh-daemon-doctor — Host half.
 * 只读诊断 dsh web 的「反复重启 / 卡死」问题，并提供一次进程栈采样。
 * 端点：GET /status | GET /restarts | GET /checkup | POST /sample
 * 只读、不修改任何配置；采样仅在用户点击时执行。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const DAEMON_DIR = path.join(DSH_HOME, "daemon");
const LOG_DIR = path.join(DAEMON_DIR, "logs");
const WATCHDOG_LOG = path.join(LOG_DIR, "watchdog.log");
const WEB_LOG = path.join(LOG_DIR, "dsh-web.log");
const WEB_PID_FILE = path.join(DAEMON_DIR, ".dsh-web.pid");
const WATCHDOG_PID_FILE = path.join(DAEMON_DIR, ".dsh-watchdog.pid");
const WATCHDOG_JS = path.join(DAEMON_DIR, "watchdog.js");
const SESSIONS_DIR = path.join(DSH_HOME, "sessions");
const API_PREFIX = "/daemon-doctor/api";
const HEALTH_URL = "http://127.0.0.1:3080/health";

export const name = "dsh-daemon-doctor";
export const inject = ["webServer"];

async function readText(p) { try { return await fs.readFile(p, "utf8"); } catch { return ""; } }
async function readPid(p) { const t = await readText(p); const n = parseInt(t.trim(), 10); return Number.isFinite(n) ? n : null; }
async function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

/** 从文件尾部读取最多 maxBytes（日志可能很大）。 */
async function tailText(file, maxBytes) {
  try {
    const fh = await fs.open(file, "r");
    try {
      const st = await fh.stat();
      const start = Math.max(0, st.size - maxBytes);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return buf.toString("utf8");
    } finally { await fh.close(); }
  } catch { return ""; }
}

/** 只保留「当前 web 进程启动之后」的日志：按最后一次启动标记（ExperimentalWarning）切割。 */
function sinceLastBoot(text) {
  const lines = String(text || "").split("\n");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].indexOf("ExperimentalWarning") >= 0) { idx = i; break; }
  }
  return (idx >= 0 ? lines.slice(idx) : lines.slice(-400)).join("\n");
}

async function probeHealth() {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    return { ok: res.ok, ms: Date.now() - t0, status: res.status, error: null };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, status: null, error: String(e && e.message ? e.message : e) };
  }
}

async function status() {
  const webPid = await readPid(WEB_PID_FILE);
  const wdPid = await readPid(WATCHDOG_PID_FILE);
  const wdSrc = await readText(WATCHDOG_JS);
  const m = wdSrc.match(/const FAIL_THRESHOLD = (\d+);/);
  const i = wdSrc.match(/const INTERVAL_MS = (\d+);/);
  const health = await probeHealth();
  const wdLogTail = await tailText(WATCHDOG_LOG, 200000);
  const startedAt = (function () {
    const re = /\[([^\]]+)\] \[watchdog\] launched dsh web \(PID (\d+)\)/g;
    let mm, last = null;
    while ((mm = re.exec(wdLogTail)) !== null) { if (String(webPid) === mm[2]) last = mm[1]; }
    return last;
  })();
  return {
    web: { pid: webPid, alive: await alive(webPid), startedAt: startedAt, health: health },
    watchdog: { pid: wdPid, alive: await alive(wdPid), failThreshold: m ? Number(m[1]) : null, intervalMs: i ? Number(i[1]) : null, defaultThreshold: 3, scriptPath: WATCHDOG_JS, scriptMtime: await (async () => { try { return (await fs.stat(WATCHDOG_JS)).mtime.toISOString(); } catch { return null; } })() },
    logs: { watchdog: WATCHDOG_LOG, web: WEB_LOG }
  };
}

function parseWatchdog(text) {
  const out = { launches: [], stops: [], thresholds: [], failures: [] };
  for (const ln of text.split("\n")) {
    const t = (ln.match(/^\[([^\]]+)\]/) || [])[1];
    if (!t) continue;
    let m;
    if ((m = ln.match(/launched dsh web \(PID (\d+)\)/))) out.launches.push({ at: t, pid: Number(m[1]) });
    else if ((m = ln.match(/stopping previous web server \(PID (\d+)\)/))) out.stops.push({ at: t, pid: Number(m[1]) });
    else if (ln.indexOf("failure threshold reached") >= 0) out.thresholds.push({ at: t });
    else if ((m = ln.match(/health check failed \((\d+)\/(\d+)\)/))) out.failures.push({ at: t, n: Number(m[1]), of: Number(m[2]) });
  }
  return out;
}

async function restarts() {
  const text = await tailText(WATCHDOG_LOG, 400000);
  const p = parseWatchdog(text);
  const now = Date.now();
  const within = (at, ms) => { const ts = Date.parse(at); return Number.isFinite(ts) && (now - ts) <= ms; };
  const launches24h = p.launches.filter((x) => within(x.at, 86400000));
  const launches1h = p.launches.filter((x) => within(x.at, 3600000));
  const thresholds24h = p.thresholds.filter((x) => within(x.at, 86400000));
  const last = p.launches.length ? p.launches[p.launches.length - 1] : null;
  const recent = p.launches.slice(-12).reverse().map((x, idx, arr) => {
    const next = arr[idx + 1];
    const dur = next ? (Date.parse(x.at) - Date.parse(next.at)) : null;
    return { at: x.at, pid: x.pid, livedMs: dur };
  });
  return {
    total: p.launches.length,
    launches24h: launches24h.length,
    launches1h: launches1h.length,
    restarts24h: thresholds24h.length,
    lastLaunchAt: last ? last.at : null,
    lastPid: last ? last.pid : null,
    recent: recent,
    failures24h: p.failures.filter((x) => within(x.at, 86400000)).length
  };
}

async function dirSize(dir) {
  let total = 0, max = 0, maxName = null, count = 0;
  async function walk(d, depth) {
    let ents = [];
    try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 2) await walk(p, depth + 1); }
      else if (e.isFile()) {
        try {
          const st = await fs.stat(p);
          total += st.size;
          if (st.size > max) { max = st.size; maxName = path.relative(SESSIONS_DIR, p); }
          count += 1;
        } catch { /* ignore */ }
      }
    }
  }
  await walk(dir, 0);
  return { total, max, maxName, count };
}

const FEATURE_FRAMES = [
  "ZstdDecompressContext", "CompressionStream", "JsonParser", "Builtin_JsonParse",
  "MarkCompact", "Scavenge", "readFileSync", "ArrayJoinConcatToSequentialString",
  "MicrotaskQueue::RunMicrotasks", "spawn", "tls", "dns"
];

async function checkup() {
  const items = [];
  const wdLog = await tailText(WATCHDOG_LOG, 400000);
  const webLog = sinceLastBoot(await tailText(WEB_LOG, 800000));
  const wdSrc = await readText(WATCHDOG_JS);
  const wd = parseWatchdog(wdLog);
  const now = Date.now();
  const within = (at, ms) => { const ts = Date.parse(at); return Number.isFinite(ts) && (now - ts) <= ms; };

  const add = (level, title, detail, advice) => items.push({ level: level, title: title, detail: detail, advice: advice });

  // 1) 24h 重启次数
  const th24 = wd.thresholds.filter((x) => within(x.at, 86400000)).length;
  const la24 = wd.launches.filter((x) => within(x.at, 86400000)).length;
  if (th24 >= 10) add("bad", "重启过于频繁", "24 小时内触发 " + th24 + " 次强制重启（共启动 " + la24 + " 次）", "先看下面的具体项；短期可把 watchdog 阈值调高，但根因要清数据源");
  else if (th24 >= 3) add("warn", "存在周期性重启", "24 小时 " + th24 + " 次强制重启（启动 " + la24 + " 次）", "关注是否有大会话读写 / 后台扫描类插件");
  else add("ok", "重启次数正常", "24 小时 " + th24 + " 次强制重启", "无需处理");

  // 2) EADDRINUSE 雪崩
  const addr = (webLog.match(/EADDRINUSE/g) || []).length;
  if (addr > 0) add(addr > 5 ? "bad" : "warn", "检测到端口占用（EADDRINUSE）", "web 日志尾部出现 " + addr + " 次 EADDRINUSE", "旧进程未完全退出时 watchdog 又拉起新进程；增大阈值或先停 web 再启动可缓解");

  // 3) 索引插件高频失败（坏文件）
  const reIdx = (webLog.match(/re-index failed/g) || []).length;
  if (reIdx > 0) add(reIdx > 50 ? "bad" : "warn", "索引插件反复失败", "web 日志尾部 " + reIdx + " 条 re-index failed", "多半是 watch 扫描根内存在永远解析失败的坏文件；把坏文件移出扫描根或关闭该插件的 watch（口径：仅统计当前进程启动后的日志）");
  const quarantine = (webLog.match(/_quarantine/g) || []).length;
  if (quarantine > 0) add("warn", "隔离目录仍在扫描根内", "日志出现 " + quarantine + " 次 _quarantine 相关失败", "隔离目录必须移出 watch 根，否则等于没清");

  // 4) watchdog 阈值是否被改
  const m = wdSrc.match(/const FAIL_THRESHOLD = (\d+);/);
  const th = m ? Number(m[1]) : null;
  if (th !== null && th > 3) add("info", "watchdog 阈值已被调高", "FAIL_THRESHOLD = " + th + "（默认 3）", "注意 dsh 升级 / dsh-daemon reinstall 会覆盖该文件，需要重做");
  else if (th === 3) add("info", "watchdog 阈值为默认值", "FAIL_THRESHOLD = 3（连续失败 90 秒即重启）", "若卡顿只是数十秒级，可考虑调到 10 以减少误重启");

  // 5) 会话库体积与最大会话
  const sd = await dirSize(SESSIONS_DIR);
  const mb = (n) => Math.round(n / 1048576 * 10) / 10;
  if (sd.max > 10 * 1048576) add("bad", "存在超大会话", "最大会话 " + mb(sd.max) + " MB（" + sd.maxName + "），会话库共 " + mb(sd.total) + " MB", "dsh 在主线程全量读写会话，大会话会导致卡死；建议归档不用的会话");
  else if (sd.total > 500 * 1048576) add("warn", "会话库偏大", "总计 " + mb(sd.total) + " MB / " + sd.count + " 个文件", "可归档陈旧会话以降载");
  else add("ok", "会话库体积正常", "共 " + mb(sd.total) + " MB，最大单个 " + mb(sd.max) + " MB", "无需处理");

  // 6) health 响应耗时
  const hp = await probeHealth();
  if (!hp.ok) add("bad", "健康检查失败", "GET /health 未通过：" + (hp.error || ("HTTP " + hp.status)), "web 可能正在卡死或未启动");
  else if (hp.ms > 800) add("warn", "健康检查偏慢", "GET /health 耗时 " + hp.ms + " ms", "主线程可能被占用，结合下面的采样定位");
  else add("ok", "健康检查正常", "GET /health " + hp.ms + " ms", "无需处理");

  const worst = items.some((i) => i.level === "bad") ? "bad" : (items.some((i) => i.level === "warn") ? "warn" : "ok");
  return { at: new Date().toISOString(), overall: worst, items: items };
}

async function sampleStack() {
  const pid = await readPid(WEB_PID_FILE);
  if (!pid) return { error: "读不到 web PID" };
  if (!(await alive(pid))) return { error: "web 进程不存在（PID " + pid + "）" };
  const out = await new Promise((resolve) => {
    const p = spawn("sample", [String(pid), "5"], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let err = "";
    p.stdout.on("data", (d) => { buf += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", (e) => resolve({ error: "sample 不可用：" + e.message }));
    p.on("close", (code) => resolve({ code: code, out: buf, err: err }));
  });
  if (out.error) return { error: out.error };
  const text = out.out || "";
  const frames = {};
  for (const k of FEATURE_FRAMES) {
    const n = (text.split(k).length - 1);
    if (n > 0) frames[k] = n;
  }
  const footprint = (text.match(/Physical footprint:\s*([^\n]+)/) || [])[1] || null;
  const peak = (text.match(/Physical footprint \(peak\):\s*([^\n]+)/) || [])[1] || null;
  const top = Object.keys(frames).sort((a, b) => frames[b] - frames[a]).slice(0, 6);
  let verdict = "未见明显特征帧（可能当前不卡）";
  if (frames["ZstdDecompressContext"] || frames["CompressionStream"]) verdict = "疑似在解压/压缩（zstd）—— 常见于 pdfjs 解析或会话读写";
  if (frames["JsonParser"] || frames["Builtin_JsonParse"]) verdict = "疑似在解析大 JSON —— 常见于会话加载或大响应处理";
  if (frames["MarkCompact"] > 50) verdict = "GC（MarkCompact）占比很高 —— 堆压力大或频繁全量回收";
  return { pid: pid, footprint: footprint, peak: peak, frames: frames, top: top, verdict: verdict, error: out.err ? String(out.err).slice(0, 300) : null };
}

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
async function readBody(req) { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString("utf8"); }

export { status, restarts, checkup, sampleStack, parseWatchdog };

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url || "/", "http://localhost");
        const sub = url.pathname.startsWith(API_PREFIX) ? (url.pathname.slice(API_PREFIX.length) || "/") : "/";
        if (req.method === "GET" && sub === "/status") return send(res, 200, { ok: true, result: await status() });
        if (req.method === "GET" && sub === "/restarts") return send(res, 200, { ok: true, result: await restarts() });
        if (req.method === "GET" && sub === "/checkup") return send(res, 200, { ok: true, result: await checkup() });
        if (req.method === "POST" && sub === "/sample") { await readBody(req); return send(res, 200, { ok: true, result: await sampleStack() }); }
        return send(res, 404, { ok: false, error: "未知端点: " + sub });
      } catch (error) {
        const msg = error && error.message ? error.message : String(error);
        ctx.logger.warn("daemon-doctor: api error: " + msg);
        return send(res, 500, { ok: false, error: msg });
      }
    }
  }), "daemon-doctor: api routes");
}
