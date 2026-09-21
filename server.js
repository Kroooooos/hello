const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://kroooooos.github.io";
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.createHash("sha256").update("date-invite:" + ADMIN_PASSWORD).digest("hex");
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const PUBLIC_DIR = path.join(__dirname, "public");
const INVITE_PAGE = path.join(__dirname, "docs", "index.html");

const FIELD_LIMITS = {
  to: 40,
  nickname: 40,
  contact: 80,
  date: 10,
  slot: 20,
  activities: 200,
  diet: 200,
  message: 1000,
};

// ---------- storage: TiDB/MySQL in production, JSON file locally ----------

function fileStore() {
  const file = path.join(__dirname, "data", "responses.json");
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : []);
  return {
    async init() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    },
    async insert(row) {
      const rows = read();
      rows.push(row);
      fs.writeFileSync(file, JSON.stringify(rows, null, 2));
    },
    async list() {
      return read().sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async remove(id) {
      fs.writeFileSync(file, JSON.stringify(read().filter((r) => r.id !== id), null, 2));
    },
  };
}

function mysqlStore() {
  const mysql = require("mysql2/promise");
  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    ssl: /^(true|1|yes)$/i.test(process.env.MYSQL_SSL || "") ? { minVersion: "TLSv1.2", rejectUnauthorized: true } : undefined,
    connectionLimit: 4,
  });
  return {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS date_responses (
        id VARCHAR(32) PRIMARY KEY,
        created_at VARCHAR(32) NOT NULL,
        payload TEXT NOT NULL
      ) DEFAULT CHARSET=utf8mb4`);
    },
    async insert(row) {
      const { id, created_at, ...rest } = row;
      await pool.query("INSERT INTO date_responses (id, created_at, payload) VALUES (?, ?, ?)", [
        id,
        created_at,
        JSON.stringify(rest),
      ]);
    },
    async list() {
      const [rows] = await pool.query("SELECT id, created_at, payload FROM date_responses ORDER BY created_at DESC");
      return rows.map((r) => ({ id: r.id, created_at: r.created_at, ...JSON.parse(r.payload) }));
    },
    async remove(id) {
      await pool.query("DELETE FROM date_responses WHERE id = ?", [id]);
    },
  };
}

const store = process.env.MYSQL_HOST ? mysqlStore() : fileStore();

// ---------- helpers ----------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too_large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("bad_json"));
      }
    });
  });
}

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
}

function rateLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    return list.length <= max;
  };
}
const submitLimit = rateLimiter(10, 3600 * 1000);
const loginLimit = rateLimiter(8, 15 * 60 * 1000);

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAdmin(req) {
  const m = /(?:^|;\s*)adm=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return false;
  const [exp, mac] = decodeURIComponent(m[1]).split(".");
  return Number(exp) > Date.now() && mac && safeEqual(mac, sign(exp));
}

function sessionCookie(req, value, maxAgeSec) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `adm=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
}

function ticketId() {
  const d = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  return `DATE-${d}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function clean(body) {
  const out = {};
  for (const [key, max] of Object.entries(FIELD_LIMITS)) {
    const v = body[key];
    out[key] = Array.isArray(v)
      ? v.map((x) => String(x).trim()).filter(Boolean).join(", ").slice(0, max)
      : String(v ?? "").trim().slice(0, max);
  }
  out.no_clicks = Math.max(0, Math.min(999, Number(body.no_clicks) || 0));
  return out;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

function serveStatic(res, full) {
  if (!fs.existsSync(full)) return send(res, 404, "Not found");
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(full)] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  fs.createReadStream(full).pipe(res);
}

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const route = `${req.method} ${url.pathname}`;

  if (!url.pathname.startsWith("/api/admin/") && req.headers.origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" });
      return res.end();
    }
  }

  if (route === "GET /api/health") return send(res, 200, { ok: true });

  if (route === "POST /api/respond") {
    if (!submitLimit(clientIp(req))) return send(res, 429, { error: "Too many submissions. Please try again later." });
    const body = await readJson(req);
    if (body.website) return send(res, 200, { id: ticketId() });
    const row = clean(body);
    if (!row.nickname || !row.date) return send(res, 400, { error: "Please fill in your name and a date." });
    const id = ticketId();
    await store.insert({ id, created_at: new Date().toISOString(), ...row });
    return send(res, 200, { id });
  }

  if (route === "POST /api/admin/login") {
    if (!ADMIN_PASSWORD) return send(res, 503, { error: "未设置 ADMIN_PASSWORD，后台已关闭" });
    if (!loginLimit(clientIp(req))) return send(res, 429, { error: "尝试次数过多，15 分钟后再试" });
    const { password } = await readJson(req);
    if (!safeEqual(String(password || ""), ADMIN_PASSWORD)) return send(res, 401, { error: "密码不正确" });
    const exp = String(Date.now() + SESSION_TTL_MS);
    return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, `${exp}.${sign(exp)}`, SESSION_TTL_MS / 1000) });
  }

  if (route === "POST /api/admin/logout") {
    return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
  }

  if (url.pathname.startsWith("/api/admin/")) {
    if (!isAdmin(req)) return send(res, 401, { error: "unauthorized" });
    if (route === "GET /api/admin/responses") return send(res, 200, { rows: await store.list() });
    const del = /^\/api\/admin\/responses\/([\w-]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && del) {
      await store.remove(del[1]);
      return send(res, 200, { ok: true });
    }
  }

  if (route === "GET /") return serveStatic(res, INVITE_PAGE);
  if (route === "GET /admin") return serveStatic(res, path.join(PUBLIC_DIR, "admin.html"));
  return send(res, 404, "Not found");
}

store.init().then(() => {
  http
    .createServer((req, res) =>
      handle(req, res).catch((err) => {
        console.error(err);
        if (!res.headersSent) send(res, err.message === "bad_json" || err.message === "too_large" ? 400 : 500, { error: "Something went wrong. Please try again." });
      })
    )
    .listen(PORT, () => console.log(`date-invite on :${PORT} (${process.env.MYSQL_HOST ? "mysql" : "file"} store)`));
});
