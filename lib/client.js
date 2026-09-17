/**
 * dsh-daemon-doctor — Client half.
 * 面板：健康状态卡 + 重启统计/时间线 + 一键体检 + 抓取卡死栈。
 * 优先注册进「插件集」hub 的插件坞；hub 不存在时退回独立入口。
 */
window.__ModuleLoader__.load({
  id: "dsh-daemon-doctor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useCallback } = React;
    const h = React.createElement;
    const API = "/daemon-doctor/api";

    const V = {
      text: "var(--dsw-alias-label-primary, #e8e8e8)",
      dim: "var(--dsw-alias-label-secondary, rgba(200,200,200,0.75))",
      border: "var(--dsw-alias-border-l2, rgba(128,128,128,0.3))",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.16))"
    };
    const LEVEL = {
      ok: { icon: "✓", color: "var(--dsw-alias-label-primary-bluish, #6b8fd4)" },
      info: { icon: "i", color: "var(--dsw-alias-label-tertiary, #999)" },
      warn: { icon: "!", color: "#d9a441" },
      bad: { icon: "✕", color: "var(--dsw-alias-label-error, #e08585)" }
    };
    const S = {
      card: { border: "1px solid " + V.border, borderRadius: "8px", padding: "10px 12px", marginBottom: "10px" },
      grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "6px 14px", fontSize: "11px" },
      kv: { display: "flex", justifyContent: "space-between", gap: "8px" },
      k: { color: V.dim },
      v: { fontFamily: "var(--ds-font-family-code, monospace)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      title: { fontSize: "12px", fontWeight: 600, marginBottom: "6px" },
      btn: { cursor: "pointer", border: "1px solid " + V.border, borderRadius: "6px", background: "transparent", color: "inherit", padding: "3px 10px", fontSize: "11px", whiteSpace: "nowrap" },
      btnPrimary: { cursor: "pointer", border: "1px solid var(--dsw-alias-label-primary-bluish, #6b8fd4)", borderRadius: "6px", background: "transparent", color: "inherit", padding: "3px 10px", fontSize: "11px", whiteSpace: "nowrap" },
      row: { display: "flex", gap: "8px", padding: "5px 0", borderBottom: "1px solid " + V.border, alignItems: "flex-start" },
      icon: (c) => ({ flex: "0 0 auto", width: "16px", height: "16px", lineHeight: "16px", textAlign: "center", borderRadius: "50%", border: "1px solid " + c, color: c, fontSize: "10px", marginTop: "1px" }),
      line: { fontSize: "11px", color: V.dim, marginTop: "7px", cursor: "pointer" },
      cmd: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", background: "var(--dsw-alias-bg-mask-drop, rgba(0,0,0,0.18))", border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12))", borderRadius: "6px", padding: "6px 8px", cursor: "pointer", wordBreak: "break-all", color: "var(--dsw-alias-label-primary)", lineHeight: "1.5" }
    };

    async function api(path, body) {
      const res = await fetch(API + path, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      let json = null;
      try { json = await res.json(); } catch (e) { json = null; }
      if (!json) throw new Error("响应不是 JSON（HTTP " + res.status + "）");
      if (!json.ok) throw new Error(json.error || ("HTTP " + res.status));
      return json.result;
    }
    function fmtDur(ms) {
      if (ms === null || ms === undefined) return "—";
      const s = Math.round(ms / 1000);
      if (s < 60) return s + " 秒";
      if (s < 3600) return Math.round(s / 60) + " 分钟";
      return (Math.round(s / 360) / 10) + " 小时";
    }
    function fmtWhen(v) {
      if (!v) return "—";
      const t = Date.parse(v);
      if (!Number.isFinite(t)) return String(v);
      const d = Math.round((Date.now() - t) / 60000);
      if (d < 1) return "刚刚";
      if (d < 60) return d + " 分钟前";
      if (d < 1440) return Math.round(d / 60) + " 小时前";
      return Math.round(d / 1440) + " 天前";
    }

    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null }; }
      static getDerivedStateFromError(err) { return { err: err }; }
      render() {
        if (this.state.err) return h("div", { style: { padding: "10px", color: "var(--dsw-alias-label-error, #e08585)", fontSize: "11px" } }, "诊断面板出错：" + String((this.state.err && this.state.err.message) || this.state.err));
        return this.props.children;
      }
    }

    function KV(props) {
      return h("div", { style: S.kv }, h("span", { style: S.k }, props.k), h("span", { style: S.v, title: String(props.v) }, String(props.v)));
    }

    function DoctorPanel(props) {
      const [status, setStatus] = useState(null);
      const [restarts, setRestarts] = useState(null);
      const [checkup, setCheckup] = useState(null);
      const [stack, setStack] = useState(null);
      const [busy, setBusy] = useState("");
      const [msg, setMsg] = useState("");
      const [showRecent, setShowRecent] = useState(false);
      const [sampler, setSampler] = useState(null);
      const [latest, setLatest] = useState(null);
      const [copied, setCopied] = useState("");

      const loadBase = useCallback(async () => {
        setBusy("base"); setMsg("");
        try {
          const [s, r] = await Promise.all([api("/status"), api("/restarts")]);
          setStatus(s); setRestarts(r);
        } catch (e) { setMsg("读取失败: " + e.message); } finally { setBusy(""); }
      }, []);
      useEffect(() => { loadBase(); }, [loadBase]);

      const runCheckup = async () => {
        setBusy("checkup"); setMsg("");
        try { setCheckup(await api("/checkup")); } catch (e) { setMsg("体检失败: " + e.message); } finally { setBusy(""); }
      };
      const runSample = async () => {
        setBusy("sample"); setMsg("正在采样 3 秒（期间 web 会有轻微停顿）…");
        try { setStack(await api("/sample", {})); setMsg("采样完成"); } catch (e) { setMsg("采样失败: " + e.message); } finally { setBusy(""); }
      };

      const prepareSampler = async () => {
        setBusy("sampler"); setMsg("");
        try {
          const r = await api("/sampler/prepare", {});
          setSampler(r);
          try { setLatest(await api("/sampler/latest")); } catch (e) { /* 尚无历史结果不算失败 */ }
          setMsg("命令已生成：复制到终端运行。采样结果直接落文件，web 期间被 watchdog 重启也不会丢。");
        } catch (e) { setMsg("准备采样失败: " + e.message); } finally { setBusy(""); }
      };
      const loadLatest = async () => {
        setBusy("latest"); setMsg("");
        try { setLatest(await api("/sampler/latest")); } catch (e) { setMsg("读取采样失败: " + e.message); } finally { setBusy(""); }
      };
      const copyText = (text) => {
        setCopied(text || "");
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
        } catch (e) { /* 复制不可用时用户可手动选中 */ }
      };

      const headBar = h("div", { style: { display: "flex", gap: "6px", marginBottom: "10px", flexWrap: "wrap", alignItems: "center" } },
        h("button", { type: "button", style: S.btn, disabled: busy !== "", onClick: loadBase }, busy === "base" ? "读取中…" : "刷新状态"),
        h("button", { type: "button", style: S.btnPrimary, disabled: busy !== "", onClick: runCheckup }, busy === "checkup" ? "体检中…" : "一键体检"),
        h("button", { type: "button", style: S.btn, disabled: busy !== "", onClick: runSample }, busy === "sample" ? "采样中…" : "抓取卡死栈"),
        h("button", { type: "button", style: S.btn, disabled: busy !== "", onClick: prepareSampler }, busy === "sampler" ? "生成中…" : "终端采样命令"),
        h("button", { type: "button", style: S.btn, disabled: busy !== "", onClick: loadLatest }, busy === "latest" ? "读取中…" : "最近采样"),
        h("span", { style: { fontSize: "11px", color: V.dim } }, "只读诊断，不会改动任何配置")
      );

      const statusCard = status ? h("div", { style: S.card },
        h("div", { style: S.title }, "运行状态"),
        h("div", { style: S.grid },
          h(KV, { k: "web PID", v: status.web.pid === null ? "—" : (status.web.pid + (status.web.alive ? " (存活)" : " (不存在)")) }),
          h(KV, { k: "web 启动于", v: fmtWhen(status.web.startedAt) }),
          h(KV, { k: "/health", v: status.web.health.ok ? (status.web.health.ms + " ms") : ("失败 " + (status.web.health.error || status.web.health.status)) }),
          h(KV, { k: "watchdog PID", v: status.watchdog.pid === null ? "—" : (status.watchdog.pid + (status.watchdog.alive ? " (存活)" : " (不存在)")) }),
          h(KV, { k: "重启阈值", v: status.watchdog.failThreshold === null ? "—" : (status.watchdog.failThreshold + " 次连败" + (status.watchdog.failThreshold !== status.watchdog.defaultThreshold ? "（已调整）" : "（默认）")) }),
          h(KV, { k: "检查间隔", v: status.watchdog.intervalMs ? (status.watchdog.intervalMs / 1000 + " 秒") : "—" })
        )
      ) : h("div", { style: S.card }, "读取状态中…");

      const restartCard = restarts ? h("div", { style: S.card },
        h("div", { style: S.title }, "重启历史"),
        h("div", { style: S.grid },
          h(KV, { k: "24 小时强制重启", v: restarts.restarts24h + " 次" }),
          h(KV, { k: "24 小时启动", v: restarts.launches24h + " 次" }),
          h(KV, { k: "近 1 小时启动", v: restarts.launches1h + " 次" }),
          h(KV, { k: "最近一次重启", v: fmtWhen(restarts.lastLaunchAt) }),
          h(KV, { k: "24h 健康检查失败", v: restarts.failures24h + " 次" })
        ),
        h("div", { style: S.line, onClick: () => setShowRecent(!showRecent) },
          (showRecent ? "▾ " : "▸ ") + "最近 " + (restarts.recent || []).length + " 次启动记录"),
        showRecent ? h("div", { style: { marginTop: "6px" } },
          (restarts.recent || []).map((r, i) => h("div", { key: i, style: { fontSize: "11px", color: V.dim, padding: "2px 0" } },
            "PID " + r.pid + " · " + fmtWhen(r.at) + " · 存活 " + fmtDur(r.livedMs)))
        ) : null
      ) : null;

      const checkupCard = checkup ? h("div", { style: S.card },
        h("div", { style: S.title }, "体检结果（" + fmtWhen(checkup.at) + "）"),
        (checkup.items || []).map((it, i) => h("div", { key: i, style: S.row },
          h("div", { style: S.icon(LEVEL[it.level].color) }, LEVEL[it.level].icon),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { fontSize: "12px" } }, it.title),
            h("div", { style: { fontSize: "11px", color: V.dim, marginTop: "1px" } }, it.detail),
            it.advice ? h("div", { style: { fontSize: "11px", color: V.dim, marginTop: "2px", opacity: 0.85 } }, "→ " + it.advice) : null
          )
        ))
      ) : null;

      const stackCard = stack ? h("div", { style: S.card },
        h("div", { style: S.title }, "卡死栈采样（PID " + (stack.pid || "?") + "）"),
        h("div", { style: S.grid },
          h(KV, { k: "内存 footprint", v: stack.footprint || "—" }),
          h(KV, { k: "峰值", v: stack.peak || "—" })
        ),
        h("div", { style: { marginTop: "8px", fontSize: "12px" } }, stack.verdict || ""),
        stack.top && stack.top.length ? h("div", { style: { marginTop: "6px", fontSize: "11px", color: V.dim } },
          "特征帧：" + stack.top.map((k) => k + " ×" + stack.frames[k]).join("　")) : null,
        stack.error ? h("div", { style: { marginTop: "6px", fontSize: "11px", color: "var(--dsw-alias-label-error, #e08585)" } }, String(stack.error)) : null
      ) : null;

      const samplerCard = h("div", { style: S.card },
        h("div", { style: S.title }, "终端采样（推荐）"),
        h("div", { style: { fontSize: "11px", color: V.dim, lineHeight: "1.6" } },
          "插件内采样走 HTTP：web 若正好被 watchdog 重启，采样结果会随进程一起丢掉。终端采样把结果直接写进文件，重启也不丢，而且抓的正是「真正卡住的那一刻」。"),
        !sampler
          ? h("div", { style: { fontSize: "11px", color: V.dim, marginTop: "6px" } }, "点上方「终端采样命令」生成一行命令。")
          : h("div", { style: { marginTop: "6px" } },
            h("div", { style: S.cmd, onClick: () => copyText(sampler.command), title: "点击复制" }, sampler.command),
            h("div", { style: { display: "flex", gap: "6px", marginTop: "6px", alignItems: "center", flexWrap: "wrap" } },
              h("button", { type: "button", style: S.btn, onClick: () => copyText(sampler.command) }, copied === sampler.command ? "已复制 ✓" : "复制命令"),
              h("span", { style: { fontSize: "11px", color: V.dim } }, "结果目录：" + sampler.outputDir)
            ),
            h("div", { style: { fontSize: "11px", color: V.dim, marginTop: "6px" } }, "用法：终端里粘贴执行 → 让它一直挂着 → 复现卡顿时它会自动抓栈写文件 → 回到这里点「最近采样」看结果。")
          ),
        latest ? h("div", { style: { marginTop: "8px" } },
          h("div", { style: { fontSize: "11px", color: V.dim } }, latest.count ? ("最近采样：" + latest.count + " 个文件") : (latest.note || "尚无采样结果")),
          (latest.items || []).map((it, i) => h("div", { key: i, style: { fontSize: "11px", marginTop: "5px", paddingTop: "5px", borderTop: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.10))" } },
            h("div", { style: { color: "var(--dsw-alias-label-primary)" } }, it.name + "　" + fmtWhen(it.at) + "　" + Math.max(1, Math.round(it.bytes / 1024)) + " KB"),
            h("div", { style: { color: V.dim } }, "health=" + (it.health || "—") + "　footprint=" + (it.footprint || "—")),
            it.top && it.top.length ? h("div", { style: { color: V.dim, marginTop: "2px" } }, "特征帧：" + it.top.map((k) => k + " ×" + it.frames[k]).join("　")) : null
          ))
        ) : null
      );

      return h("div", null, headBar, msg ? h("div", { style: { fontSize: "11px", color: V.dim, marginBottom: "8px" } }, msg) : null, statusCard, restartCard, checkupCard, samplerCard, stackCard);
    }

    function StandaloneButton(props) {
      const [open, setOpen] = useState(false);
      return h("div", { style: { position: "relative", display: "inline-flex" } },
        h("button", { type: "button", style: S.btn, onClick: () => setOpen(!open) }, "重启诊断"),
        open ? h("div", { style: { position: "fixed", right: "16px", bottom: "60px", width: "640px", maxHeight: "76vh", overflowY: "auto", zIndex: 2147000000, background: "var(--dsw-alias-bg-layer-2, #232323)", color: V.text, border: "1px solid " + V.border, borderRadius: "10px", padding: "12px" } },
          h(Boundary, null, h(DoctorPanel, {}))) : null
      );
    }

    function apply(ctx) {
      try {
        const hubApi = typeof window !== "undefined" ? window.__DSH_PLUGIN_HUB__ : null;
        if (hubApi && typeof hubApi.register === "function") {
          hubApi.register({
            id: "daemon-doctor",
            title: "重启诊断",
            icon: "🩺",
            order: 30,
            dock: true,
            render: () => h(Boundary, null, h(DoctorPanel, {}))
          });
          return;
        }
      } catch (e) { /* 忽略 */ }
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action", id: "daemon-doctor-footer", order: 36, inject: () => ({})
      }, StandaloneButton));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
