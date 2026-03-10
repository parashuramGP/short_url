const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "links.json");
const BASE_URL = process.env.BASE_URL || `http://${HOST}:${PORT}`;

const clients = new Set();

ensureDataFile();

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    const initial = {
      links: [],
      totals: {
        linksCreated: 0,
        totalClicks: 0
      }
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
  }
}

function readStore() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end(message);
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function normalizeUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A destination URL is required");
  }

  const candidate = value.trim();
  const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  const parsed = new URL(withProtocol);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are allowed");
  }

  return parsed.toString();
}

function isValidCode(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{4,32}$/.test(value);
}

function generateCode(store) {
  do {
    const code = crypto.randomBytes(4).toString("base64url").slice(0, 6);
    if (!store.links.some((link) => link.code === code)) {
      return code;
    }
  } while (true);
}

function broadcastStats(store) {
  const payload = JSON.stringify(buildSummary(store));
  for (const client of clients) {
    client.write(`event: stats\n`);
    client.write(`data: ${payload}\n\n`);
  }
}

function buildSummary(store) {
  const activeLinks = store.links.filter((link) => !link.expiresAt || new Date(link.expiresAt) > new Date());
  const topLinks = [...store.links]
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 5)
    .map((link) => ({
      code: link.code,
      url: link.url,
      clicks: link.clicks,
      shortUrl: `${BASE_URL}/${link.code}`
    }));

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      linksCreated: store.totals.linksCreated,
      totalClicks: store.totals.totalClicks,
      activeLinks: activeLinks.length
    },
    topLinks
  };
}

function listLinks(store) {
  return store.links
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((link) => ({
      ...link,
      shortUrl: `${BASE_URL}/${link.code}`,
      isExpired: Boolean(link.expiresAt && new Date(link.expiresAt) <= new Date())
    }));
}

function serveStaticFile(reqPath, res) {
  const cleanPath = reqPath === "/" ? "/index.html" : reqPath;
  const relativePath = cleanPath.replace(/^\/+/, "");
  const resolvedPath = path.join(PUBLIC_DIR, relativePath);

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(resolvedPath, (error, content) => {
    if (error) {
      if (cleanPath !== "/index.html") {
        fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackError, fallbackContent) => {
          if (fallbackError) {
            sendText(res, 404, "Not found");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(fallbackContent);
        });
        return;
      }

      sendText(res, 404, "Not found");
      return;
    }

    const contentType = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png"
    }[path.extname(resolvedPath)] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
}

function isStaticAsset(reqPath) {
  return path.extname(reqPath) !== "";
}

async function handleApi(req, res, url) {
  const store = readStore();

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/links") {
    sendJson(res, 200, {
      links: listLinks(store),
      summary: buildSummary(store)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/links") {
    try {
      const body = await parseRequestBody(req);
      const normalizedUrl = normalizeUrl(body.url);
      const customCode = body.customCode?.trim();
      const expiresAt = body.expiresAt?.trim();

      let code = customCode || generateCode(store);

      if (customCode && !isValidCode(customCode)) {
        throw new Error("Custom code must be 4-32 characters using letters, numbers, _ or -");
      }

      if (store.links.some((link) => link.code.toLowerCase() === code.toLowerCase())) {
        sendJson(res, 409, { error: "Short code already exists" });
        return;
      }

      if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
        throw new Error("Expiration date must be a valid ISO date");
      }

      const entry = {
        id: crypto.randomUUID(),
        code,
        url: normalizedUrl,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt || null,
        clicks: 0,
        lastAccessedAt: null,
        clickHistory: []
      };

      store.links.push(entry);
      store.totals.linksCreated += 1;
      writeStore(store);
      broadcastStats(store);

      sendJson(res, 201, {
        link: {
          ...entry,
          shortUrl: `${BASE_URL}/${entry.code}`,
          isExpired: false
        },
        summary: buildSummary(store)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/links/")) {
    const code = decodeURIComponent(url.pathname.replace("/api/links/", ""));
    const index = store.links.findIndex((link) => link.code === code);

    if (index === -1) {
      sendJson(res, 404, { error: "Short code not found" });
      return;
    }

    store.links.splice(index, 1);
    writeStore(store);
    broadcastStats(store);
    sendJson(res, 200, { success: true, summary: buildSummary(store) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stats/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    res.write(`event: stats\n`);
    res.write(`data: ${JSON.stringify(buildSummary(store))}\n\n`);
    clients.add(res);

    req.on("close", () => {
      clients.delete(res);
    });
    return;
  }

  sendJson(res, 404, { error: "API route not found" });
}

function handleRedirect(req, res, url) {
  const store = readStore();
  const code = url.pathname.slice(1);
  const link = store.links.find((item) => item.code === code);

  if (!link) {
    serveStaticFile("/index.html", res);
    return true;
  }

  if (link.expiresAt && new Date(link.expiresAt) <= new Date()) {
    sendText(res, 410, "This short link has expired.");
    return true;
  }

  link.clicks += 1;
  link.lastAccessedAt = new Date().toISOString();
  link.clickHistory.push({
    timestamp: link.lastAccessedAt,
    userAgent: req.headers["user-agent"] || "Unknown",
    referrer: req.headers.referer || ""
  });
  link.clickHistory = link.clickHistory.slice(-25);
  store.totals.totalClicks += 1;
  writeStore(store);
  broadcastStats(store);

  res.writeHead(302, {
    Location: link.url,
    "Cache-Control": "no-store"
  });
  res.end();
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, BASE_URL);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (isStaticAsset(url.pathname)) {
      serveStaticFile(url.pathname, res);
      return;
    }

    if (url.pathname !== "/" && (req.method === "GET" || req.method === "HEAD")) {
      const redirected = handleRedirect(req, res, url);
      if (redirected) {
        return;
      }
    }

    serveStaticFile(url.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`URL shortener running at ${BASE_URL}`);
});
