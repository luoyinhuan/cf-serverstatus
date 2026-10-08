# cf-serverstatus

单文件 **Cloudflare Worker + D1** 的服务器状态看板。

在服务器上跑一个**零依赖的 agent**（Linux 用 bash + curl + `/proc`，Windows/macOS 用 Python + psutil），
它主动往 Worker 上报 CPU / 内存 / 磁盘 / 负载 / 累计流量 / TCP 连接数 / 进程数，
面板上按卡片展示，还有**按天在线率红绿柱**和**历史曲线**。

- **一个文件搞定**：不需要构建、不需要 wrangler、不需要在服务器上开任何入站端口（agent 主动上报）。
- **数据存 D1**：免费额度够用；面板里内置**额度估算器**，会告诉你这个间隔下还能带几台。
- **面板数据公开可看**；只有「Agent 配置」需要管理员账户（弹窗登录）。
- **手机端可用**：顶栏选项收进右侧抽屉，触摸目标加大，适配刘海屏。

---

## 目录

- [一、5 分钟搭起来](#一5-分钟搭起来)
- [二、把服务器接进来](#二把服务器接进来)
- [三、面板用法](#三面板用法)
- [四、可选配置](#四可选配置)
- [五、数据与保留策略](#五数据与保留策略)
- [六、接口一览](#六接口一览)
- [七、本地开发与测试](#七本地开发与测试)
- [八、常见问题](#八常见问题)
- [九、文件结构](#九文件结构)

---

## 一、5 分钟搭起来

### 1. 建 Worker

Cloudflare 控制台 → **Workers & Pages** → **创建** → **创建 Worker** → 起个名字 → **部署** →
点 **编辑代码** → 把 [`worker.js`](worker.js) 全部内容粘进去 → **部署**。

### 2. 绑定 D1 数据库

还是这个 Worker → **设置** → **绑定** → **添加** → 选 **D1 数据库**：

- 先点「创建数据库」（名字随意，例如 `cf-serverstatus`）
- **变量名必须填 `DB`**（大写，写错面板会提示"还没有绑定 D1 数据库"）
- 保存 → 刷新面板页面

> 数据表不需要手工建：第一次访问时会自动创建（`servers` / `metrics` / `uptime_daily` / `settings` / `admin`）。

### 3. 创建管理员账户

打开 Worker 的网址 → 右上角 **「Agent 配置」** → 弹窗里第一次会让你**创建管理员账户**
（用户名 + 至少 8 位密码）→ 创建后自动登录，配置面板就打开了。

> 看板数据（卡片、曲线、在线率）**不需要登录**；账户只用来管理 Agent 配置。

### 4. 把命令复制到服务器上执行

面板里已经按你的地址和令牌拼好了三条命令（Linux 前台 / Linux 后台 / Windows），按机器类型选一条复制。
Linux 装成后台服务（推荐，需要 root）：

```bash
curl -fsSL https://<你的worker>/install.sh | PROBE_ENDPOINT=https://<你的worker> \
PROBE_TOKEN=<面板里的令牌> \
PROBE_ID=$(hostname) PROBE_NAME="我的服务器" PROBE_GROUP=default \
bash
```

执行完等几秒，刷新面板就能看到这台机器了。

### 5. 完成

- 想看单台曲线：**点那张卡片**（再点一次收起；「全部曲线」按钮才是一次展开所有）。
- 觉得上报太频繁/太稀疏：在「Agent 配置」里改**上报间隔**，或直接点额度估算器给的**推荐值**。

---

## 二、把服务器接进来

三种 agent，都在 Worker 里内嵌好了，`curl` 直接拿到，不用自己上传文件：

| 平台 | 脚本 | 依赖 | 说明 |
| --- | --- | --- | --- |
| Linux | `/agent.sh` | bash + curl + coreutils | 读 `/proc`，前台运行 |
| Linux(systemd) | `/install.sh` | 同上 + systemd + root | 装成开机自启的后台服务 |
| Windows / macOS / Linux | `/agent.py` | Python 3 + `psutil` | 跨平台，走 `pip install psutil` |

### Linux：装成后台服务（推荐）

就是上面第 4 步那条 `install.sh` 命令，它会：

- 下载 agent 到 `/opt/cf-probe/agent.sh`
- 把配置写进 `/etc/cf-probe.env`（含 endpoint、令牌、**服务器名称**、分组、间隔）
- 装一个 systemd 服务 `cf-probe.service`，`Restart=always`，开机自启

常用运维命令：

```bash
systemctl status cf-probe          # 看状态
journalctl -u cf-probe -n 50       # 看日志（正常上报不写日志，只记失败）
systemctl restart cf-probe         # 重启
systemctl disable --now cf-probe   # 停掉并取消开机自启
```

### Linux：前台试跑（Ctrl+C 就停）

```bash
curl -fsSL https://<你的worker>/agent.sh | PROBE_ENDPOINT=https://<你的worker> \
PROBE_TOKEN=<令牌> \
PROBE_ID=$(hostname) PROBE_NAME="我的服务器" PROBE_GROUP=default \
bash
```

### Windows PowerShell

```powershell
pip install psutil; iwr https://<你的worker>/agent.py -OutFile agent.py
$env:PROBE_ENDPOINT="https://<你的worker>"; $env:PROBE_TOKEN="<令牌>"
$env:PROBE_NAME="我的服务器"; $env:PROBE_GROUP="default"; python agent.py
```

### 多台机器：靠 ID 区分，靠名称区分显示

- **`PROBE_ID`** 是机器身份，**默认取主机名**，两台机器必须不同，否则后上报的会覆盖前一台的数据。
- **`PROBE_NAME`** 只是面板上的显示名，可以重复、可以写中文（例如「香港 · Web 01」）。
- **`PROBE_GROUP`** 用来分组（面板按分组排序，卡片副标题里会显示）。

名称和分组也可以直接在「Agent 配置」面板里改（输入框改完，下面三条命令会实时更新，并记在浏览器里）。

---

## 三、面板用法

### 卡片

每张卡片是一台机器：在线状态点、名称/分组/系统、CPU / RAM / DISK 进度条、
累计下载/上传、负载、TCP、进程数、运行时长、累计在线率，以及底部的**按天在线率红绿柱**
（绿 ≥99%、黄 ≥90%、红 <90%、灰=当天没数据，鼠标/手指悬停看具体百分比）。

### 单台曲线 vs 全部曲线

- **点卡片** → 只画这一台的曲线（再点一次收起），列表照旧显示全部机器。
- 顶栏（手机端在抽屉里）的 **「全部曲线」** → 一次展开所有机器，再点收起。

### 上报间隔与额度估算

「Agent 配置」里有：

- **上报间隔**：统一下发（2～120 秒）。设置后 agent 下一轮上报就会采用；
  点「跟随各机」则清除统一值，各机器用自己安装时的间隔。
- **额度估算**：按 D1 免费版额度（写入 10 万行/天、读取 500 万行/天）算出「这个间隔能带几台」
  「按当前台数推荐多大间隔」，并给出一个 **「用推荐值 N 秒」** 按钮一键应用。

一次上报大约写 **5 行**（`servers` 1 行 + `metrics` 1 行及其 2 个索引 + `uptime_daily` 1 行）。
实测（留 30% 余量）：

| 机器数 | 推荐间隔 | 写入占用 |
| --- | --- | --- |
| 1 | 7 秒 | 61.7% |
| 3 | 19 秒 | 68.2% |
| 10 | 62 秒 | 69.7% |
| 30 | 120 秒（上限） | **108%，已超额** |
| 60 | 120 秒（上限） | **216%，已超额** |

> 免费额度大约只够 **27 台**（120 秒间隔）。超了不是"变慢"，而是 **D1 会拒绝所有查询**，
> 面板和上报一起失效 —— 所以台数多的时候请按估算器的推荐值设置。

### 管理员账户

「Agent 配置」面板底部有「管理员账户」：显示当前账户、**改用户名 / 改密码**、**退出登录**。

- 改密码后，**其他设备上的旧会话立即失效**。
- **忘记密码**：设了 `VIEW_TOKEN` 的话，带 `?token=<VIEW_TOKEN>` 打开面板即可直接改密码
  （这种进入方式不要求填当前密码）；没设就只能在 D1 控制台执行 `DELETE FROM admin;`，
  刷新页面重新创建。

---

## 四、可选配置

### 环境变量（Worker → 设置 → 变量）

| 变量 | 作用 |
| --- | --- |
| `AGENT_TOKEN` | 固定上报令牌。设置后忽略浏览器生成的那个（想固定令牌、或多人共用一个面板时用） |
| `VIEW_TOKEN` | 面板访问令牌。设置后**看板数据也要令牌**（`?token=xxx` 或请求头 `x-view-token`）；它同时是忘记密码时的应急入口 |

### Cron（可选）

Worker → **触发器** → 添加 **Cron 触发器**，表达式 `* * * * *`（每分钟一次）。
作用是让「离线」标记更及时、并按时清理过期数据；不加也行 —— 收到上报时会顺带做。

---

## 五、数据与保留策略

| 表 | 内容 | 保留 |
| --- | --- | --- |
| `servers` | 每台机器的最新状态 + 累计流量 + 累计在线率计数器 | 一直保留 |
| `metrics` | 每次上报的原始样本（曲线用） | **7 天**，之后自动删 |
| `uptime_daily` | 按 UTC 自然日聚合的「已观测秒数 / 在线秒数」（红绿柱用） | **长期保留** |
| `settings` | 上报令牌、统一间隔、上次清理时间 | — |
| `admin` | 管理员账户（用户名、PBKDF2 盐与哈希、迭代次数、会话密钥） | — |

- **在线判定**：超过 **150 秒**没上报就算离线（`OFFLINE_AFTER`）。
- **在线率**：两次上报之间的时间算「已观测」，其中不超过 150 秒的部分算「在线」。
  所以机器关机一晚上，第二天「按天在线率」会明显下降 —— 这是设计如此。
- **累计流量**：agent 上报的是内核累计值；服务器重启会让计数器归零，Worker 用 offset 接续，
  保证面板上的累计值**只增不减**。

> ⚠️ **升级注意**：如果新版 `worker.js` 改了 `servers` / `metrics` 的**列结构**，
> 首次访问会检测到"缺列"并**重建该表**（`metrics` 历史样本、`servers` 累计在线率会从头开始）。
> `uptime_daily` 不在重建范围内，红绿柱和累计流量不受影响。

---

## 六、接口一览

| 方法 | 路径 | 用途 | 鉴权 |
| --- | --- | --- | --- |
| POST | `/api/report` | agent 上报 | `Authorization: Bearer <agent 令牌>` |
| GET | `/api/servers` | 所有机器的最新状态 | 公开（设了 `VIEW_TOKEN` 就要令牌） |
| GET | `/api/summary` | 顶部汇总 | 同上 |
| GET | `/api/uptime?days=30` | 按天在线率 | 同上 |
| GET | `/api/servers/:id/history?hours=6&points=120` | 历史曲线 | 同上 |
| GET | `/api/bootstrap` | 初始化状态（是否已配置令牌/账户） | 公开 |
| POST | `/api/bootstrap` | 认领上报令牌 | 管理员会话或 `VIEW_TOKEN` |
| GET/POST | `/api/config` | 读/改上报间隔 + 额度常数 | 管理员会话或 `VIEW_TOKEN` |
| POST | `/api/login` | 登录 → 会话令牌（30 天） | — |
| POST | `/api/admin/create` | 创建管理员（仅首次） | 设了 `VIEW_TOKEN` 时需要它 |
| POST | `/api/admin/update` | 改用户名/密码 | 会话；带 `VIEW_TOKEN` 时算 root |
| GET | `/api/health` | 健康检查 | 公开 |
| GET | `/agent.sh`、`/install.sh`、`/agent.py` | 下载 agent | 公开 |

管理员会话通过请求头 **`x-admin-token`**（或 `?admin_token=`）传递。

---

## 七、本地开发与测试

不需要 wrangler、不需要联网：`_check/d1-shim.mjs` 用 Node 自带的 `node:sqlite` 顶替 D1，
把 Worker 的 `fetch()` 当普通函数调用。

```powershell
# 一键验证：同步检查 + 语法检查 + 全部测试（13 步）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\verify.ps1
```

单独跑某一项（在 `_check/` 目录下）：

| 脚本 | 覆盖 |
| --- | --- |
| `harness.mjs` | 端到端 65 条：建表、鉴权、流量 offset、按天在线率、保留策略、脚本路由 |
| `admin.mjs` | 管理员账户 58 条：创建/登录/改密/节流/会话失效/`VIEW_TOKEN` 兜底 |
| `adminui.mjs` | 界面流程 138 条：弹窗登录、抽屉、服务器名称、额度估算、改密、退出 |
| `mobile.mjs` | 手机端 43 条：窄屏不溢出、侧滑抽屉、无磨砂、触摸目标、刘海屏 |
| `overlay.mjs` | 覆盖层审计 8 条：没有任何全屏层能盖住页面吃点击；`hidden` 不被类盖掉 |
| `chart.mjs` | 曲线百分比刻度 14 条（并录出真实绘制调用） |
| `focus.mjs` | 单台聚焦 31 条：点卡片只画这一台、不整排拉长 |
| `history.mjs` | 分桶聚合退化对照 |
| `cost.mjs` | 每次上报的写入量、面板每轮读取量 |

### 内嵌 agent 脚本怎么改

明文源脚本在 [`agents/`](agents)（`install.sh` / `agent.sh` / `agent.py`）。
改完执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\embed-agent.ps1          # 重新生成并写回 worker.js
powershell -NoProfile -ExecutionPolicy Bypass -File tools\embed-agent.ps1 -Check   # 只校验是否同步
```

生成器会先自检「解压回来与源文件逐字节相同」，负载是 gzip + base64
（25,832 → 10,656 字符，省 59%），服务时用 `DecompressionStream("gzip")` 解回明文，
所以**服务器 curl 到的脚本与源文件完全一致**。

> 该 `.ps1` 必须保存为 **UTF-8 带 BOM**，否则 Windows PowerShell 5.1 会按 GBK 解析中文而报语法错。

### 预览文件（用浏览器打开）

| 文件 | 内容 |
| --- | --- |
| `_check/preview-desktop.html` | **电脑端**：1440 宽（看板 / 展开一台曲线 / Agent 配置 / 登录弹窗）+ 1280 宽看板 |
| `_check/preview-mobile.html` | **手机端**：390 / 360 看板、侧滑抽屉展开、Agent 配置、底部弹起的登录弹窗 |
| `_check/chart-preview.png` | 曲线百分比刻度实拍（由真实绘制调用重放而成，不是手画示意图） |

预览里的每个画框都是 `<iframe>`，里面的内容取自**真实面板脚本渲染出的 HTML + 面板原始样式**。
用 `iframe` 的原因：媒体查询按**视口**生效，直接塞进一个 390px 宽的 `div` 里，
在电脑上打开时媒体查询仍按电脑窗口宽度判断，看到的就不是手机布局了。
快照是静态的（去掉了页面脚本），所以框里点不动 —— 它是用来看样子的。

```powershell
& $node _check/render_previews.mjs   # 重新生成两个预览页与快照
```

### 改动记录

所有改动都记在 [`CHANGELOG.md`](CHANGELOG.md)：每条写清**动机 / 影响面 / 验证方式**。
改完代码请跑一次 `tools\verify.ps1`，并在 CHANGELOG 顶部加一条。

---

## 八、常见问题

**Q：面板上一直是"离线"？**
检查 `systemctl status cf-probe`。离线阈值是 **150 秒**；上报间隔上限是 **120 秒**，
如果手动改过 `PROBE_INTERVAL` 或统一间隔超过 120 秒，就会被判离线。

**Q：提示"还没有绑定 D1 数据库"？**
Worker → 设置 → 绑定里，D1 的**变量名必须是 `DB`**。

**Q：额度超了/面板报数据库错误？**
D1 免费版超限后**所有查询都会被拒绝**，面板和上报会一起失效。去 Cloudflare 控制台看 D1 的
Metrics → Row Metrics，并用「Agent 配置」里的额度估算器把间隔调大、或减少机器数。

**Q：忘记管理员密码？**
① 设了 `VIEW_TOKEN`：带 `?token=<VIEW_TOKEN>` 打开面板 → 直接改密码（不用填当前密码）；
② 没设：D1 控制台执行 `DELETE FROM admin;` → 刷新页面重新创建。

**Q：agent 会不会占很多资源？**
`agent.sh` 每次上报只读几个 `/proc` 文件、调用几次 `awk`，没有常驻进程；`agent.py` 每轮
`psutil` 采样一次。后台服务用 systemd 的 `Restart=always` 维持。

**Q：数据能不能导出？**
目前没有导出接口。数据都在 D1，可以用 `wrangler d1 execute` 或控制台 SQL 自行导出。

---

## 九、文件结构

```
worker.js                        ← 单文件部署体（粘贴这个）
README.md                        ← 本文件
CHANGELOG.md                     ← 改动记录（含动机与验证）
REVIEW.md                        ← 代码审查报告（8 条发现）
.gitignore                       ← 排除测试生成物
agents/                          ← 内嵌 agent 的明文源（改这里，再重新生成）
  install.sh  agent.sh  agent.py
tools/
  embed-agent.ps1                ← gzip + base64 生成内嵌负载（带往返自检、-Check）
  verify.ps1                     ← 一键验证（13 步）
_check/                          ← 测试与预览（不参与部署）
  d1-shim.mjs  harness.mjs  admin.mjs  adminui.mjs  panel.mjs
  chart.mjs  focus.mjs  mobile.mjs  overlay.mjs  history.mjs  cost.mjs
  render_previews.mjs            ← 生成两个预览页与快照
  render_chart.py                ← 重放绘制调用生成 chart-preview.png
  preview-desktop.html  preview-mobile.html  preview-snap-*.html  chart-preview.png
  migrations/                    ← 改动当时的一次性脚本（只作历史记录）
```

---

预览见 [`_check/preview-desktop.html`](_check/preview-desktop.html)（电脑端）与
[`_check/preview-mobile.html`](_check/preview-mobile.html)（手机端）。
