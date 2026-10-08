/**
 * ============================================================================
 *  cf-serverstatus —— 单文件版（傻瓜式部署）
 * ============================================================================
 *
 *  部署步骤：
 *    1. Cloudflare 控制台 → Workers & Pages → 创建 Worker → 编辑代码
 *    2. 把本文件全部内容粘贴进去 → 部署
 *    3. 该 Worker → 设置 → 绑定 → 添加 D1 数据库
 *         变量名必须填：DB
 *    4. 打开 Worker 网址 → 点"启用并开始"（自动建表 + 生成 Agent 令牌）
 *    5. 复制页面给出的命令，到你的服务器上执行
 *
 *  说明：
 *    - 数据库表会在第一次访问时自动创建，无需手动执行 SQL。
 *    - Agent 令牌在浏览器端随机生成，只保存在你自己的浏览器里，
 *      不会被公开到面板上。
 *    - 想让它更安全，可在 Worker 设置里添加环境变量（可选）：
 *        AGENT_TOKEN = 你自己指定的上报令牌（设置后忽略浏览器生成的）
 *        VIEW_TOKEN  = 设置后，面板和查询接口都需要令牌才能访问
 *    - 管理员账户：看板数据（卡片 / 曲线 / 在线率）**不用登录**；只有点右上角「Agent 配置」
 *      时才弹出登录框，第一次会引导创建账户（用户名 + 密码）。
 *      密码用 PBKDF2-SHA256 加盐存在 D1 的 admin 表里，任何接口都不会返回给前端；
 *      会话是 30 天有效的无状态签名令牌，存在浏览器里 —— 改密码会让其他设备的会话立即失效。
 *      VIEW_TOKEN 仍可兜底：带 ?token=<VIEW_TOKEN> 打开即可看面板，也能用它直接改密码
 *      （这种进入方式不要求填当前密码）。实在不行就在 D1 执行 DELETE FROM admin; 重新创建。
 *    - 可选：在 Worker → 触发器 里加一个"每分钟一次"的 Cron，让离线标记更及时；
 *      不加也行，Worker 会在收到上报时顺带清理。
 *
 *  本次修改：
 *    - 新增 uptime_daily 表，按 UTC 自然日累计「已观测秒数 / 其中在线秒数」；
 *    - 每台服务器卡片下方显示"按天在线率红绿柱"，可切换 14/30/60/90 天；
 *    - 该表长期保留，不受 metrics 的 7 天清理影响；
 *    - 移除上下行带宽（速率）统计，只保留累计流量统计；
 *    - 修复流量统计：服务器重启后内核计数器归零时，通过 offset 让累计流量
 *      继续单调递增（不再一夜回到解放前）。
 */

/* ============================== 配置 ============================== */

// 超过多少秒没上报就算离线
const OFFLINE_AFTER = 150;
// 历史样本保留多久（秒）
const RETENTION_SECONDS = 7 * 24 * 3600;
// 同一 isolate 内最多多久做一次清理（秒）
const PRUNE_CHECK_INTERVAL = 600;

// 网页上可改的 agent 上报间隔（秒）。只有「在网页上设置过」才会写进数据库；
// 没设置过就返回 null，agent 继续用自己安装时配的 PROBE_INTERVAL。
const REPORT_INTERVAL_KEY = "report_interval";
const MIN_REPORT_INTERVAL = 2;
// 上限必须明显小于 OFFLINE_AFTER（150 秒）。否则两次上报之间服务器就会被判成离线，
// 而且在线率会被算成 OFFLINE_AFTER/interval（间隔 300 秒时，健康机器只有 50%）。
// 120 秒 = 720 次上报/天/台，每次约 5 行写入（见 ROWS_PER_REPORT），
// 即每台约 3600 行/天 —— 免费额度（10 万行/天）大约只够 27 台，不是 130 台。
// 面板上的「额度估算」会按当前台数算出推荐间隔，别再手算这里。
const MAX_REPORT_INTERVAL = 120;

// 免费版 D1 的额度，用来在面板上估算「能带多少台 / 推荐多大间隔」。
// 一次上报大约写 5 行：servers 1 行 + metrics 1 行（它有两个索引，各算 1 行）+ uptime_daily 1 行。
// 数字来自 Cloudflare 文档（Free 计划）：写入 10 万行/天、读取 500 万行/天。
const ROWS_PER_REPORT = 5;
const FREE_ROWS_WRITTEN_PER_DAY = 100000;
const FREE_ROWS_READ_PER_DAY = 5000000;

// ---- 管理员账户 / 登录会话 ----
// 密码用 PBKDF2-SHA256 加盐存 D1；迭代次数存在账户行里，所以以后调大也能兼容老哈希
// （登录成功时会用新次数重新哈希一次）。注意 Workers 免费版 CPU 预算很小，别盲目调太高。
const PBKDF2_ITERATIONS = 100000;
// 会话有效期；会话是无状态 HMAC，签名密钥 = 账户行里的 session_key
const ADMIN_SESSION_SECONDS = 30 * 24 * 3600;
const MIN_PASSWORD_LEN = 8;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
// 同一 isolate 内的登录失败节流（每个 IP 连续失败 5 次锁 60 秒）
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_SECONDS = 60;
// 账户行 / 会话校验结果的 isolate 级缓存，避免面板每 5 秒轮询都去读一次 D1
const ADMIN_CACHE_SECONDS = 30;
const SESSION_CACHE_SECONDS = 60;

// 表结构。除了用于自动建表，还用来校验「已存在的表」是否缺列：
// 缺列说明是上次运行留下的残表，直接重建（见 runSchema）。
//
// 注意：本次改动删掉了 servers / metrics 里的 net_rx_rate、net_tx_rate 两列，
// 并给 servers 加了 net_rx_offset、net_tx_offset。老表会因为「缺列」被自动重建
// （servers 表重建后累计在线率会从 0 重新算起，agent 下一轮上报后即恢复）。
const TABLES = [
  {
    name: "servers",
    columns: [
      "id", "name", "grp", "os", "arch", "cpu_info", "cpu_cores", "created_at",
      "last_seen", "online", "cpu", "load1", "load5", "load15", "mem_used",
      "mem_total", "swap_used", "swap_total", "disk_used", "disk_total",
      "net_rx", "net_tx", "net_rx_offset", "net_tx_offset", "uptime", "tcp", "proc",
      "online_seconds", "seen_seconds",
    ],
    create: `CREATE TABLE IF NOT EXISTS servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    grp         TEXT NOT NULL DEFAULT 'default',
    os          TEXT,
    arch        TEXT,
    cpu_info    TEXT,
    cpu_cores   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL DEFAULT 0,
    online      INTEGER NOT NULL DEFAULT 0,
    cpu         REAL,
    load1       REAL,
    load5       REAL,
    load15      REAL,
    mem_used    INTEGER,
    mem_total   INTEGER,
    swap_used   INTEGER,
    swap_total  INTEGER,
    disk_used   INTEGER,
    disk_total  INTEGER,
    -- 累计流量（字节）。= agent 上报的原始值 + offset（服务器重启累积）
    net_rx      INTEGER NOT NULL DEFAULT 0,
    net_tx      INTEGER NOT NULL DEFAULT 0,
    -- 已固化的偏移量，服务器重启导致原始计数器归零时用来接续
    net_rx_offset INTEGER NOT NULL DEFAULT 0,
    net_tx_offset INTEGER NOT NULL DEFAULT 0,
    uptime      INTEGER,
    tcp         INTEGER,
    proc        INTEGER,
    -- 累计在线率用的两个计数器：已上报的总时长，以及其中判为在线的部分
    online_seconds INTEGER NOT NULL DEFAULT 0,
    seen_seconds   INTEGER NOT NULL DEFAULT 0
  )`,
  },
  {
    name: "metrics",
    columns: [
      "id", "server_id", "ts", "cpu", "load1", "mem_used", "mem_total",
      "swap_used", "swap_total", "disk_used", "disk_total", "net_rx", "net_tx",
      "uptime", "tcp", "proc",
    ],
    create: `CREATE TABLE IF NOT EXISTS metrics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    cpu         REAL,
    load1       REAL,
    mem_used    INTEGER,
    mem_total   INTEGER,
    swap_used   INTEGER,
    swap_total  INTEGER,
    disk_used   INTEGER,
    disk_total  INTEGER,
    net_rx      INTEGER,
    net_tx      INTEGER,
    uptime      INTEGER,
    tcp         INTEGER,
    proc        INTEGER
  )`,
  },
  {
    name: "settings",
    columns: ["key", "value"],
    create: `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  },
  {
    name: "uptime_daily",
    columns: ["server_id", "day", "online_seconds", "seen_seconds"],
    create: `CREATE TABLE IF NOT EXISTS uptime_daily (
    server_id      TEXT NOT NULL,
    day            INTEGER NOT NULL,
    online_seconds INTEGER NOT NULL DEFAULT 0,
    seen_seconds   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, day)
  )`,
  },
  {
    // 单管理员账户。密码只以 PBKDF2-SHA256 的「盐 + 哈希」形式存在这里，
    // 任何接口都不会把它返回给前端（见 handleBootstrap 的 admin 字段）。
    // session_key 用来给登录会话签名；改密码时轮换，旧会话随即全部失效。
    name: "admin",
    columns: ["id", "username", "salt", "hash", "iterations", "session_key", "created_at", "updated_at"],
    create: `CREATE TABLE IF NOT EXISTS admin (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    username    TEXT NOT NULL,
    salt        TEXT NOT NULL,
    hash        TEXT NOT NULL,
    iterations  INTEGER NOT NULL DEFAULT 100000,
    session_key TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`,
  },
];

// 索引必须在表建好之后再执行
const INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_metrics_server_ts ON metrics (server_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_uptime_daily_day ON uptime_daily (day)`,
];

// 内嵌的 agent 脚本：先 gzip 压缩，再 base64（10.6KB 而不是 25.8KB，约 41%）。
// 服务器 curl 本站拿到的仍然是逐字节相同的明文脚本，不需要手动上传文件。
// 源脚本在 agents/，由 tools/embed-agent.ps1 生成，勿手改这几行字符串；
// 服务时用 DecompressionStream("gzip") 解回原始字节，见 gunzipResponse()。
const INSTALL_SH_GZ_B64 = "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";
const AGENT_SH_GZ_B64 = "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";
const AGENT_PY_GZ_B64 = "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";

/* ============================== 工具函数 ============================== */

function json(data, init) {
  const headers = new Headers((init && init.headers) || {});
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(data), Object.assign({}, init, { headers: headers }));
}

function fail(status, message) {
  return json({ ok: false, error: message }, { status });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// 定长比较，避免通过响应时间猜令牌
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function toNum(value, fallback) {
  const def = fallback === undefined ? 0 : fallback;
  if (value === null || value === undefined || value === "") return def;
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}

function toInt(value, fallback) {
  return Math.trunc(toNum(value, fallback));
}

function toStr(value, max) {
  if (value === undefined || value === null) return null;
  return String(value).slice(0, max || 200);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// 将 [prev, now) 按 UTC 自然日拆分，并计算每日在线秒数。
// 总在线额度 = min(now - prev, OFFLINE_AFTER)，与原累计逻辑一致。
function splitByDay(prev, now, offlineAfter) {
  const out = [];
  if (!prev || prev <= 0 || now <= prev) return out;

  const totalSeen = now - prev;
  let onlineBudget = Math.min(totalSeen, offlineAfter);
  let cursor = prev;

  while (cursor < now) {
    const day = Math.floor(cursor / 86400);
    const nextDayStart = (day + 1) * 86400;
    const end = Math.min(now, nextDayStart);
    const seen = end - cursor;
    const online = Math.min(seen, onlineBudget);
    onlineBudget -= online;
    out.push({ day, seen, online });
    cursor = end;
  }
  return out;
}

/* ====================== 自动建表 / 自动清理 ====================== */

// isolate 级别缓存：同一个实例只跑一次建表
let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = runSchema(env).catch(function (err) {
      schemaReady = null; // 失败后下次请求重试
      throw err;
    });
  }
  return schemaReady;
}

// 注意：DDL 必须逐条 await 顺序执行，不能用 db.batch()。
// D1 的 batch() 会先把整批语句一起预编译，此时同一批里前面的
// CREATE TABLE 还没生效，后面的 CREATE INDEX 会报
// "no such column / no such table"。
async function runSchema(env) {
  for (const table of TABLES) {
    let existing = [];
    try {
      existing = await tableColumns(env, table.name);
    } catch (err) {
      existing = []; // 探测失败就按「表不存在」处理，交给 CREATE IF NOT EXISTS
    }
    if (existing.length > 0) {
      const missing = table.columns.some(function (col) {
        return existing.indexOf(col) < 0;
      });
      if (missing) {
        // 上次运行留下的残表：重建，避免一直卡在同一个错误上。
        // 只在表结构与本程序要求不符时触发（缺列），且会打日志。
        console.warn("cf-serverstatus: 表 " + table.name + " 缺列，将重建。");
        await env.DB.prepare("DROP TABLE " + table.name).run();
      }
    }
    await env.DB.prepare(table.create).run();
  }
  for (const sql of INDEX_STATEMENTS) {
    await env.DB.prepare(sql).run();
  }
}

