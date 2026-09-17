# dsh-daemon-doctor

dsh web「反复重启 / 卡死」的**只读诊断面板**：健康状态、重启历史、一键体检、抓取卡死进程栈。

## 能力

| 功能 | 说明 |
|------|------|
| **健康状态** | web PID / 存活 / 启动时刻、`/health` 耗时、watchdog PID、**重启阈值**（含是否被改过）|
| **重启历史** | 24h 强制重启次数、启动次数、近 1 小时、最近一次；最近 12 次启动的存活时长 |
| **一键体检** | 按下表规则逐项判定并给建议 |
| **抓卡死栈（插件内）** | 对 web 进程 `sample` 3 秒，提取特征帧（zstd / JsonParser / MarkCompact…）并给结论；结果走 HTTP 回传，web 正在重启时会丢 |
| **终端采样（推荐）** | 生成一行命令，在你自己的终端长期挂起：`/health` 超阈值时自动抓栈并**写文件**，web 期间被重启也不丢样本 |

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

## 终端采样（推荐）

插件内采样走 HTTP：如果 web 正好被 watchdog 重启，采样结果会随进程一起丢掉。
**终端采样把结果直接写文件**，抓的正是「真正卡住的那一刻」。

面板点「终端采样命令」→ 复制命令 → 粘贴到终端长期挂起：

```bash
bash ~/dsh_workspace/dsh-web-hang-sampler.sh
```

- **判定**：每 1 秒请求一次 `/health`，耗时达到阈值（默认 3s）即抓栈
- **输出**：`~/dsh-hang-samples/hang-<时间戳>.txt`（元信息 + watchdog 尾部）与 `hang-<时间戳>.stack.txt`（完整进程栈，可直接搜特征帧）
- **内置保护**：预热 30s（避开重启后的加载期，避免误判）、冷却 60s（避免采样本身连环拖慢 web）、PID 缺失时跳过
- **可调环境变量**：`DSH_HANG_THRESHOLD`(3) `DSH_HANG_COOLDOWN`(60) `DSH_HANG_WARMUP`(30) `DSH_HANG_SAMPLES_DIR`(输出目录) `DSH_HANG_URL`(检测地址)
- 面板「最近采样」可直接读回结果（health 耗时、内存 footprint、特征帧统计）

> 抓栈会让目标进程短暂变慢（每次约 3 秒），且**采样时间点会比卡顿晚一拍** —— 样本反映的是「卡顿之后那次抓取的瞬间状态」。

## 设计原则

- **不改配置、不重启服务**：诊断以只读为主；终端采样脚本与采样结果只写入工作目录与 `~/dsh-hang-samples`
- **采样仅在你要用时执行**（3 秒，期间 web 会有轻微停顿）
- 优先注册进 [dsh-plugin-hub](https://github.com/zzdhsxk/dsh-plugin-hub) 的插件坞；hub 不存在时退回独立入口


## 安装与运行（macOS / Linux / Windows）

### 1. dsh 本体（三平台一致）

需要 Node.js 22+：

```bash
npm i -g @deepseek-ai/dsh
dsh --version
```

### 2. 装这个插件（三平台一致）

```bash
dsh plugin --profile web add github:zzdhsxk/dsh-daemon-doctor
```

该命令在 profile 目录里执行 `pnpm add`，并自动把声明了 `dsh.bundle` 的依赖同步进 `dsh.profile.bundles`。

### 3. 启动与守护（三平台同一组命令）

```bash
dsh-daemon install      # 注册开机自启 + 每 30s 探活自愈（macOS→LaunchAgent，Linux→systemd user，Windows→VBS + 任务计划）
dsh-daemon status       # 守护与 web 健康状态
dsh-daemon restart      # 重启 web 让新插件生效（会中断当前会话，先确认没在跑任务）
dsh-daemon stop         # 暂停守护并停掉 web
dsh-daemon uninstall    # 卸载守护
```

> 插件的界面代码在 dsh web 启动时载入内存，所以**装完/改完必须重启 web** 才会生效；只刷新页面不够。

### 4. 不装守护、临时前台跑（三平台一致）

```bash
dsh web --port 3080 --no-open
```

⚠️ **不要写 `--host 0.0.0.0`** —— dsh 出于安全考虑会**主动拒绝**（它会把远程代码执行能力暴露到网络上），并提示改用 `127.0.0.1`。需要跨机访问请用 SSH 隧道或反向代理，并把来源加进 `--trusted-host`。

### 平台差异一览

| 平台 | 命令 | dsh 数据目录 | 守护落地 |
|------|------|--------------|----------|
| macOS | 全部同上 | `~/.dsh` | `~/Library/LaunchAgents/com.deepseek-ai.dsh-watchdog.plist` |
| Linux | 全部同上 | `~/.dsh` | systemd user 服务（无 systemd 时退化为 cron） |
| Windows | 全部同上（PowerShell / cmd 均可） | `%USERPROFILE%\.dsh` | 任务计划程序（VBS 启动脚本） |

### 5. Docker 运行（可选，自建镜像）

官方没有现成镜像，用 Node 官方镜像自建即可。

⚠️ **容器里同样不能用 `--host 0.0.0.0`** —— dsh 会直接拒绝并退出（它会把远程代码执行能力暴露到网络上）。正确做法是：**让 dsh 只监听 `127.0.0.1`，再用 socat 把端口转到容器外**，最后由 `-p` 映射给宿主。

`Dockerfile`：

```dockerfile
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends socat \
 && rm -rf /var/lib/apt/lists/* \
 && npm i -g @deepseek-ai/dsh
EXPOSE 3080
# 转发 0.0.0.0:3080 -> 127.0.0.1:13080（dsh 只肯监听回环地址）
CMD ["bash","-lc","socat TCP-LISTEN:3080,fork,reuseaddr TCP:127.0.0.1:13080 & exec dsh web --port 13080 --no-open"]
```

构建并运行（三个平台一致）：

```bash
docker build -t dsh-web .
docker run -d --name dsh-web -p 3080:3080 -v "$HOME/.dsh:/root/.dsh" dsh-web
```

Windows 的差别只在**挂载路径写法**：

```powershell
# PowerShell
docker run -d --name dsh-web -p 3080:3080 -v "$env:USERPROFILE\.dsh:/root/.dsh" dsh-web
```

```bat
REM cmd.exe
docker run -d --name dsh-web -p 3080:3080 -v "%USERPROFILE%\.dsh:/root/.dsh" dsh-web
```

首次访问需要带认证的 URL（token 由 dsh 启动时打印）：

```bash
docker logs dsh-web 2>&1 | grep -o "http://[^ ]*token[^ ]*"
```

> Linux 上还可以直接用 `--network host`，省掉 socat（容器与宿主共用网络栈）；
> Docker Desktop for macOS / Windows 需要先在设置里启用 host networking 才支持 `--network host`。
> 想改端口就同时改 `-p`、`--port` 与 socat 里的两个端口号。

## HTTP API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/daemon-doctor/api/status` | 运行状态 |
| GET | `/daemon-doctor/api/restarts` | 重启历史统计 |
| GET | `/daemon-doctor/api/checkup` | 一键体检 |
| POST | `/daemon-doctor/api/sample` | 采样当前进程栈（3 秒）|
| POST | `/daemon-doctor/api/sampler/prepare` | 生成/刷新终端采样脚本，返回一行命令 |
| GET | `/daemon-doctor/api/sampler/latest` | 读取最近的终端采样结果摘要 |

## 许可

MIT
