# dsh-daemon-doctor

dsh web「反复重启 / 卡死」的**只读诊断面板**：健康状态、重启历史、一键体检、抓取卡死进程栈。

## 能力

| 功能 | 说明 |
|------|------|
| **健康状态** | web PID / 存活 / 启动时刻、`/health` 耗时、watchdog PID、**重启阈值**（含是否被改过）|
| **重启历史** | 24h 强制重启次数、启动次数、近 1 小时、最近一次；最近 12 次启动的存活时长 |
| **一键体检** | 按下表规则逐项判定并给建议 |
| **抓卡死栈** | 对 web 进程 `sample` 5 秒，提取特征帧（zstd / JsonParser / MarkCompact…）并给结论 |

## 体检规则

| 规则 | 判定 | 建议 |
|------|------|------|
| 24h 强制重启 | ≥10 `bad` / ≥3 `warn` | 先看具体项；短期可调高阈值，根因要清数据源 |
| EADDRINUSE | 出现即提示 | 旧进程未退出时 watchdog 又拉起新进程 |
| 索引插件高频失败 | 出现即提示 | watch 根内存在永远解析失败的坏文件 → 移出扫描根或关闭 watch |
| 隔离目录在扫描根内 | 出现即提示 | 隔离目录必须移出扫描根，否则等于没清 |
| watchdog 阈值 | 非默认即提示 | `dsh-daemon reinstall` / dsh 升级会覆盖该文件，需重做 |
| 会话库与最大会话 | 单会话 >10MB 判 `bad` | dsh 在主线程全量读写会话，大会话会导致卡死 |
| `/health` 耗时 | >800ms 判 `warn` | 主线程被占用，配合采样定位 |

**统计口径**：只统计**当前 web 进程启动之后**的日志（按最后一次启动标记切割）—— 避免把历史故障误报为当前问题。

## 设计原则

- **只读**：不修改任何配置、不重启任何服务、不写任何文件
- **采样仅在你点击时执行**（5 秒，期间 web 会有轻微停顿）
- 优先注册进 [dsh-plugin-hub](https://github.com/zzdhsxk/dsh-plugin-hub) 的插件坞；hub 不存在时退回独立入口

## 安装

```bash
dsh plugin --profile web add github:<owner>/dsh-daemon-doctor
dsh-daemon restart
```

## HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/daemon-doctor/api/status` | 运行状态 |
| GET | `/daemon-doctor/api/restarts` | 重启历史统计 |
| GET | `/daemon-doctor/api/checkup` | 一键体检 |
| POST | `/daemon-doctor/api/sample` | 采样当前进程栈（5 秒）|

## 许可

MIT
