const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = 3000;
const PUBLIC = path.join(__dirname);

// --- Secure Auth Setup (Salt & Hash & Sessions) ---
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_TIME = 15 * 60 * 1000; // 15 minutes in milliseconds

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, "sha512").toString("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getCurrentTimestamp() {
  return new Date().toISOString();
}

const users = {
  admin: {
    username: "admin",
    role: "admin",
    salt: "1a2b3c",
    hash: hashPassword("admin123", "1a2b3c"),
  },
  trainer: {
    username: "trainer",
    role: "trainer",
    salt: "x9y8z7",
    hash: hashPassword("train123", "x9y8z7"),
  },
};

// Sessions: { token: { username, role, createdAt, expiresAt, ip, userAgent } }
const sessions = {};

// Track failed login attempts per IP
const loginAttempts = {};

// --- Database & Temporary Storage ---
const defaultDb = {
  authLogs: [
    {
      id: 1,
      name: "trainer",
      type: "login",
      device: "Mobile",
      timestamp: "25-2-2026 08.15",
      status: "success",
    },
    {
      id: 2,
      name: "Arya Wibowo",
      type: "login",
      device: "Mobile",
      timestamp: "25-2-2026 08.32",
      status: "success",
    },
  ],
  payments: [
    {
      id: 1,
      member: "Arya Wibowo",
      category: "membership",
      amount: 350000,
      date: "2026-03-01",
      due: "2026-02-01",
      method: "Transfer Bank",
      status: "paid",
    },
    {
      id: 2,
      member: "Siti Rahayu",
      category: "trainer_rental",
      amount: 250000,
      date: "2026-03-01",
      due: "2026-02-01",
      method: "QRIS",
      status: "paid",
    },
  ],
  attendance: [
    {
      id: 1,
      member: "Arya Wibowo",
      date: "2026-02-07",
      checkIn: "",
      checkOut: "09:00",
      activity: "Weight Training",
      status: "present",
    },
  ],
  exercises: [
    {
      id: 1,
      member: "Arya Wibowo",
      exercise: "Bench Press",
      sets: 4,
      reps: 10,
      weight: 60,
      date: "2025-06-01",
      notes: "Good form",
    },
  ],
  earnings: [
    {
      id: 1,
      client: "Arya Wibowo",
      date: "2026-02-20",
      duration: "90 min",
      amount: 250000,
      status: "paid",
    },
  ],
  clients: [
    {
      id: 1,
      name: "Arya Wibowo",
      program: "Muscle Gain",
      goal: "Increase muscle mass by 5 kg",
      sessions: 12,
      status: "active",
    },
  ],
};

// Load persisted database from temp_db.json if it exists, otherwise use defaults
let db = defaultDb;
const tempDbPath = path.join(__dirname, "temp_db.json");
if (fs.existsSync(tempDbPath)) {
  try {
    const savedDb = JSON.parse(fs.readFileSync(tempDbPath, "utf-8"));
    db = savedDb;
  } catch (err) {
    db = defaultDb;
  }
}

// --- Session Management Utilities ---
function createSession(username, role, ip, userAgent) {
  const token = generateToken();
  const now = Date.now();
  sessions[token] = {
    username,
    role,
    createdAt: getCurrentTimestamp(),
    expiresAt: new Date(now + SESSION_TTL).toISOString(),
    ip,
    userAgent,
    isValid: true,
  };
  return token;
}

function validateSession(token) {
  if (!sessions[token]) return null;
  const session = sessions[token];
  
  // Check if session has expired
  if (new Date(session.expiresAt) < new Date()) {
    delete sessions[token];
    return null;
  }
  
  // Check if session was explicitly invalidated
  if (!session.isValid) {
    delete sessions[token];
    return null;
  }
  
  return session;
}

function revokeSession(token) {
  if (sessions[token]) {
    sessions[token].isValid = false;
    delete sessions[token];
  }
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.connection.remoteAddress ||
    "unknown"
  );
}

function trackLoginAttempt(ip) {
  const now = Date.now();
  if (!loginAttempts[ip]) {
    loginAttempts[ip] = { count: 0, firstAttempt: now, lockedUntil: 0 };
  }
  
  const attempt = loginAttempts[ip];
  
  // Check if IP is still locked
  if (attempt.lockedUntil > now) {
    return {
      allowed: false,
      message: "Too many login attempts. Try again later.",
      remainingTime: Math.ceil((attempt.lockedUntil - now) / 1000),
    };
  }
  
  // Reset if lockout period has passed
  if (attempt.lockedUntil <= now && attempt.lockedUntil > 0) {
    attempt.count = 0;
    attempt.firstAttempt = now;
    attempt.lockedUntil = 0;
  }
  
  attempt.count++;
  
  // Lock if too many attempts
  if (attempt.count > MAX_LOGIN_ATTEMPTS) {
    attempt.lockedUntil = now + LOCKOUT_TIME;
    return {
      allowed: false,
      message: "Too many login attempts. Account locked for 15 minutes.",
      remainingTime: 15 * 60,
    };
  }
  
  return { allowed: true };
}

// Temporarily store database into a JSON file whenever changes occur
function syncTempStorage() {
  fs.writeFile(
    path.join(__dirname, "temp_db.json"),
    JSON.stringify(db, null, 2),
    (err) => {
    },
  );
}

// --- SSE Setup (Server-Sent Events) ---
let sseClients = [];
function broadcastSSE(message) {
  sseClients.forEach((res) => res.write(`data: ${message}\n\n`));
}