function tableColumns(env, table) {
  // 先试表值函数写法（可绑定参数），不支持时退回 PRAGMA。
  // table 全部来自本文件内的常量，不存在注入问题。
  return env.DB
    .prepare("SELECT name FROM pragma_table_info(?)")
    .bind(table)
    .all()
    .catch(function () {
      return env.DB.prepare("PRAGMA table_info(" + table + ")").all();
    })
    .then(function (out) {
      return (out.results || []).map(function (row) { return row.name; });
    });
}

let lastPruneCheck = 0;
function maybePrune(env) {
  const now = nowSec();
  if (now - lastPruneCheck < PRUNE_CHECK_INTERVAL) return Promise.resolve();
  lastPruneCheck = now;
  return env.DB
    .prepare("SELECT value FROM settings WHERE key = 'last_prune'")
    .first()
    .then(function (row) {
      const last = row ? Number(row.value) || 0 : 0;
      if (now - last < PRUNE_CHECK_INTERVAL) return null;
      return env.DB.batch([
        env.DB
          .prepare(
            "INSERT INTO settings (key, value) VALUES ('last_prune', ?) " +
              "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          )
          .bind(String(now)),
        env.DB.prepare(
          "UPDATE servers SET online = CASE WHEN ? - last_seen <= ? THEN 1 ELSE 0 END",
        ).bind(now, OFFLINE_AFTER),
        env.DB.prepare("DELETE FROM metrics WHERE ts < ?").bind(now - RETENTION_SECONDS),
      ]);
    })
    .catch(function () {
      lastPruneCheck = 0; // 出错了下次再试
    });
}

/* ============================== 令牌 ============================== */

function getStoredToken(env) {
  return env.DB.prepare("SELECT value FROM settings WHERE key = 'agent_token'")
    .first()
    .then(function (row) { return row ? row.value : null; });
}

// 网页上设置的上报间隔；没设置过返回 null（表示「跟随各 agent 自己的配置」）
async function getReportInterval(env) {
  const row = await env.DB
    .prepare("SELECT value FROM settings WHERE key = ?")
    .bind(REPORT_INTERVAL_KEY)
    .first();
  const n = row ? Number(row.value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return clamp(Math.round(n), MIN_REPORT_INTERVAL, MAX_REPORT_INTERVAL);
}

// 环境变量优先，其次用浏览器生成并存进数据库的令牌
function resolveAgentToken(env) {
  if (env.AGENT_TOKEN) return Promise.resolve(env.AGENT_TOKEN);
  return getStoredToken(env);
}


/* ====================== 管理员账户 / 登录会话 ====================== */

function toHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function randomHex(nbytes) {
  const buf = new Uint8Array(nbytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function pbkdf2Hex(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: iterations },
    key, 256);
  return toHex(new Uint8Array(bits));
}

async function hmacHex(keyHex, message) {
  const key = await crypto.subtle.importKey(
    "raw", hexToBytes(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(new Uint8Array(sig));
}

// 账户行缓存：面板每 5 秒轮询三个接口，每次都读 D1 太浪费额度
let adminCache = { at: 0, row: null };
function invalidateAdminCache() {
  adminCache = { at: 0, row: null };
}

async function getAdmin(env) {
  const now = nowSec();
  if (adminCache.at && now - adminCache.at < ADMIN_CACHE_SECONDS) return adminCache.row;
  const row = await env.DB
    .prepare("SELECT id, username, salt, hash, iterations, session_key, updated_at FROM admin WHERE id = 1")
    .first();
  adminCache = { at: now, row: row || null };
  return adminCache.row;
}

// 会话令牌 = "过期秒.随机数.签名"，签名密钥是账户的 session_key。
// 服务端不存会话表，改密码轮换 session_key 就等于把旧会话全部踢下线。
async function issueSession(admin) {
  const payload = (nowSec() + ADMIN_SESSION_SECONDS) + "." + randomHex(12);
  return payload + "." + (await hmacHex(admin.session_key, payload));
}

// 校验结果缓存，避免每个请求都做一次 HMAC（也会顺带省掉 D1 读）
const sessionCache = new Map();
function invalidateSessions() {
  sessionCache.clear();
}

async function verifySession(admin, token) {
  if (!admin || !token) return false;
  const now = nowSec();
  const hit = sessionCache.get(token);
  if (hit && now - hit.checkedAt < SESSION_CACHE_SECONDS) return now < hit.exp;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp <= now) {
    sessionCache.delete(token);
    return false;
  }
  const expect = await hmacHex(admin.session_key, parts[0] + "." + parts[1]);
  if (!safeEqual(expect, parts[2])) return false;

  if (sessionCache.size > 200) sessionCache.clear();
  sessionCache.set(token, { exp: exp, checkedAt: now });
  return true;
}

function viewTokenValid(request, env) {
  if (!env.VIEW_TOKEN) return false;
  const url = new URL(request.url);
  const token = request.headers.get("x-view-token") || url.searchParams.get("token");
  return Boolean(token) && safeEqual(token, env.VIEW_TOKEN);
}

function adminTokenFromRequest(request) {
  const header = request.headers.get("x-admin-token");
  if (header) return header.trim();
  const url = new URL(request.url);
  const q = url.searchParams.get("admin_token");
  return q ? q.trim() : null;
}

// 面板「数据」的读取权限：默认公开（和引入账户之前一样），
// 只有设了 VIEW_TOKEN 才要求令牌。账户密码只管 Agent 配置，不再挡数据。
function dataAllowed(request, env) {
  if (!env.VIEW_TOKEN) return true;
  return viewTokenValid(request, env);
}

// 「Agent 配置」相关接口的权限，三种情况放行：
//   1) 带了正确的 VIEW_TOKEN（老部署的兜底入口，也是忘记密码时的应急入口）
//   2) 带着有效的管理员会话
//   3) 还没创建管理员，而且也没设 VIEW_TOKEN —— 否则就没法首次创建账户了
async function viewAccess(request, env) {
  const admin = await getAdmin(env);
  if (viewTokenValid(request, env)) {
    return { allowed: true, admin: admin, via_view_token: true, via_session: false };
  }
  if (!admin) {
    return { allowed: !env.VIEW_TOKEN, admin: null, via_view_token: false, via_session: false };
  }
  const viaSession = await verifySession(admin, adminTokenFromRequest(request));
  return { allowed: viaSession, admin: admin, via_view_token: false, via_session: viaSession };
}

// 同一 isolate 内的登录失败节流，挡一下在线暴力破解
const loginFails = new Map();
function loginLockLeft(ip, now) {
  const rec = loginFails.get(ip);
  return rec && rec.until > now ? Math.ceil(rec.until - now) : 0;
}
function noteLoginFail(ip, now) {
  if (loginFails.size > 500) loginFails.clear();
  const rec = loginFails.get(ip) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= LOGIN_MAX_FAILS) {
    rec.until = now + LOGIN_LOCK_SECONDS;
    rec.n = 0;
  }
  loginFails.set(ip, rec);
}

// 新建/改密后统一走这里：重新生成盐、哈希，并轮换会话密钥
async function storeCredentials(env, username, password) {
  const salt = randomHex(16);
  const hash = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
  await env.DB
    .prepare(
      "UPDATE admin SET username = ?, salt = ?, hash = ?, iterations = ?, " +
        "session_key = ?, updated_at = ? WHERE id = 1",
    )
    .bind(username, salt, hash, PBKDF2_ITERATIONS, randomHex(32), nowSec())
    .run();
  invalidateAdminCache();
  invalidateSessions();
  return getAdmin(env);
}

// POST /api/admin/create { username, password } —— 只在还没有管理员时可用
async function handleAdminCreate(request, env) {
  if (await getAdmin(env)) return fail(409, "管理员账户已存在");
  // 设了 VIEW_TOKEN 的部署必须先亮令牌，免得面板被人抢先创建账户
  if (env.VIEW_TOKEN && !viewTokenValid(request, env)) return fail(401, "invalid view token");

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail(400, "invalid json body");
  }
  const username = String((body && body.username) || "").trim();
  const password = String((body && body.password) || "");
  if (!USERNAME_RE.test(username)) return fail(400, "用户名需为 3-32 位字母、数字、点、下划线或减号");
  if (password.length < MIN_PASSWORD_LEN) return fail(400, "密码至少 " + MIN_PASSWORD_LEN + " 位");
  if (password.length > 200) return fail(400, "密码过长");

  const now = nowSec();
  const salt = randomHex(16);
  const hash = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
  const res = await env.DB
    .prepare(
      "INSERT INTO admin (id, username, salt, hash, iterations, session_key, created_at, updated_at) " +
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
    .bind(username, salt, hash, PBKDF2_ITERATIONS, randomHex(32), now, now)
    .run();
  invalidateAdminCache();
  if (!res.meta || !res.meta.changes) return fail(409, "管理员账户已存在");

  const admin = await getAdmin(env);
  return json({
    ok: true,
    username: admin.username,
    token: await issueSession(admin),
    expires_in: ADMIN_SESSION_SECONDS,
  });
}

// POST /api/login { username, password }
async function handleLogin(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const now = nowSec();
  const locked = loginLockLeft(ip, now);
  if (locked > 0) return fail(429, "尝试次数过多，请 " + locked + " 秒后再试");

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail(400, "invalid json body");
  }
  const username = String((body && body.username) || "").trim();
  const password = String((body && body.password) || "");
  const admin = await getAdmin(env);

  // 即使账户不存在也照样算一次哈希，避免用响应时间判断「用户是否存在」
  const salt = admin ? admin.salt : "00".repeat(16);
  const iterations = admin ? admin.iterations : PBKDF2_ITERATIONS;
  const hash = await pbkdf2Hex(password, salt, iterations);

  const okUser = admin ? safeEqual(username, admin.username) : false;
  const okPass = safeEqual(hash, admin ? admin.hash : "ff".repeat(32));
  if (!admin || !okUser || !okPass) {
    noteLoginFail(ip, now);
    return fail(401, "用户名或密码不对");
  }
  loginFails.delete(ip);

  // 老账户的迭代次数偏低时，用当前强度顺手重新哈希一次
  let current = admin;
  if (admin.iterations < PBKDF2_ITERATIONS) {
    current = await storeCredentials(env, admin.username, password);
  }
  return json({
    ok: true,
    username: current.username,
    token: await issueSession(current),
    expires_in: ADMIN_SESSION_SECONDS,
  });
}

// POST /api/admin/update { current, password?, username? }
// 需要管理员会话；带 VIEW_TOKEN 时视为 root 兜底，可以不填当前密码（忘记密码时的应急入口）
async function handleAdminUpdate(request, env) {
  const admin = await getAdmin(env);
  if (!admin) return fail(409, "还没有管理员账户，请先创建");
  const viaView = viewTokenValid(request, env);
  const viaSession = await verifySession(admin, adminTokenFromRequest(request));
  if (!viaView && !viaSession) return fail(401, "需要管理员登录");

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail(400, "invalid json body");
  }
  const next = String((body && body.password) || "");
  const newUser = String((body && body.username) || "").trim();
  if (!next && !newUser) return fail(400, "没有要修改的内容");
  if (next && next.length < MIN_PASSWORD_LEN) return fail(400, "密码至少 " + MIN_PASSWORD_LEN + " 位");
  if (next && next.length > 200) return fail(400, "密码过长");
  if (newUser && !USERNAME_RE.test(newUser)) return fail(400, "用户名需为 3-32 位字母、数字、点、下划线或减号");

  if (!viaView) {
    const current = String((body && body.current) || "");
    const hash = await pbkdf2Hex(current, admin.salt, admin.iterations);
    if (!safeEqual(hash, admin.hash)) return fail(403, "当前密码不对");
  }

  let fresh;
  if (next) {
    fresh = await storeCredentials(env, newUser || admin.username, next);
  } else {
    // 只改用户名：保留原密码哈希，只轮换会话密钥
    await env.DB
      .prepare("UPDATE admin SET username = ?, session_key = ?, updated_at = ? WHERE id = 1")
      .bind(newUser || admin.username, randomHex(32), nowSec())
      .run();
    invalidateAdminCache();
    invalidateSessions();
    fresh = await getAdmin(env);
  }
  return json({
    ok: true,
    username: fresh.username,
    // 会话密钥已轮换，旧 token 全部失效，这里补发一个新的，免得刚改完就被踢出去
    token: await issueSession(fresh),
    changed_password: Boolean(next),
    changed_username: Boolean(newUser) && newUser !== admin.username,
  });
}

/* ============================== 接口 ============================== */

// GET  /api/bootstrap  首次配置状态
// POST /api/bootstrap  写入首次生成的 Agent 令牌（仅未初始化时允许）
async function handleBootstrap(request, env) {
  if (request.method === "GET") {
    const token = await resolveAgentToken(env);
    const admin = await getAdmin(env);
    return json({
      ok: true,
      configured: Boolean(token),
      managed_by_env: Boolean(env.AGENT_TOKEN),
      view_protected: Boolean(env.VIEW_TOKEN),
      admin_configured: Boolean(admin),
      admin_username: admin ? admin.username : null,
    });
  }

  if (request.method !== "POST") return fail(405, "method not allowed");
  if (env.AGENT_TOKEN) return fail(409, "令牌由环境变量 AGENT_TOKEN 管理，无需初始化");
  // 认领上报令牌属于 Agent 配置，必须先登录管理员账户（或带 VIEW_TOKEN）。
  // 还没建账户时 viewAccess 会放行 —— 但那时谁先到谁建账户，见文件开头的说明。
  if (!(await viewAccess(request, env)).allowed) {
    return fail(401, "请先登录管理员账户");
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail(400, "invalid json body");
  }

  const token = toStr(body && body.token, 200);
  if (!token || token.length < 16) return fail(400, "令牌至少需要 16 个字符");

  // ON CONFLICT DO NOTHING 保证并发下只有一个请求能初始化成功
  const result = await env.DB
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('agent_token', ?) ON CONFLICT(key) DO NOTHING",
    )
    .bind(token)
    .run();

  if (!result.meta || !result.meta.changes) return fail(409, "已经初始化过了");
  return json({ ok: true });
}

// GET  /api/config  读取网页可改的全局配置
// POST /api/config  修改（目前只有上报间隔；传 null / 0 清除，回到 agent 自己的值）
async function handleConfig(request, env) {
  if (request.method === "GET") {
    return json({
      ok: true,
      interval: await getReportInterval(env),
      interval_min: MIN_REPORT_INTERVAL,
      interval_max: MAX_REPORT_INTERVAL,
      // 面板拿这些数字算「能带多少台 / 推荐多大间隔」（估算，按免费版额度）
      quota: {
        rows_per_report: ROWS_PER_REPORT,
        rows_written_per_day: FREE_ROWS_WRITTEN_PER_DAY,
        rows_read_per_day: FREE_ROWS_READ_PER_DAY,
        offline_after: OFFLINE_AFTER,
        metrics_retention_days: Math.round(RETENTION_SECONDS / 86400),
      },
    });
  }

  if (request.method !== "POST") return fail(405, "method not allowed");

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail(400, "invalid json body");
  }
  if (!body || typeof body !== "object") return fail(400, "invalid payload");

  if (body.interval === null || body.interval === 0) {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(REPORT_INTERVAL_KEY).run();
    return json({ ok: true, interval: null });
  }

  const raw = Number(body.interval);
  if (!Number.isFinite(raw) || raw <= 0) return fail(400, "interval 必须是正整数秒数");

  const interval = clamp(Math.round(raw), MIN_REPORT_INTERVAL, MAX_REPORT_INTERVAL);
  await env.DB
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(REPORT_INTERVAL_KEY, String(interval))
    .run();

  return json({ ok: true, interval: interval });
}

// 累计在线率：把距上次上报的间隔计入「已观测总时长」，其中不超过 OFFLINE_AFTER
// 的那段算作在线。服务器挂了很久再回来，超时的那一大段就会被记成离线。
//
// 累计流量：agent 上报的 net_rx / net_tx 是内核累计值，服务器重启会归零。
// 这里用 offset 兼容这种情况——若本次上报比上次存储的「原始值」小，就把上次
// 显示值固化为新 offset，让面板显示的累计流量继续单调递增。
const UPSERT_SERVER = `
INSERT INTO servers (
  id, name, grp, os, arch, cpu_info, cpu_cores, created_at, last_seen, online,
  cpu, load1, load5, load15,
  mem_used, mem_total, swap_used, swap_total,
  disk_used, disk_total,
  net_rx, net_tx,
  uptime, tcp, proc,
  net_rx_offset, net_tx_offset
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, 1,
  ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?,
  ?, ?,
  ?, ?, ?,
  0, 0
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name, grp = excluded.grp, os = excluded.os, arch = excluded.arch,
  cpu_info = excluded.cpu_info, cpu_cores = excluded.cpu_cores,
  last_seen = excluded.last_seen, online = 1,
  cpu = excluded.cpu, load1 = excluded.load1, load5 = excluded.load5, load15 = excluded.load15,
  mem_used = excluded.mem_used, mem_total = excluded.mem_total,
  swap_used = excluded.swap_used, swap_total = excluded.swap_total,
  disk_used = excluded.disk_used, disk_total = excluded.disk_total,
  net_rx = CASE
    WHEN excluded.net_rx >= (servers.net_rx - servers.net_rx_offset)
    THEN excluded.net_rx + servers.net_rx_offset
    ELSE excluded.net_rx + servers.net_rx
  END,
  net_rx_offset = CASE
    WHEN excluded.net_rx >= (servers.net_rx - servers.net_rx_offset)
    THEN servers.net_rx_offset
    ELSE servers.net_rx
  END,
  net_tx = CASE
    WHEN excluded.net_tx >= (servers.net_tx - servers.net_tx_offset)
    THEN excluded.net_tx + servers.net_tx_offset
    ELSE excluded.net_tx + servers.net_tx
  END,
  net_tx_offset = CASE
    WHEN excluded.net_tx >= (servers.net_tx - servers.net_tx_offset)
    THEN servers.net_tx_offset
    ELSE servers.net_tx
  END,
  uptime = excluded.uptime, tcp = excluded.tcp, proc = excluded.proc,
  online_seconds = online_seconds + MAX(0, MIN(? - last_seen, ?)),
  seen_seconds = seen_seconds + MAX(0, ? - last_seen)
`;

const INSERT_METRIC = `
INSERT INTO metrics (
  server_id, ts, cpu, load1, mem_used, mem_total, swap_used, swap_total,
  disk_used, disk_total, net_rx, net_tx, uptime, tcp, proc
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

// POST /api/report —— 服务器上的 agent 上报
async function handleReport(request, env) {
  const expected = await resolveAgentToken(env);
  const token = bearer(request);
  if (!expected) return fail(409, "尚未初始化，请先打开面板完成初始化");
  if (!token || !safeEqual(token, expected)) return fail(401, "invalid agent token");

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return fail(400, "invalid json body");
  }
  if (!body || typeof body !== "object") return fail(400, "invalid payload");

  const id = toStr(body.id, 64);
  if (!id) return fail(400, "missing server id");

  const now = nowSec();
  const ts = toInt(body.ts, now) || now;
  const cpu = clamp(toNum(body.cpu), 0, 100);

  const mem = body.mem || {};
  const swap = body.swap || {};
  const disk = body.disk || {};

  const memUsed = toInt(mem.used);
  const memTotal = toInt(mem.total);
  const swapUsed = toInt(swap.used);
  const swapTotal = toInt(swap.total);
  const diskUsed = toInt(disk.used);
  const diskTotal = toInt(disk.total);

  // 累计流量（字节）：agent 上报的内核累计值。
  // 出于兼容，如果 agent 还带 net_rx_rate / net_tx_rate，这里直接忽略。
  const netRx = toInt(body.net_rx);
  const netTx = toInt(body.net_tx);

  const load1 = toNum(body.load1);
  const load5 = toNum(body.load5);
  const load15 = toNum(body.load15);
  const uptime = toInt(body.uptime);
  const tcp = toInt(body.tcp);
  const proc = toInt(body.proc);

  // 查上次上报时间，用于按天拆分在线时长
  const prevRow = await env.DB
    .prepare("SELECT last_seen FROM servers WHERE id = ?")
    .bind(id)
    .first();
  const prevSeen = prevRow ? Number(prevRow.last_seen) || 0 : 0;

  const statements = [
    env.DB.prepare(UPSERT_SERVER).bind(
      id,
      toStr(body.name, 100) || id,
      toStr(body.group, 60) || "default",
      toStr(body.os, 100),
      toStr(body.arch, 40),
      toStr(body.cpu_info, 200),
      toInt(body.cpu_cores),
      now,
      now,
      cpu, load1, load5, load15,
      memUsed, memTotal, swapUsed, swapTotal,
      diskUsed, diskTotal,
      netRx, netTx,
      uptime, tcp, proc,
      now, OFFLINE_AFTER, now,
    ),
    env.DB.prepare(INSERT_METRIC).bind(
      id, ts, cpu, load1,
      memUsed, memTotal, swapUsed, swapTotal,
      diskUsed, diskTotal,
      netRx, netTx,
      uptime, tcp, proc,
    ),
  ];

  // 按 UTC 自然日拆分，累加到 uptime_daily，长期保留
  for (const row of splitByDay(prevSeen, now, OFFLINE_AFTER)) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO uptime_daily (server_id, day, online_seconds, seen_seconds) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(server_id, day) DO UPDATE SET " +
          "online_seconds = online_seconds + excluded.online_seconds, " +
          "seen_seconds = seen_seconds + excluded.seen_seconds",
      ).bind(id, row.day, row.online, row.seen),
    );
  }

  await env.DB.batch(statements);

  return json({ ok: true, id: id, ts: now, interval: await getReportInterval(env) });
}

// GET /api/servers
async function handleServers(request, env) {
  const now = nowSec();
  const out = await env.DB.prepare(
    "SELECT * FROM servers ORDER BY grp ASC, name ASC",
  ).all();
  const servers = (out.results || []).map(function (row) {
    const copy = Object.assign({}, row);
    copy.online = now - Number(row.last_seen || 0) <= OFFLINE_AFTER ? 1 : 0;
    // 内部字段不往前端发
    delete copy.net_rx_offset;
    delete copy.net_tx_offset;
    return copy;
  });
  return json({ ok: true, now: now, offline_after: OFFLINE_AFTER, servers: servers });
}

// GET /api/summary
async function handleSummary(request, env) {
  const now = nowSec();
  const summary = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN ? - last_seen <= ? THEN 1 ELSE 0 END), 0) AS online,
       COALESCE(SUM(CASE WHEN ? - last_seen <= ? THEN net_rx ELSE 0 END), 0) AS net_rx_total,
       COALESCE(SUM(CASE WHEN ? - last_seen <= ? THEN net_tx ELSE 0 END), 0) AS net_tx_total,
       COALESCE(SUM(CASE WHEN ? - last_seen <= ? THEN mem_used ELSE 0 END), 0) AS mem_used,
       COALESCE(SUM(CASE WHEN ? - last_seen <= ? THEN mem_total ELSE 0 END), 0) AS mem_total,
       COALESCE(AVG(CASE WHEN ? - last_seen <= ? THEN cpu END), 0) AS cpu
     FROM servers`,
  )
    .bind(
      now, OFFLINE_AFTER, now, OFFLINE_AFTER, now, OFFLINE_AFTER,
      now, OFFLINE_AFTER, now, OFFLINE_AFTER, now, OFFLINE_AFTER,
    )
    .first();
  return json({ ok: true, now: now, summary: summary || {} });
}

// GET /api/uptime?days=30 —— 按天在线率（长期保留）
async function handleUptime(request, env) {
  const url = new URL(request.url);
  const days = clamp(toInt(url.searchParams.get("days"), 30), 1, 365);
  const now = nowSec();
  const today = Math.floor(now / 86400);
  const since = today - days + 1;

  const out = await env.DB.prepare(
    `SELECT server_id, day, online_seconds, seen_seconds
     FROM uptime_daily
     WHERE day >= ?
     ORDER BY server_id ASC, day ASC`,
  )
    .bind(since)
    .all();

  const rows = (out.results || []).map(function (r) {
    const seen = Number(r.seen_seconds) || 0;
    const online = Number(r.online_seconds) || 0;
    return {
      server_id: r.server_id,
      day: Number(r.day),
      pct: seen > 0 ? (online / seen) * 100 : null,
    };
  });

  return json({ ok: true, now: now, today: today, days: days, rows: rows });
}

// GET /api/servers/:id/history?hours=6&points=90
async function handleHistory(request, env, serverId) {
  const url = new URL(request.url);
  const hours = clamp(toNum(url.searchParams.get("hours"), 6), 0.25, 168);
  const points = clamp(toInt(url.searchParams.get("points"), 90), 10, 720);
  const now = nowSec();
  const since = now - Math.round(hours * 3600);
  const bucket = Math.max(1, Math.round((hours * 3600) / points));

  const out = await env.DB.prepare(
    `SELECT
       (ts / ?) * ? AS bucket_ts,
       AVG(cpu) AS cpu,
       AVG(mem_used) AS mem_used,
       AVG(mem_total) AS mem_total,
       AVG(disk_used) AS disk_used,
       AVG(disk_total) AS disk_total,
       AVG(load1) AS load1
     FROM metrics
     WHERE server_id = ? AND ts >= ?
     GROUP BY ts / ?
     ORDER BY bucket_ts ASC`,
  )
    .bind(bucket, bucket, serverId, since, bucket)
    .all();

  return json({ ok: true, id: serverId, hours: hours, bucket: bucket, points: out.results || [] });
}