// --- HTTP Server Definition ---
const requestHandler = async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  // Serve MPA Files
  if (pathname === "/" || pathname === "/login.html")
    return serveStatic(res, "login.html");
  if (pathname === "/admin.html") return serveStatic(res, "admin.html");
  if (pathname === "/trainer.html") return serveStatic(res, "trainer.html");
  if (pathname.endsWith(".css") || pathname.endsWith(".js"))
    return serveStatic(res, pathname.slice(1));

  // Advanced Connection: SSE Endpoint
  if (pathname === "/api/sse") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sseClients.push(res);
    return req.on(
      "close",
      () => (sseClients = sseClients.filter((client) => client !== res)),
    );
  }

  // Auth / Login API
  if (pathname === "/api/login" && method === "POST") {
    const clientIp = getClientIp(req);
    const userAgent = req.headers["user-agent"] || "unknown";
    
    // Check login rate limiting
    const rateLimitCheck = trackLoginAttempt(clientIp);
    if (!rateLimitCheck.allowed) {
      return json(res, 429, {
        error: rateLimitCheck.message,
        remainingTime: rateLimitCheck.remainingTime,
      });
    }
    
    const body = await readBody(req);
    const userObj = users[body.user];

    // Verify credentials: username exists and password hash matches
    if (userObj && userObj.hash === hashPassword(body.pass, userObj.salt)) {
      // Reset login attempts on successful login
      loginAttempts[clientIp] = { count: 0, firstAttempt: 0, lockedUntil: 0 };
      
      // Create session with full details
      const token = createSession(userObj.username, userObj.role, clientIp, userAgent);
      
      // Set secure HTTP-only cookie
      const cookieOptions = [
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${SESSION_TTL / 1000}`,
      ].join("; ");
      
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `fitz_token=${token}; ${cookieOptions}`,
      });
      
      // Log successful authentication
      db.authLogs.push({
        id: Date.now(),
        name: userObj.username,
        type: "login",
        device: userAgent.includes("Mobile") ? "Mobile" : "Desktop",
        timestamp: new Date().toLocaleString("id-ID"),
        status: "success",
      });
      syncTempStorage();
      
      return res.end(
        JSON.stringify({
          token,
          role: userObj.role,
          username: userObj.username,
          expiresAt: sessions[token].expiresAt,
        })
      );
    }
    
    // Log failed authentication attempt
    db.authLogs.push({
      id: Date.now(),
      name: body.user || "unknown",
      type: "login",
      device: userAgent.includes("Mobile") ? "Mobile" : "Desktop",
      timestamp: new Date().toLocaleString("id-ID"),
      status: "failed",
    });
    syncTempStorage();
    return json(res, 401, { error: "Invalid credentials" });
  }

  // Logout API - Revoke authentication token
  if (pathname === "/api/logout" && method === "POST") {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.split(" ")[1] : null;
    
    if (token) {
      const session = validateSession(token);
      if (session) {
      }
      revokeSession(token);
    }
    
    // Clear cookie on client side
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "fitz_token=; Path=/; HttpOnly; Max-Age=0; SameSite=Strict",
    });
    return res.end(JSON.stringify({ success: true, message: "Logged out" }));
  }

  // API Middleware (Token Auth check with Session Validation)
  if (pathname.startsWith("/api/")) {
    const authHeader = req.headers.authorization;
    const token = authHeader ? authHeader.split(" ")[1] : null;
    
    if (!token) {
      return json(res, 401, { error: "Missing authorization token" });
    }
    
    // Validate session: check existence and expiration
    const session = validateSession(token);
    if (!session) {
      return json(res, 401, {
        error: "Unauthorized or session expired",
        code: "UNAUTHORIZED",
      });
    }

    const pathParts = pathname.split("/");
    const table = pathParts[2];

    if (!db[table]) return json(res, 404, { error: "Table not found" });

    if (method === "GET") {
      return json(res, 200, db[table]);
    }

    if (method === "POST") {
      const body = await readBody(req);

      // Server-Side Validations
      if (table === "payments") {
        if (Number(body.amount) < 175000) {
          return json(res, 400, { error: "Minimum payment amount is 175000" });
        }
        if (!body.due || body.due.trim() === "") {
          return json(res, 400, { error: "Due date is required" });
        }
      }

      body.id = Date.now();
      db[table].push(body);
      syncTempStorage();
      broadcastSSE(`New data added to ${table}`);
      broadcastWS({ type: "SYNC_UPDATE" });

      return json(res, 201, body);
    }

    if (method === "DELETE" && pathParts[3]) {
      const id = parseInt(pathParts[3]);
      db[table] = db[table].filter((r) => r.id !== id);
      syncTempStorage();
      broadcastWS({ type: "SYNC_UPDATE" });
      return json(res, 200, { success: true });
    }
  }

  json(res, 404, { error: "Route not found" });
};

// --- Utilities ---
function serveStatic(res, file) {
  const ext = path.extname(file);
  const mime = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
  };
  fs.readFile(path.join(PUBLIC, file), (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": mime[ext] });
    res.end(data);
  });
}
function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(JSON.parse(buf || "{}")));
  });
}

// --- Servers ---
const server = http.createServer(requestHandler);

// --- Advanced Connection: WebSockets ---
const wss = new WebSocketServer({ server });
let wsClients = [];
wss.on("connection", (ws) => {
  wsClients.push(ws);
  ws.on("close", () => (wsClients = wsClients.filter((c) => c !== ws)));
});
function broadcastWS(data) {
  wsClients.forEach((client) => client.send(JSON.stringify(data)));
}

server.listen(PORT, () =>
  console.log(`http://localhost:${PORT}`),
);