/* ============================== 面板页面 ============================== */

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Server Status</title>
<style>
  :root {
    --bg: #0b1020; --panel: #141a2e; --panel-2: #1b2238; --line: #26304a;
    --text: #e6ecff; --muted: #8b97b8; --ok: #34d399; --warn: #fbbf24;
    --crit: #f87171; --accent: #38bdf8; --accent-2: #a78bfa;
  }
  * { box-sizing: border-box; }
  /* 作者样式优先于浏览器默认样式，所以任何「设了 display 的类」（.row/.tabs/.modal…）
     都会盖掉 hidden 属性 —— 元素明明标了 hidden 却还在页面上（既挡视线也可能挡点击）。
     这里统一兜住，别再逐个补 [hidden] 规则了。 */
  [hidden] { display: none !important; }
  html { -webkit-text-size-adjust: 100%; }   /* 横屏时 iOS 不要给文字放大 */
  button, .card, .expand, select, input { touch-action: manipulation; }   /* 去掉 300ms 点击延迟 */
  body {
    margin: 0; min-height: 100vh; color: var(--text);
    background: radial-gradient(1200px 600px at 20% -10%, #1a2440 0%, var(--bg) 60%);
    font: 14px/1.5 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
  .top {
    display: flex; flex-wrap: wrap; align-items: center; gap: 16px;
    padding: 18px 22px; border-bottom: 1px solid var(--line);
    /* 不要磨砂效果：底色加深到接近不透明，滚动时内容不会透上来 */
    background: rgba(11, 16, 32, .96);
    position: sticky; top: 0; z-index: 10;
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand h1 { font-size: 17px; margin: 0; letter-spacing: .3px; }
  .logo { width: 12px; height: 12px; border-radius: 50%; background: var(--ok);
    box-shadow: 0 0 0 4px rgba(52, 211, 153, .18); }
  .stats { display: flex; flex-wrap: wrap; gap: 18px; margin-left: auto; }
  .stat { display: flex; flex-direction: column; align-items: flex-end; }
  .stat b { font-size: 15px; font-variant-numeric: tabular-nums; }
  .stat i { font-style: normal; font-size: 11px; color: var(--muted); }
  .actions { display: flex; align-items: center; gap: 10px; }
  /* 下面这两样只有手机端才用（手机端 .actions 变成右侧抽屉） */
  .menu-btn { display: none; }
  .drawer-head { display: none; }
  select, input[type=text], input[type=number], input[type=password] {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 8px; padding: 6px 8px; font-size: 13px;
  }
  input[type=number] { width: 88px; }
  .btn {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
  .btn:hover { border-color: #3d4d75; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #06202e; font-weight: 600; }
  .btn.primary:hover { filter: brightness(1.08); }
  .muted { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }

  .banner {
    margin: 18px 22px 0; padding: 16px 18px; border-radius: 14px;
    background: linear-gradient(180deg, var(--panel) 0%, var(--panel-2) 100%);
    border: 1px solid var(--line);
  }
  .banner h2 { margin: 0 0 8px; font-size: 15px; }
  .banner p { margin: 6px 0; color: var(--muted); font-size: 13px; }
  .banner code { color: var(--accent); word-break: break-all; }
  .banner pre {
    margin: 8px 0; padding: 10px 12px; background: #0c1226; border: 1px solid var(--line);
    border-radius: 8px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-all;
  }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
  .tok { font-size: 13px; color: var(--ok); word-break: break-all; }

  main {
    /* min(340px, 100%)：340px 是给桌面的理想宽度，但窄屏（360px 手机）不能比视口还宽，
       否则整页会横向滚动 */
    display: grid; grid-template-columns: repeat(auto-fill, minmax(min(340px, 100%), 1fr));
    gap: 16px; padding: 20px 22px 60px;
    /* 关键：不加这句时网格行默认 stretch，一张卡片展开会把同排其他卡片一起拉长 */
    align-items: start;
  }
  .card {
    background: linear-gradient(180deg, var(--panel) 0%, var(--panel-2) 100%);
    border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px 12px;
    transition: border-color .15s;
  }
  .card:hover { border-color: #35456b; }
  .card.offline { opacity: .58; filter: grayscale(.35); }
  .card-head { display: flex; align-items: center; gap: 10px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .dot.up { background: var(--ok); box-shadow: 0 0 0 4px rgba(52,211,153,.16); }
  .dot.down { background: var(--crit); box-shadow: 0 0 0 4px rgba(248,113,113,.14); }
  .title { display: flex; flex-direction: column; min-width: 0; }
  .title .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .title .sub { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .expand { margin-left: auto; width: 26px; height: 26px; flex: none; border-radius: 8px;
    border: 1px solid var(--line); background: transparent; color: var(--muted);
    cursor: pointer; font-size: 15px; line-height: 1; }
  .expand:hover { color: var(--text); border-color: #3d4d75; }
  .bars { margin: 12px 0 10px; display: flex; flex-direction: column; gap: 7px; }
  .bar-row { display: grid; grid-template-columns: 40px 1fr auto; align-items: center; gap: 9px; }
  .bar-label { font-size: 11px; color: var(--muted); }
  .bar-text { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bar { height: 6px; border-radius: 4px; background: #0c1226; overflow: hidden; }
  .fill { height: 100%; border-radius: 4px; background: var(--ok); transition: width .4s ease; }
  .fill.warn { background: var(--warn); }
  .fill.crit { background: var(--crit); }
  .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px 10px;
    padding: 10px 0 6px; border-top: 1px dashed var(--line); }
  .meta span { display: flex; flex-direction: column; }
  .meta b { font-size: 13px; font-variant-numeric: tabular-nums; }
  .meta i { font-style: normal; font-size: 10px; color: var(--muted); }
  .meta b.ok { color: var(--ok); }
  .meta b.warn { color: var(--warn); }
  .meta b.crit { color: var(--crit); }
  .card .meta .wide { grid-column: 1 / -1; display: flex; gap: 20px; }
  .foot { display: flex; justify-content: space-between; gap: 10px; font-size: 11px;
    color: var(--muted); padding-top: 8px; border-top: 1px solid var(--line); }
  .foot span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chart-wrap { margin-top: 10px; }
  canvas.chart { width: 100%; height: 160px; display: block; }
  .legend { display: flex; gap: 14px; font-size: 11px; color: var(--muted); margin-top: 4px; }
  .legend em { font-style: normal; display: inline-flex; align-items: center; gap: 5px; }
  .legend em::before { content: ""; width: 10px; height: 3px; border-radius: 2px; background: currentColor; }
  .legend .cpu { color: var(--accent); }
  .legend .mem { color: var(--accent-2); }
  .empty { text-align: center; color: var(--muted); padding: 80px 20px; }

  /* —— 按天在线率红绿柱 —— */
  .uptime-wrap { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--line); }
  .uptime-title { display: flex; justify-content: space-between; font-size: 10px;
    color: var(--muted); margin-bottom: 6px; }
  .uptime { display: flex; align-items: flex-end; gap: 1px; height: 14px; }
  .uptime i { flex: 1 1 0; min-width: 1px; height: 3px; border-radius: 1px;
    background: #232b45; display: block; }
  .uptime i.good { background: var(--ok); }
  .uptime i.warn { background: var(--warn); }
  .uptime i.bad  { background: var(--crit); }

  /* —— 单台曲线聚焦：卡片可点，选中的那张高亮 —— */
  .card { cursor: pointer; }
  .card.active { border-color: rgba(56,189,248,.6);
    box-shadow: 0 0 0 1px rgba(56,189,248,.28); }

  /* —— 额度估算 —— */
  .calc { margin-top: 12px; padding: 10px 12px; border: 1px dashed var(--line);
    border-radius: 10px; background: rgba(12,18,38,.5); }
  .calc-line { font-size: 12px; color: var(--muted); line-height: 1.65;
    font-variant-numeric: tabular-nums; }
  .calc-line b { color: var(--text); }
  .calc .row { margin: 8px 0 0; }

  /* —— 登录 / 创建账户弹窗 —— */
  .modal { position: fixed; inset: 0; z-index: 50; padding: 20px;
    background: rgba(6,10,22,.82);
    display: flex; align-items: center; justify-content: center;
    animation: modal-fade .14s ease-out; }
  @keyframes modal-fade { from { opacity: 0 } to { opacity: 1 } }
  @keyframes modal-rise {
    from { opacity: 0; transform: translateY(10px) scale(.985) }
    to   { opacity: 1; transform: none }
  }
  .modal-box { position: relative; width: 100%; max-width: 396px; border-radius: 16px;
    padding: 22px 22px 18px; border: 1px solid var(--line);
    background: linear-gradient(180deg, #18203a 0%, var(--panel) 55%, var(--panel-2) 100%);
    box-shadow: 0 24px 60px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.04);
    animation: modal-rise .18s cubic-bezier(.2,.8,.3,1); }
  @media (prefers-reduced-motion: reduce) {
    .modal, .modal-box { animation: none; }
  }
  .modal-x { position: absolute; top: 10px; right: 10px; width: 28px; height: 28px;
    border: 0; border-radius: 8px; background: transparent; color: var(--muted);
    font-size: 18px; line-height: 1; cursor: pointer; }
  .modal-x:hover { background: rgba(255,255,255,.07); color: var(--text); }
  .modal-head { display: flex; gap: 12px; align-items: flex-start; margin-right: 26px; }
  .modal-head .lock { flex: none; width: 34px; height: 34px; border-radius: 10px;
    display: grid; place-items: center; font-size: 15px;
    background: rgba(56,189,248,.14); border: 1px solid rgba(56,189,248,.35); }
  .modal-head h2 { margin: 2px 0 3px; font-size: 16px; }
  .modal-head p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
  .tabs { display: flex; gap: 4px; margin: 15px 0 2px; padding: 3px;
    background: #0c1226; border: 1px solid var(--line); border-radius: 10px; }
  .tab { flex: 1 1 0; border: 0; border-radius: 7px; padding: 6px 8px; cursor: pointer;
    background: transparent; color: var(--muted); font-size: 12.5px; }
  .tab:hover { color: var(--text); }
  .tab.on { background: var(--panel-2); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,.3); }
  .field { display: block; margin: 13px 0 0; }
  .field > span { display: block; margin-bottom: 5px; font-size: 12px; color: var(--muted); }
  .field input { width: 100%; padding: 9px 11px; font-size: 13.5px; }
  .field input:focus { outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(56,189,248,.16); }
  .modal-box .btn.wide { display: block; width: 100%; margin-top: 16px;
    padding: 9px; font-size: 14px; }
  .modal-box .btn[disabled] { opacity: .55; cursor: default; }
  .hint { min-height: 17px; margin: 10px 0 0; font-size: 12px; color: var(--muted); }
  .hint.err { color: var(--crit); }
  .hint.ok { color: var(--ok); }
  .hint.info { color: var(--warn); }
  body.modal-open { overflow: hidden; }

  /* ============================ 手机端 ============================ */
  @media (max-width: 640px) {
    /* 顶栏：品牌 + 操作一行，统计项换行成一条可横向滑动的条 */
    .top { padding: 12px 14px; gap: 10px; }
    .brand h1 { font-size: 15px; }
    .stats { order: 3; width: 100%; margin-left: 0; gap: 16px;
      overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
    .stat { flex: none; align-items: flex-start; }
    .stat b { font-size: 14px; }
    /* —— 顶栏选项收进右侧抽屉 —— */
    .menu-btn { display: inline-flex; flex-direction: column; align-items: center;
      justify-content: center; margin-left: auto; width: 38px; height: 38px; padding: 0; }
    .menu-btn i { display: block; width: 16px; height: 2px; border-radius: 2px;
      background: currentColor; margin: 2px 0; }
    .drawer-head { display: block; order: 0; margin-bottom: 2px;
      font-size: 13px; color: var(--muted); }
    /* 抽屉故意不做遮罩层：全屏的（哪怕是透明的）覆盖层极容易盖住页面把点击全吃掉 ——
       顶栏是 sticky + z-index:10，抽屉在它内部的层叠上下文里，外面的层很容易反超它。
       「点抽屉外面收起」改成在 document 上按捕获阶段判断，见脚本里的 setMenu。 */
    .actions { position: fixed; top: 0; right: 0; bottom: 0; z-index: 60;
      width: min(78vw, 300px); margin: 0;
      padding: 16px 16px calc(18px + env(safe-area-inset-bottom));
      flex-direction: column; flex-wrap: nowrap; align-items: stretch; gap: 10px;
      background: linear-gradient(180deg, #18203a 0%, var(--panel-2) 100%);
      border-left: 1px solid var(--line); box-shadow: -18px 0 44px rgba(0,0,0,.5);
      overflow-y: auto; transform: translateX(103%);
      transition: transform .22s cubic-bezier(.2,.8,.3,1); }
    .actions.open { transform: none; }
    /* 抽屉里控件排成一列、占满宽度 */
    .actions select, .actions .btn { width: 100%; font-size: 16px; padding: 9px 11px; }
    .actions select { min-width: 0; }
    .actions #range { order: 1; }
    .actions #udays { order: 2; }
    .actions #allBtn { order: 3; }
    .actions #agentBtn { order: 4; }
    .actions #updated { order: 5; display: block; margin-top: 2px; }
    body.menu-open { overflow: hidden; }      /* 只在手机端锁滚动 */

    main { padding: 14px 14px 44px; gap: 12px; }
    .card { padding: 12px 13px 10px; }
    .card:active { border-color: #3d4d75; }   /* 触摸反馈 */
    .expand { width: 34px; height: 34px; font-size: 17px; }
    .bar-row { grid-template-columns: 34px 1fr auto; gap: 7px; }
    .meta { grid-template-columns: repeat(2, 1fr); }
    canvas.chart { height: 140px; }
    .empty { padding: 50px 16px; }
    .uptime { height: 16px; }

    /* 提示条 / 配置面板：留白收一点，按钮加大到手指好点 */
    .banner { margin: 14px 14px 0; padding: 14px; border-radius: 12px; }
    .banner pre { font-size: 11px; }
    .banner .btn { font-size: 16px; padding: 8px 12px; }
    .calc-line { font-size: 11.5px; }

    /* 弹窗改成从底部升起，输入框 16px 免得 iOS 聚焦时把页面放大 */
    .modal { padding: 12px; align-items: flex-end; }
    .modal-box { max-width: none; border-radius: 16px 16px 0 0;
      padding: 18px 16px calc(14px + env(safe-area-inset-bottom)); }
    .field input, .modal-box input { font-size: 16px; }

    /* 刘海 / 圆角屏 */
    .top { padding-left: max(14px, env(safe-area-inset-left));
      padding-right: max(14px, env(safe-area-inset-right)); }
    main { padding-left: max(14px, env(safe-area-inset-left));
      padding-right: max(14px, env(safe-area-inset-right)); }
  }

  /* 很窄的屏（<=380px）：只留进度条，别让数字挤成一团 */
  @media (max-width: 380px) {
    .bar-text { display: none; }
    .bar-row { grid-template-columns: 34px 1fr; }
    .title .sub { font-size: 10px; }
    .calc .row { gap: 6px; }
  }
</style>
</head>
<body>
  <header class="top">
    <div class="brand"><span class="logo"></span><h1>Server Status</h1></div>
    <div class="stats" id="summary"></div>
    <div class="actions" id="topMenu">
      <select id="range" title="历史时间范围">
        <option value="1">近 1 小时</option>
        <option value="6" selected>近 6 小时</option>
        <option value="24">近 24 小时</option>
        <option value="72">近 3 天</option>
      </select>
      <select id="udays" title="按天在线率统计天数">
        <option value="14">近 14 天在线率</option>
        <option value="30" selected>近 30 天在线率</option>
        <option value="60">近 60 天在线率</option>
        <option value="90">近 90 天在线率</option>
      </select>
      <span class="muted" id="updated">加载中…</span>
      <button class="btn" id="allBtn" type="button">全部曲线</button>
      <button class="btn" id="agentBtn" type="button">Agent 配置</button>
      <div class="drawer-head"><span>选项</span></div>
    </div>
    <button class="btn menu-btn" id="menuBtn" type="button" aria-label="选项" aria-controls="topMenu">
      <i></i><i></i><i></i>
    </button>
  </header>


  <section class="banner" id="agent" hidden>
    <h2>Agent 接入</h2>
    <p>上报地址：<code id="ep"></code></p>
    <div class="row">
      <span>服务器名称：<input type="text" id="nameInput" placeholder="我的服务器" /></span>
      <span>分组：<input type="text" id="groupInput" placeholder="default" /></span>
      <span class="muted">只改显示名；机器 ID 仍取主机名，免得重名冲突</span>
    </div>
    <div class="row">
      <span>上报令牌：<code class="tok" id="tk">（未保存）</code></span>
      <input type="text" id="tkInput" placeholder="粘贴令牌" />
      <button class="btn" id="tkSave" type="button">保存</button>
    </div>
    <div class="row" id="claimRow" hidden>
      <span>还没有启用上报令牌：</span><code class="tok" id="newToken"></code>
      <button class="btn primary" id="enableBtn" type="button">启用并开始</button>
    </div>
    <div class="row">
      <span>上报间隔：<input type="number" id="ivInput" min="2" max="120" step="1" /> 秒</span>
      <button class="btn" id="ivSave" type="button">保存</button>
      <button class="btn" id="ivClear" type="button">跟随各机</button>
      <span class="muted" id="ivHint"></span>
    </div>
    <div class="calc" id="calcBox">
      <div class="calc-line" id="quotaWrite">额度估算：打开这一页时按 D1 免费版额度算。</div>
      <div class="calc-line" id="quotaCapacity"></div>
      <div class="calc-line" id="quotaRead"></div>
      <div class="row">
        <button class="btn" id="quotaApply" type="button">用推荐值</button>
        <span class="muted" id="quotaNote"></span>
      </div>
    </div>
    <p>Linux · 前台试跑（Ctrl+C 就停）：</p>
    <pre id="cmdLinux"></pre>
    <div class="row"><button class="btn" type="button" data-copy="cmdLinux">复制</button></div>
    <p>Linux · 装成后台服务，开机自启（推荐，需要 root）：</p>
    <pre id="cmdService"></pre>
    <div class="row"><button class="btn" type="button" data-copy="cmdService">复制</button></div>
    <p>Windows PowerShell：</p>
    <pre id="cmdWin"></pre>
    <div class="row"><button class="btn" type="button" data-copy="cmdWin">复制</button></div>
    <p class="muted">换浏览器或清空缓存后，在这里粘贴令牌即可继续查看；也可以在 Worker 里设置 AGENT_TOKEN 环境变量彻底固定令牌。多台机器用 <code>PROBE_NAME</code> / <code>PROBE_GROUP</code> 区分。</p>

    <h2>管理员账户</h2>
    <div class="row">
      <span>当前账户：<code id="adminName">—</code></span>
      <button class="btn" id="logoutBtn" type="button">退出登录</button>
    </div>
    <div class="row" id="admForm">
      <input type="text" id="admUser" placeholder="新用户名（留空不改）" />
      <input type="password" id="admPass" placeholder="当前密码" autocomplete="current-password" />
      <input type="password" id="admNext" placeholder="新密码（留空不改，至少 8 位）" autocomplete="new-password" />
      <button class="btn" id="admSave" type="button">保存</button>
    </div>
    <p class="muted" id="admHint">改密码后，其他设备 / 浏览器上的旧会话会立即失效。用 VIEW_TOKEN 进入时「当前密码」可以留空。</p>
  </section>

  <div class="modal" id="authModal" hidden>
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="authTitle">
      <button class="modal-x" id="authClose" type="button" title="关闭" aria-label="关闭">×</button>
      <div class="modal-head">
        <span class="lock" aria-hidden="true">🔒</span>
        <div>
          <h2 id="authTitle">解锁 Agent 配置</h2>
          <p id="authSub">看板数据不用登录，只有这里需要管理员账户。</p>
        </div>
      </div>

      <div class="tabs" id="authTabs" hidden>
        <button class="tab on" id="tabAccount" type="button">管理员账户</button>
        <button class="tab" id="tabToken" type="button">访问令牌</button>
      </div>

      <div id="authAccount">
        <div id="authLogin" hidden>
          <label class="field"><span>用户名</span>
            <input type="text" id="loginUser" placeholder="admin" autocomplete="username" />
          </label>
          <label class="field"><span>密码</span>
            <input type="password" id="loginPass" placeholder="账户密码" autocomplete="current-password" />
          </label>
          <button class="btn primary wide" id="loginBtn" type="button">登录</button>
        </div>
        <div id="authCreate" hidden>
          <label class="field"><span>用户名</span>
            <input type="text" id="newUser" value="admin" placeholder="3-32 位字母 / 数字 / . _ -"
              autocomplete="username" />
          </label>
          <label class="field"><span>密码</span>
            <input type="password" id="newPass" placeholder="至少 8 位" autocomplete="new-password" />
          </label>
          <label class="field"><span>确认密码</span>
            <input type="password" id="newPass2" placeholder="再输一次" autocomplete="new-password" />
          </label>
          <button class="btn primary wide" id="adminCreateBtn" type="button">创建并登录</button>
        </div>
      </div>

      <div id="authToken" hidden>
        <label class="field"><span>VIEW_TOKEN</span>
          <input type="text" id="gateInput" placeholder="粘贴 Worker 环境变量里的令牌" />
        </label>
        <button class="btn primary wide" id="gateBtn" type="button">用令牌解锁</button>
      </div>

      <p class="hint" id="authHint"></p>
    </div>
  </div>

  <main id="grid"></main>
  <div class="empty" id="empty" hidden>暂无服务器上报数据。点右上角「Agent 配置」创建管理员账户后，即可看到接入命令。</div>

<script>
(function () {
  "use strict";

  var REFRESH_MS = 5000;
  var LS_KEY = "cf_probe_token";
  var ADMIN_LS_KEY = "cf_admin_token";
  var LS_NAME = "cf_probe_name";
  var LS_GROUP = "cf_probe_group";

  var grid = document.getElementById("grid");
  var summaryEl = document.getElementById("summary");
  var updatedEl = document.getElementById("updated");
  var emptyEl = document.getElementById("empty");
  var rangeEl = document.getElementById("range");
  var udaysEl = document.getElementById("udays");
  var ivInput = document.getElementById("ivInput");
  var ivHint = document.getElementById("ivHint");

  var params = new URLSearchParams(location.search);
  var urlToken = params.get("token") || params.get("view_token");
  var viewToken = urlToken || localStorage.getItem("view_token") || "";
  if (urlToken) localStorage.setItem("view_token", urlToken);

  var agentToken = localStorage.getItem(LS_KEY) || "";
  // 管理员会话（登录 / 创建账户后拿到），存在浏览器里，随请求头 x-admin-token 发出
  var adminToken = localStorage.getItem(ADMIN_LS_KEY) || "";
  var adminUser = localStorage.getItem(ADMIN_LS_KEY + "_user") || "";
  var adminConfigured = false;
  var viewProtected = false;
  // 命令里用的显示名 / 分组（跟着浏览器走，默认「我的服务器」/ default）
  var serverName = localStorage.getItem(LS_NAME) || "我的服务器";
  var serverGroup = localStorage.getItem(LS_GROUP) || "default";
  // 从「Agent 配置」按钮进来的话，认证成功后自动把这面板打开
  var wantAgentPanel = false;
  // 数据 401 时是否已经弹过一次窗了（避免每 5 秒弹一次，糊住刚解锁的面板）
  var authPromptedForData = false;
  var serversCache = [];
  var nowTs = 0;
  var expandedAll = false;
  // 聚焦某一台时只画这一台的曲线（列表照旧显示全部）；null = 不聚焦
  var focusedId = null;
  var configured = false;

  // 按天在线率历史
  var uptimeData = {};
  var uptimeToday = 0;
  var uptimeDays = 30;

  function api(path, options) {
    var headers = {};
    if (viewToken) headers["x-view-token"] = viewToken;
    if (adminToken) headers["x-admin-token"] = adminToken;
    var init = options || {};
    if (init.body) headers["content-type"] = "application/json";
    init.headers = headers;
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401) {
          // 把后端的文案带出来（例如「用户名或密码不对」），另外打个标记方便区分
          var err = new Error((data && data.error) || "unauthorized");
          err.unauthorized = true;
          throw err;
        }
        if (!res.ok) throw new Error((data && data.error) || ("http " + res.status));
        return data;
      });
    });
  }

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    var units = ["KB", "MB", "GB", "TB", "PB"];
    var i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return n.toFixed(n >= 100 ? 0 : 1) + " " + units[i];
  }

  function pct(a, b) {
    a = Number(a) || 0; b = Number(b) || 0;
    return b > 0 ? Math.min(100, (a / b) * 100) : 0;
  }

  function duration(sec) {
    sec = Number(sec) || 0;
    if (sec <= 0) return "-";
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m";
  }

  function timeAgo(ts, now) {
    var diff = Math.max(0, (now || 0) - (Number(ts) || 0));
    if (diff < 60) return diff + "s 前";
    if (diff < 3600) return Math.floor(diff / 60) + "m 前";
    if (diff < 86400) return Math.floor(diff / 3600) + "h 前";
    return Math.floor(diff / 86400) + "d 前";
  }

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  // day 是「UTC 天序号」，与后端 splitByDay 保持一致
  function dayLabel(day) {
    var d = new Date(day * 86400000);
    return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }

  // 每台服务器一条「按天在线率红绿柱」：左旧右新，最后一格是今天
  function uptimeStrip(id) {
    var days = uptimeDays;
    var today = uptimeToday;
    var series = uptimeData[id] || {};
    var cells = "";
    var known = 0;
    var sum = 0;

    for (var i = days - 1; i >= 0; i--) {
      var d = today - i;
      var v = series[d];
      var has = typeof v === "number" && isFinite(v);
      var cls = "none";
      var h = 3;

      if (has) {
        cls = v >= 99 ? "good" : v >= 90 ? "warn" : "bad";
        h = Math.max(3, Math.round((v / 100) * 14));
        known += 1;
        sum += v;
      }

      var label = dayLabel(d) + " · " + (has ? v.toFixed(2) + "% 在线" : "无数据");
      cells += '<i class="' + cls + '" style="height:' + h + 'px" title="' + esc(label) + '"></i>';
    }

    var avg = known > 0 ? (sum / known).toFixed(2) + "%" : "—";

    return '<div class="uptime-wrap">' +
      '<div class="uptime-title"><span>' + days + " 天在线率 · 均值 " + avg + "</span><span>今天</span></div>" +
      '<div class="uptime">' + cells + "</div>" +
      "</div>";
  }

  function bar(label, value, text) {
    var v = Math.max(0, Math.min(100, Number(value) || 0));
    var cls = v >= 90 ? "crit" : v >= 70 ? "warn" : "ok";
    return '<div class="bar-row">' +
      '<span class="bar-label">' + label + "</span>" +
      '<div class="bar"><div class="fill ' + cls + '" style="width:' + v.toFixed(1) + '%"></div></div>' +
      '<span class="bar-text">' + esc(text) + "</span></div>";
  }

  function cardHtml(s) {
    var on = Number(s.online) === 1;
    // 聚焦某台时只画这一台的曲线；没聚焦时看「全部展开」开关。
    // 不管哪种情况，卡片列表都是全部服务器（见 renderGrid）。
    var isOpen = focusedId ? focusedId === s.id : expandedAll;
    var netRx = Number(s.net_rx) || 0;
    var netTx = Number(s.net_tx) || 0;
    // 累计在线率 = 判为在线的时间 / 被观测到的总时间（见 UPSERT_SERVER）
    var seen = Number(s.seen_seconds) || 0;
    var uptimePct = seen > 0 ? (Number(s.online_seconds) || 0) / seen * 100 : null;
    var uptimeCls = uptimePct === null ? "" : uptimePct >= 99 ? "ok" : uptimePct >= 95 ? "warn" : "crit";
    var uptimeTxt = uptimePct === null ? "—" : uptimePct.toFixed(2) + "%";
    var cardClass = "card";
    if (!on) cardClass += " offline";
    if (focusedId === s.id) cardClass += " active";
    return '<article class="' + cardClass + '" data-id="' + esc(s.id) + '">' +
      '<div class="card-head">' +
        '<span class="dot ' + (on ? "up" : "down") + '"></span>' +
        '<div class="title"><span class="name">' + esc(s.name || s.id) + "</span>" +
          '<span class="sub">' + esc(s.grp || "default") + " · " + esc(s.os || "unknown") + "</span></div>" +
        '<button class="expand" type="button" title="' + (isOpen ? "收起这一台的曲线" : "只看这一台的曲线") + '"' +
          ' aria-label="' + (isOpen ? "收起这一台的曲线" : "只看这一台的曲线") + '">' + (isOpen ? "−" : "+") + "</button>" +
      "</div>" +
      '<div class="bars">' +
        bar("CPU", s.cpu, (Number(s.cpu) || 0).toFixed(1) + "%") +
        bar("RAM", pct(s.mem_used, s.mem_total), bytes(s.mem_used) + " / " + bytes(s.mem_total)) +
        bar("DISK", pct(s.disk_used, s.disk_total), bytes(s.disk_used) + " / " + bytes(s.disk_total)) +
      "</div>" +
      '<div class="meta">' +
        "<span><b>" + bytes(netRx) + "</b><i>累计下载</i></span>" +
        "<span><b>" + bytes(netTx) + "</b><i>累计上传</i></span>" +
        "<span><b>" + (Number(s.load1) || 0).toFixed(2) + "</b><i>负载</i></span>" +
        "<span><b>" + (s.tcp || 0) + "</b><i>TCP</i></span>" +
        "<span><b>" + (s.proc || 0) + "</b><i>进程</i></span>" +
        "<span><b>" + duration(s.uptime) + "</b><i>运行</i></span>" +
        '<div class="wide" title="自开始监控以来，被判定为在线的时间占比">' +
          '<span><b class="' + uptimeCls + '">' + uptimeTxt + "</b><i>累计在线率</i></span>" +
        "</div>" +
      "</div>" +
      uptimeStrip(s.id) +
      '<div class="foot">' +
        "<span>" + esc(s.cpu_info || "") + (s.cpu_cores ? " · " + s.cpu_cores + "C" : "") + "</span>" +
        "<span>" + (on ? "" : "离线 · ") + timeAgo(s.last_seen, nowTs) + "</span>" +
      "</div>" +
      (isOpen
        ? '<div class="chart-wrap"><canvas class="chart" title="CPU % / 内存 % 曲线（左侧为百分比刻度）"></canvas>' +
          '<div class="legend"><em class="cpu">CPU %</em><em class="mem">内存 %</em></div></div>'
        : "") +
      "</article>";
  }

  function renderSummary(s) {
    summaryEl.innerHTML =
      '<span class="stat"><b>' + (s.online || 0) + "/" + (s.total || 0) + "</b><i>在线 / 总数</i></span>" +
      '<span class="stat"><b>' + (Number(s.cpu) || 0).toFixed(1) + "%</b><i>平均 CPU</i></span>" +
      '<span class="stat"><b>' +
        ((Number(s.mem_used) || 0) / (Number(s.mem_total) || 1) * 100).toFixed(1) +
        "%</b><i>内存占比</i></span>" +
      '<span class="stat"><b>' + bytes(s.net_rx_total) + "</b><i>累计下载合计</i></span>" +
      '<span class="stat"><b>' + bytes(s.net_tx_total) + "</b><i>累计上传合计</i></span>";
  }

  function findCanvas(id) {
    var cards = grid.querySelectorAll(".card");
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].dataset.id === id) return cards[i].querySelector("canvas.chart");
    }
    return null;
  }

  function drawChart(canvas, points) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 320;
    var h = 160;
    var padLeft = 36;   // 左侧留给百分比标签
    var padTop = 8;
    var padBottom = 8;
    var plotW = Math.max(10, w - padLeft);
    var plotH = Math.max(10, h - padTop - padBottom);

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // —— 横向百分比参考线 + 左侧百分比标签（0 / 25 / 50 / 75 / 100） ——
    ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (var p = 0; p <= 100; p += 25) {
      var y = padTop + plotH - (p / 100) * plotH;
      ctx.strokeStyle = (p === 0 || p === 100)
        ? "rgba(255,255,255,0.16)"
        : "rgba(255,255,255,0.06)";
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = "rgba(139,151,184,0.95)";
      ctx.fillText(p + "%", padLeft - 6, y);
    }

    // —— 竖向网格线（按时间等分，6 格） ——
    var vCount = 6;
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    for (var k = 1; k < vCount; k++) {
      var x = padLeft + (k / vCount) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();
    }

    if (!points || points.length === 0) return;

    var n = points.length;
    function xs(i) {
      return n === 1 ? padLeft + plotW / 2 : padLeft + (i / (n - 1)) * plotW;
    }
    function ys(v) {
      v = Math.max(0, Math.min(100, v));
      return padTop + plotH - (v / 100) * plotH;
    }
    function draw(get, color) {
      ctx.beginPath();
      for (var i = 0; i < n; i++) {
        var px = xs(i), py = ys(get(points[i]));
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
    }

    draw(function (p) { return Number(p.cpu) || 0; }, "#38bdf8");
    draw(function (p) {
      var t = Number(p.mem_total) || 0;
      return t > 0 ? ((Number(p.mem_used) || 0) / t) * 100 : 0;
    }, "#a78bfa");
  }

  function drawFor(id) {
    var canvas = findCanvas(id);
    if (!canvas) return;
    var hours = Number(rangeEl.value) || 6;
    api("/api/servers/" + encodeURIComponent(id) + "/history?hours=" + hours + "&points=120")
      .then(function (data) { drawChart(canvas, data.points); })
      .catch(function () { drawChart(canvas, []); });
  }

  function drawAll() {
    serversCache.forEach(function (s) { drawFor(s.id); });
  }

  // 统一的渲染入口：**列表永远是全部服务器**，focusedId 只决定「画哪一台的曲线」。
  // 点卡片是「只看这一台」，不是筛选服务器。
  function renderGrid() {
    // 聚焦的那台已经不在列表里（被删除 / 改了 id）就取消聚焦
    if (focusedId && serversCache.filter(function (s) { return s.id === focusedId; }).length === 0) {
      focusedId = null;
    }
    grid.innerHTML = serversCache.map(cardHtml).join("");
    emptyEl.hidden = serversCache.length > 0;
    updateAllButton();
    if (focusedId) drawFor(focusedId);
    else if (expandedAll) drawAll();
    updateQuota();   // 台数变了，额度估算跟着变
  }

  // 只看这一台 / 再点一次收起。切到单台时顺手关掉「全部展开」，两者互斥。
  function focusCard(id) {
    focusedId = (focusedId === id) ? null : id;
    expandedAll = false;
    renderGrid();
  }

  // 工具栏上那个按钮的文字跟随状态
  function updateAllButton() {
    document.getElementById("allBtn").textContent = expandedAll ? "收起全部" : "全部曲线";
  }

  function refresh() {
    return Promise.all([
      api("/api/summary"),
      api("/api/servers"),
      api("/api/uptime?days=" + uptimeDays),
    ])
      .then(function (out) {
        var summary = out[0].summary || {};
        var servers = out[1].servers || [];
        var up = out[2] || {};

        serversCache = servers;
        nowTs = out[1].now || 0;

        uptimeToday = Number(up.today) || 0;
        var map = {};
        (up.rows || []).forEach(function (r) {
          var byDay = map[r.server_id] || (map[r.server_id] = {});
          if (r.pct !== null && isFinite(r.pct)) byDay[r.day] = r.pct;
        });
        uptimeData = map;

        renderSummary(summary);
        renderGrid();
        updatedEl.textContent = "更新于 " + new Date().toLocaleTimeString();
      })
      .catch(function (err) {
        updatedEl.textContent = "更新失败：" + err.message;
        if (err.unauthorized && !authPromptedForData) {
          // 只在第一次自动弹：设了 VIEW_TOKEN 的部署，看板数据要令牌才给看
          openAuth({
            tab: "token",
            hint: "看板数据受 VIEW_TOKEN 保护：用令牌解锁即可（管理员账户只解锁 Agent 配置）。",
          });
        }
      });
  }

  /* ------------------ 首次初始化 ------------------ */

  function randomToken() {
    var a = new Uint8Array(24);
    crypto.getRandomValues(a);
    var out = "";
    for (var i = 0; i < a.length; i++) out += a[i].toString(16).padStart(2, "0");
    return out;
  }

  function setAgentToken(t) {
    agentToken = t || "";
    if (agentToken) localStorage.setItem(LS_KEY, agentToken);
    renderAgentPanel();
  }

  // 名称 / 分组会被拼进 shell 与 PowerShell 命令里，所以只放行安全字符：
  // 字母、数字、汉字、空格，以及 . _ : -（引号、$、反引号、; | & 之类一律丢掉）
  function safeField(v, fallback) {
    var s = String(v == null ? "" : v)
      .replace(/[^0-9A-Za-z\u4e00-\u9fa5 ._:-]/g, "")
      .slice(0, 60)
      .trim();
    return s || fallback;
  }

  // 只重画命令文本：改名称时用它，免得把输入框里的内容盖回去
  function renderCommands() {
    var origin = location.origin;
    var name = safeField(serverName, "我的服务器");
    var group = safeField(serverGroup, "default");
    var token = agentToken || "<令牌>";
    // 前台试跑
    document.getElementById("cmdLinux").textContent =
      "curl -fsSL " + origin + "/agent.sh | PROBE_ENDPOINT=" + origin + " \\\\\\n" +
      "PROBE_TOKEN=" + token + " \\\\\\n" +
      "PROBE_ID=$(hostname) PROBE_NAME=\\"" + name + "\\" PROBE_GROUP=" + group + " \\\\\\n" +
      "bash";
    // 装成 systemd 服务（install.sh 会把 PROBE_NAME 写进 /etc/cf-probe.env）
    document.getElementById("cmdService").textContent =
      "curl -fsSL " + origin + "/install.sh | PROBE_ENDPOINT=" + origin + " \\\\\\n" +
      "PROBE_TOKEN=" + token + " \\\\\\n" +
      "PROBE_ID=$(hostname) PROBE_NAME=\\"" + name + "\\" PROBE_GROUP=" + group + " \\\\\\n" +
      "bash";
    // Windows
    document.getElementById("cmdWin").textContent =
      "pip install psutil; iwr " + origin + "/agent.py -OutFile agent.py; " +
      "$env:PROBE_ENDPOINT=\\"" + origin + "\\"; $env:PROBE_TOKEN=\\"" + token + "\\"; " +
      "$env:PROBE_NAME=\\"" + name + "\\"; $env:PROBE_GROUP=\\"" + group + "\\"; python agent.py";
  }

  function renderAgentPanel() {
    var origin = location.origin;
    // 还没有启用过上报令牌时，先在浏览器里生成一个待认领的，命令里就能直接用
    if (!configured && !agentToken) agentToken = randomToken();
    document.getElementById("claimRow").hidden = configured;
    document.getElementById("newToken").textContent = agentToken;
    document.getElementById("ep").textContent = origin + "/api/report";
    document.getElementById("tk").textContent = agentToken || "（未保存）";
    document.getElementById("tkInput").value = "";
    document.getElementById("nameInput").value = serverName;
    document.getElementById("groupInput").value = serverGroup;
    renderCommands();
  }

  /* ------------- 额度估算：能带多少台 + 推荐上报间隔 ------------- */

  // 免费版额度：面板自带一份，/api/config 拿到的会覆盖它。
  // 这样即使配置接口失败、或者后端还是旧版本（响应里没有 quota），估算也照样显示。
  var quotaInfo = {
    rows_per_report: 5,
    rows_written_per_day: 100000,
    rows_read_per_day: 5000000,
  };
  var cfgInterval = null;   // 服务端当前下发的间隔（null = 跟随各机）
  var configError = "";     // 读配置失败的原因（非 401 时写在提示行里）
  // 推荐值只用到额度的 70%：贴着 100% 跑的话，多一台机器或一次清理就会当天超额
  var QUOTA_TARGET = 0.7;

  function fmtNum(n) {
    return Math.round(n).toLocaleString("en-US");
  }
  function intervalMin() { return Number(ivInput.min) || 2; }
  function intervalMax() { return Number(ivInput.max) || 120; }

  // 每台每天写入的行数 = 每天上报次数 × 每次行数
  function rowsPerServerPerDay(interval) {
    return (86400 / Math.max(1, interval)) * quotaInfo.rows_per_report;
  }
  function maxServersAt(interval) {
    return Math.floor(quotaInfo.rows_written_per_day / rowsPerServerPerDay(interval));
  }
  // 按额度算「必须至少多大间隔」：不加余量的原始值用来判断是否根本超容
  function requiredInterval() {
    var n = Math.max(1, serversCache.length);
    return (86400 * quotaInfo.rows_per_report * n) / quotaInfo.rows_written_per_day;
  }
  function recommendedInterval() {
    return Math.min(intervalMax(), Math.max(intervalMin(), Math.ceil(requiredInterval() / QUOTA_TARGET)));
  }
  // 连 MAX_REPORT_INTERVAL 都压不住 = 台数超出免费额度
  function overCapacity() {
    return requiredInterval() > intervalMax();
  }

  function updateQuota() {
    var n = serversCache.length;
    // 一台都还没有时按 1 台示意：新部署正好可以看看「一台机器要花多少额度」
    var basis = Math.max(1, n);
    var rec = recommendedInterval();
    var typed = Number(ivInput.value);
    var now = typed > 0 ? typed : (cfgInterval || rec);
    var per = rowsPerServerPerDay(now);
    var total = per * basis;

    document.getElementById("quotaWrite").textContent =
      "写入：按 " + now + " 秒，" + (n ? "" : "还没有服务器上报，先按 1 台示意：") +
      "每台约 " + fmtNum(per) + " 行/天；" + basis + " 台共 " + fmtNum(total) +
      " 行/天 —— 占免费写入额度（" + fmtNum(quotaInfo.rows_written_per_day) + " 行/天）的 " +
      (total / quotaInfo.rows_written_per_day * 100).toFixed(1) + "%";
    document.getElementById("quotaCapacity").textContent =
      "容量：这个间隔下约能带 " + maxServersAt(now) + " 台（当前 " + n + " 台）；按 " + basis +
      " 台算，推荐 " + rec + " 秒";

    // 读取：看板每轮 = 按天在线率(D 行/台) + 汇总 + 列表；agent 上报每次约 4 行
    var perRefresh = (uptimeDays + 2) * basis;
    var dashPerDay = (86400 / (REFRESH_MS / 1000)) * perRefresh;
    var agentPerDay = (86400 / Math.max(1, now)) * 4 * basis;
    document.getElementById("quotaRead").textContent =
      "读取：看板每轮约 " + fmtNum(perRefresh) + " 行，标签页一直开着约 " + fmtNum(dashPerDay) +
      " 行/天；agent 上报约 " + fmtNum(agentPerDay) + " 行/天 —— 合计占免费读取额度（" +
      fmtNum(quotaInfo.rows_read_per_day) + " 行/天）的 " +
      ((dashPerDay + agentPerDay) / quotaInfo.rows_read_per_day * 100).toFixed(1) + "%";

    var over = overCapacity();
    document.getElementById("quotaNote").textContent = configError ? configError : (over
      ? "台数已超出免费写入额度，即使 " + intervalMax() + " 秒也不够：减少机器或升级付费版"
      : (cfgInterval === null
        ? "当前还没统一设置间隔，上面的数字按推荐值估算"
        : (cfgInterval === rec ? "已经是最优值了" : "")));
    document.getElementById("quotaApply").hidden = over || cfgInterval === rec;
    document.getElementById("quotaApply").textContent = over ? "无法满足" : "用推荐值 " + rec + " 秒";
  }

  // 上报间隔：读回来填到输入框。没设置过就留空，表示跟随各 agent 自己的配置。
  function loadConfig() {
    return api("/api/config").then(function (cfg) {
      ivInput.min = cfg.interval_min;
      ivInput.max = cfg.interval_max;
      quotaInfo = cfg.quota || quotaInfo;
      cfgInterval = cfg.interval || null;
      configError = "";
      if (cfg.interval) {
        ivInput.value = String(cfg.interval);
        ivInput.placeholder = "";
        ivHint.textContent = "已下发：agent 下一轮上报后自动采用";
      } else {
        ivInput.value = "";
        ivInput.placeholder = "未统一设置";
        ivHint.textContent = "未统一设置，各服务器用安装时自己的间隔";
      }
      updateQuota();
    }).catch(function (err) {
      // 没解锁（或令牌不对）：收起面板并把弹窗叫出来
      if (err && err.unauthorized) {
        document.getElementById("agent").hidden = true;
        openAuth();
        return;
      }
      // 其它失败（后端旧版本 / 网络问题）：估算照常显示，把原因写在提示行里
      configError = "读配置失败（" + ((err && err.message) || "unknown") +
        "）：下面的数字按面板内置的默认额度算";
      updateQuota();
    });
  }

  // 提示行：kind 用 err / ok / info 控制颜色
  function setHint(text, kind) {
    var el = document.getElementById("authHint");
    el.textContent = text || "";
    el.className = "hint" + (kind ? " " + kind : "");
  }

  // 按钮文字（处理中时禁用全部按钮，避免重复提交）
  var AUTH_BTN_LABEL = { loginBtn: "登录", adminCreateBtn: "创建并登录", gateBtn: "用令牌解锁" };
  function setAuthBusy(btnId) {
    Object.keys(AUTH_BTN_LABEL).forEach(function (id) {
      var b = document.getElementById(id);
      b.disabled = Boolean(btnId);
      b.textContent = (id === btnId) ? "处理中…" : AUTH_BTN_LABEL[id];
    });
  }

  // 账户 / 令牌两个页签（只有设了 VIEW_TOKEN 时才需要切换）
  function showAuthTab(which) {
    var token = which === "token";
    document.getElementById("tabAccount").className = "tab" + (token ? "" : " on");
    document.getElementById("tabToken").className = "tab" + (token ? " on" : "");
    document.getElementById("authAccount").hidden = token;
    document.getElementById("authToken").hidden = !token;
  }

  // 「Agent 配置」及其接口的解锁弹窗。
  // 有账户 -> 登录；还没账户 -> 创建账户；设了 VIEW_TOKEN -> 多一个令牌页签。
  // opts.tab = "token" 时直接打开令牌页签（数据被 VIEW_TOKEN 挡住时就是这种情况）。
  function openAuth(opts) {
    var o = opts || {};
    authPromptedForData = true;   // 用户已经见过这个弹窗了
    var hasAccount = adminConfigured;

    document.getElementById("authLogin").hidden = !hasAccount;
    document.getElementById("authCreate").hidden = hasAccount;
    document.getElementById("authTabs").hidden = !viewProtected;
    document.getElementById("authTitle").textContent =
      hasAccount ? "解锁 Agent 配置" : "创建管理员账户";
    document.getElementById("authSub").textContent = hasAccount
      ? "看板数据不用登录，只有这里需要管理员账户。"
      : "创建一个账户来管理 Agent 接入；看板数据本身不用登录。";
    showAuthTab(o.tab === "token" && viewProtected ? "token" : "account");
    setAuthBusy(null);
    setHint(o.hint || "", o.hint ? "info" : "");

    document.getElementById("authModal").hidden = false;
    document.body.classList.add("modal-open");
    var focusEl = document.getElementById(hasAccount ? "loginUser" : "newUser");
    if (focusEl && focusEl.focus) focusEl.focus();
  }

  function closeAuth() {
    document.getElementById("authModal").hidden = true;
    document.body.classList.remove("modal-open");
    setAuthBusy(null);
  }

  // 认证成功后的统一收尾：关弹窗，然后按需打开 Agent 配置
  function afterAuth() {
    closeAuth();   // 顺带解锁滚动并复位按钮
    if (wantAgentPanel || !document.getElementById("agent").hidden) {
      wantAgentPanel = false;
      openAgentPanel();
    }
    return refresh();
  }

  // Agent 配置面板：打开时才去读 /api/config（它要权限）
  function openAgentPanel() {
    document.getElementById("agent").hidden = false;
    renderAgentPanel();
    renderAdminPanel();
    loadConfig();
  }

  function setAdminSession(token, user) {
    adminToken = token || "";
    if (user) adminUser = user;
    if (adminToken) localStorage.setItem(ADMIN_LS_KEY, adminToken);
    else localStorage.removeItem(ADMIN_LS_KEY);
    if (adminUser) localStorage.setItem(ADMIN_LS_KEY + "_user", adminUser);
    renderAdminPanel();
  }

  // 「Agent 配置」里的管理员账户区
  function renderAdminPanel() {
    var logged = Boolean(adminToken);
    var nameEl = document.getElementById("adminName");
    if (logged) nameEl.textContent = adminUser || "（已登录）";
    else if (viewToken) nameEl.textContent = "（用 VIEW_TOKEN 进入，未登录账户）";
    else nameEl.textContent = "（未登录）";
    document.getElementById("admForm").hidden = !(adminConfigured && (logged || viewToken));
    document.getElementById("logoutBtn").hidden = !logged;
    document.getElementById("admUser").placeholder =
      "新用户名（当前：" + (adminUser || "?") + "，留空不改）";
  }

  function bootstrap() {
    return api("/api/bootstrap").then(function (info) {
      configured = !!info.configured;
      adminConfigured = !!info.admin_configured;
      viewProtected = !!info.view_protected;
      if (info.admin_username) adminUser = info.admin_username;
      renderAgentPanel();
      renderAdminPanel();
      // 看板数据不再需要登录：直接加载
      return refresh();
    }).catch(function (err) {
      if (err.unauthorized) {
        openAuth();
        return null;
      }
      updatedEl.textContent = "初始化检查失败：" + err.message;
      return null;
    });
  }

  document.getElementById("enableBtn").addEventListener("click", function () {
    var token = document.getElementById("newToken").textContent;
    api("/api/bootstrap", { method: "POST", body: JSON.stringify({ token: token }) })
      .then(function () {
        // 顺手把令牌记到浏览器，并展开 Agent 接入面板
        localStorage.setItem(LS_KEY, token);
        agentToken = token;
        document.getElementById("agent").hidden = false;
        configured = true;
        document.getElementById("claimRow").hidden = true;
        renderAgentPanel();
        return refresh();
      })
      .catch(function (err) { alert("初始化失败：" + err.message); });
  });

  document.getElementById("authClose").addEventListener("click", function () {
    wantAgentPanel = false;
    closeAuth();
  });

  document.getElementById("tabAccount").addEventListener("click", function () {
    showAuthTab("account");
    setHint("", "");
  });

  document.getElementById("tabToken").addEventListener("click", function () {
    showAuthTab("token");
    setHint("", "");
  });

  // 点遮罩空白处关闭
  document.getElementById("authModal").addEventListener("click", function (e) {
    if (e.target === e.currentTarget) { wantAgentPanel = false; closeAuth(); }
  });

  // 手机端：顶栏选项的侧滑抽屉（桌面端这些 class 没有对应样式，等于什么都没做）。
  // 关闭途径：点抽屉外面（下面这个捕获阶段监听）、按 Esc、或在抽屉里点任意选项。
  // 没有遮罩层，所以「点外面收起」在 document 的捕获阶段判断：
  //   1) 点在抽屉/菜单钮之外 -> 收起，同时 stopPropagation 把这一下吃掉，
  //      否则它会落到下面的卡片上（比如顺带展开某台机器的曲线）；
  //   2) 收起状态时这个监听什么都不做。
  var menuOpen = false;

  function setMenu(open) {
    menuOpen = Boolean(open);
    document.getElementById("topMenu").className = "actions" + (menuOpen ? " open" : "");
    if (menuOpen) document.body.classList.add("menu-open");
    else document.body.classList.remove("menu-open");
  }

  document.addEventListener("click", function (e) {
    if (!menuOpen) return;
    var t = e.target;
    if (!t || typeof t.closest !== "function") return;
    if (t.closest("#topMenu") || t.closest("#menuBtn")) return;
    setMenu(false);
    if (e.stopPropagation) e.stopPropagation();
  }, true);

  document.getElementById("menuBtn").addEventListener("click", function () {
    setMenu(!menuOpen);   // 再点一次就收起
  });

  // 抽屉里点按钮就收起；下拉要等选完（change）再收 —— 点一下就收的话，
  // 原生选择器会因为元素滑出屏幕而立刻被取消，等于选不了。
  document.getElementById("topMenu").addEventListener("click", function (e) {
    if (e.target.closest(".btn")) setMenu(false);
  });
  document.getElementById("topMenu").addEventListener("change", function (e) {
    if (e.target.closest("select")) setMenu(false);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!document.getElementById("authModal").hidden) {
      wantAgentPanel = false;
      closeAuth();
    } else {
      setMenu(false);
    }
  });

  // 输入框里按回车 = 点对应按钮
  function enterSubmits(inputIds, btnId) {
    inputIds.forEach(function (id) {
      document.getElementById(id).addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          document.getElementById(btnId).click();
        }
      });
    });
  }
  enterSubmits(["loginUser", "loginPass"], "loginBtn");
  enterSubmits(["newUser", "newPass", "newPass2"], "adminCreateBtn");
  enterSubmits(["gateInput"], "gateBtn");

  document.getElementById("gateBtn").addEventListener("click", function () {
    var v = document.getElementById("gateInput").value.trim();
    if (!v) { setHint("请填 VIEW_TOKEN", "err"); return; }
    viewToken = v;
    localStorage.setItem("view_token", v);
    setAuthBusy("gateBtn");
    return afterAuth();
  });

  document.getElementById("loginBtn").addEventListener("click", function () {
    var u = document.getElementById("loginUser").value.trim();
    var p = document.getElementById("loginPass").value;
    if (!u || !p) { setHint("请填写用户名和密码", "err"); return; }
    setHint("", "");
    setAuthBusy("loginBtn");
    api("/api/login", { method: "POST", body: JSON.stringify({ username: u, password: p }) })
      .then(function (data) {
        setAdminSession(data.token, data.username);
        document.getElementById("loginPass").value = "";
        return afterAuth();
      })
      .catch(function (err) {
        setAuthBusy(null);
        setHint("登录失败：" + err.message, "err");
      });
  });

  document.getElementById("adminCreateBtn").addEventListener("click", function () {
    var u = document.getElementById("newUser").value.trim();
    var p = document.getElementById("newPass").value;
    var p2 = document.getElementById("newPass2").value;
    if (!u) { setHint("请填用户名", "err"); return; }
    if (p.length < 8) { setHint("密码至少 8 位", "err"); return; }
    if (p !== p2) { setHint("两次输入的密码不一致", "err"); return; }
    setHint("", "");
    setAuthBusy("adminCreateBtn");
    api("/api/admin/create", { method: "POST", body: JSON.stringify({ username: u, password: p }) })
      .then(function (data) {
        setAdminSession(data.token, data.username);
        adminConfigured = true;
        document.getElementById("newPass").value = "";
        document.getElementById("newPass2").value = "";
        return afterAuth();
      })
      .catch(function (err) {
        setAuthBusy(null);
        setHint("创建失败：" + err.message, "err");
      });
  });

  document.getElementById("admSave").addEventListener("click", function () {
    var hint = document.getElementById("admHint");
    var current = document.getElementById("admPass").value;
    var next = document.getElementById("admNext").value;
    var user = document.getElementById("admUser").value.trim();
    if (!next && !user) { hint.textContent = "没有要修改的内容"; return; }
    if (next && next.length < 8) { hint.textContent = "新密码至少 8 位"; return; }
    api("/api/admin/update", {
      method: "POST",
      body: JSON.stringify({ current: current, password: next, username: user }),
    })
      .then(function (data) {
        setAdminSession(data.token, data.username);
        document.getElementById("admPass").value = "";
        document.getElementById("admNext").value = "";
        document.getElementById("admUser").value = "";
        hint.textContent = "已保存" + (data.changed_password ? "；其他设备上的旧会话已全部失效" : "");
      })
      .catch(function (err) { hint.textContent = "保存失败：" + err.message; });
  });

  document.getElementById("logoutBtn").addEventListener("click", function () {
    setAdminSession("", "");
    authPromptedForData = false;   // 退出后允许下次再自动提示
    if (location.reload) location.reload();
  });

  document.getElementById("agentBtn").addEventListener("click", function () {
    var panel = document.getElementById("agent");
    if (!panel.hidden) { panel.hidden = true; return; }   // 已打开 -> 收起
    // 没解锁就先弹窗（有会话或用 VIEW_TOKEN 进来的就直接开）
    if (!adminToken && !viewToken) {
      wantAgentPanel = true;
      openAuth();
      return;
    }
    openAgentPanel();
  });

  // 改名称 / 分组：立刻重画下面的三条命令，并记在浏览器里
  // （已经装过的机器要重新执行一次安装命令才会改名）
  document.getElementById("nameInput").addEventListener("input", function () {
    serverName = safeField(document.getElementById("nameInput").value, "");
    localStorage.setItem(LS_NAME, serverName);
    renderCommands();
  });

  document.getElementById("groupInput").addEventListener("input", function () {
    serverGroup = safeField(document.getElementById("groupInput").value, "");
    localStorage.setItem(LS_GROUP, serverGroup);
    renderCommands();
  });

  document.getElementById("tkSave").addEventListener("click", function () {
    var v = document.getElementById("tkInput").value.trim();
    if (!v) return;
    setAgentToken(v);
  });

  document.getElementById("ivSave").addEventListener("click", function () {
    var v = parseInt(ivInput.value, 10);
    if (!v || v <= 0) { alert("请填一个正整数，单位秒"); return; }
    api("/api/config", { method: "POST", body: JSON.stringify({ interval: v }) })
      .then(loadConfig)
      .then(function () {
        ivHint.textContent = "已保存：" + ivInput.value + " 秒，agent 下一轮上报后自动采用";
      })
      .catch(function (err) { alert("保存失败：" + err.message); });
  });

  // 手动改数字时立刻重算估算（还没保存也能看效果）
  ivInput.addEventListener("input", function () { updateQuota(); });

  // 「用推荐值」：填进输入框并沿用保存逻辑
  document.getElementById("quotaApply").addEventListener("click", function () {
    if (!quotaInfo || document.getElementById("quotaApply").hidden) return;
    ivInput.value = String(recommendedInterval());
    updateQuota();
    document.getElementById("ivSave").click();
  });

  document.getElementById("ivClear").addEventListener("click", function () {
    api("/api/config", { method: "POST", body: JSON.stringify({ interval: null }) })
      .then(loadConfig)
      .catch(function (err) { alert("操作失败：" + err.message); });
  });

  /* ------------------ 交互 ------------------ */

  document.body.addEventListener("click", function (e) {
    var copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) {
      var el = document.getElementById(copyBtn.dataset.copy);
      if (el && navigator.clipboard) navigator.clipboard.writeText(el.textContent);
      return;
    }
    // 点卡片上的 + / −，或者点卡片主体：都只切换「这一台」的曲线，
    // 不再一次把所有服务器的曲线都画出来（要全部请用提示条上的「显示全部曲线」）。
    var card = e.target.closest(".card");
    if (card && card.dataset.id) {
      // 点在曲线上不切换，避免影响看图表
      if (e.target.closest("canvas.chart")) return;
      focusCard(card.dataset.id);
    }
  });

  rangeEl.addEventListener("change", function () {
    if (focusedId) drawFor(focusedId);
    else if (expandedAll) drawAll();
  });

  // 切换按天在线率的统计天数
  udaysEl.addEventListener("change", function () {
    uptimeDays = Number(udaysEl.value) || 30;
    if (configured) refresh();
  });

  // 「全部曲线」：一次把所有卡片的曲线都画出来，再点一次收起。
  // 点它同时退出单台聚焦，避免两种状态混在一起。
  document.getElementById("allBtn").addEventListener("click", function () {
    expandedAll = focusedId ? true : !expandedAll;
    focusedId = null;
    renderGrid();
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && configured) refresh();
  });

  bootstrap();
  setInterval(function () {
    if (!document.hidden && configured) refresh();
  }, REFRESH_MS);
})();
</script>
</body>
</html>`;

/* ============================== 入口 ============================== */

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-view-token, x-admin-token",
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const key in CORS_HEADERS) headers.set(key, CORS_HEADERS[key]);
  return new Response(response.body, { status: response.status, headers: headers });
}

// 说明：面板读取权限已经改成 viewAccess()（管理员会话 / VIEW_TOKEN / 尚未建账户），
// 见上面「管理员账户 / 登录会话」一节。

// base64 -> 原始字节。不能把 atob() 的结果直接交给 Response：atob 返回的是
// 「每个字符一个字节」的二进制字符串，Response 会再按 UTF-8 编码一次，
// 里面的多字节字符（比如中文注释）就会被二次编码成乱码。
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// base64(gzip(脚本)) -> 明文响应。流式解压，避免把明文整段放进内存常量。
function gunzipResponse(b64, type) {
  const stream = new Blob([b64ToBytes(b64)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream, {
    headers: {
      "content-type": type + "; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// 内嵌脚本的路由表。写成函数是为了在「请求发生时」才读取上面那些
// base64 常量，这样就不用操心 const 的声明顺序。
function scriptRoute(path) {
  if (path === "/agent.sh") return { b64: AGENT_SH_GZ_B64, type: "text/x-shellscript" };
  if (path === "/install.sh") return { b64: INSTALL_SH_GZ_B64, type: "text/x-shellscript" };
  if (path === "/agent.py") return { b64: AGENT_PY_GZ_B64, type: "text/x-python" };
  return null;
}

function bindHint() {
  return new Response(
    "<h2>还没有绑定 D1 数据库</h2>" +
      "<p>请到该 Worker 的「设置 → 绑定 → 添加 → D1 数据库」，变量名填写 <code>DB</code>，保存后再刷新本页。</p>",
    { status: 500, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export default {
  async fetch(request, env, ctx) {
    if (!env || !env.DB) return bindHint();

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    // 内嵌脚本下载：服务器上 curl 本站就能拿到，免手动上传文件
    const script = method === "GET" ? scriptRoute(path) : null;
    if (script) {
      return gunzipResponse(script.b64, script.type);
    }

    // 第一次访问时自动建表
    try {
      await ensureSchema(env);
    } catch (err) {
      return withCors(
        fail(
          500,
          "初始化数据表失败：" + String(err) +
            " ｜ 若反复失败，可在 D1 控制台执行 " +
            "DROP TABLE IF EXISTS servers; DROP TABLE IF EXISTS metrics; " +
            "DROP TABLE IF EXISTS settings; DROP TABLE IF EXISTS uptime_daily; 之后刷新本页重试。",
        ),
      );
    }

    if (path === "/api/health") {
      return withCors(json({ ok: true, ts: nowSec() }));
    }

    if (path === "/api/bootstrap") {
      return withCors(await handleBootstrap(request, env));
    }

    if (path === "/api/login" || path === "/api/admin/create" || path === "/api/admin/update") {
      if (method !== "POST") return withCors(fail(405, "method not allowed"));
      if (path === "/api/login") return withCors(await handleLogin(request, env));
      if (path === "/api/admin/create") return withCors(await handleAdminCreate(request, env));
      return withCors(await handleAdminUpdate(request, env));
    }

    if (path === "/api/report") {
      if (method !== "POST") return withCors(fail(405, "method not allowed"));
      if (ctx) ctx.waitUntil(maybePrune(env));
      return withCors(await handleReport(request, env));
    }

    if (path === "/api/config") {
      if (!(await viewAccess(request, env)).allowed) {
        return withCors(fail(401, "需要管理员登录，或提供 VIEW_TOKEN"));
      }
      return withCors(await handleConfig(request, env));
    }

    if (path.startsWith("/api/")) {
      if (method !== "GET") return withCors(fail(405, "method not allowed"));
      // 数据接口公开：账户密码只保护 Agent 配置，不保护看板
      if (!dataAllowed(request, env)) {
        return withCors(fail(401, "需要访问令牌"));
      }

      if (path === "/api/servers") return withCors(await handleServers(request, env));
      if (path === "/api/summary") return withCors(await handleSummary(request, env));
      if (path === "/api/uptime") return withCors(await handleUptime(request, env));

      const history = path.match(/^\/api\/servers\/([^/]+)\/history$/);
      if (history) {
        return withCors(await handleHistory(request, env, decodeURIComponent(history[1])));
      }
      return withCors(fail(404, "not found"));
    }

    if (path === "/" || path === "/index.html") {
      return new Response(DASHBOARD_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    return withCors(fail(404, "not found"));
  },

  // 可选：如果你在 Worker 里加了 Cron 触发器，就会走到这里
  async scheduled(event, env, ctx) {
    if (!env || !env.DB) return;
    await ensureSchema(env);
    const now = nowSec();
    await env.DB.batch([
      env.DB
        .prepare(
          "INSERT INTO settings (key, value) VALUES ('last_prune', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(String(now)),
      env.DB.prepare(
        "UPDATE servers SET online = CASE WHEN ? - last_seen <= ? THEN 1 ELSE 0 END",
      ).bind(now, OFFLINE_AFTER),
      env.DB.prepare("DELETE FROM metrics WHERE ts < ?").bind(now - RETENTION_SECONDS),
    ]);
  },
};
