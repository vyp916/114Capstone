const fs = require('fs');
const path = require('path');
const multer = require('multer');
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
// optional UDP emitter for external consumers (native apps or other services)
const dgram = require('dgram');
const UDP_HOST = process.env.REACTION_UDP_HOST || null; // e.g. '127.0.0.1'
const UDP_PORT = process.env.REACTION_UDP_PORT ? Number(process.env.REACTION_UDP_PORT) : null;
let udpClient = null;
if (UDP_HOST && UDP_PORT) {
  udpClient = dgram.createSocket('udp4');
}
const bcrypt = require("bcryptjs");
const mysql = require("mysql2");
const session = require("express-session");
const bodyParser = require("body-parser");
// load .env into process.env when available
try {
  // 強制從與 server.js 同目錄的 .env 載入，避免因啟動目錄不同而讀不到
  require('dotenv').config({ path: path.resolve(__dirname, '.env') });
} catch (e) { /* dotenv optional in some environments */ }
// Debug: print minimal DB env to ensure correct .env is loaded (mask password length)
const debugDbEnv = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  passLen: process.env.DB_PASS ? String(process.env.DB_PASS).length : 0,
  name: process.env.DB_NAME
};
console.log('[boot] DB env ->', debugDbEnv);

// --------------------- 基本設定 ---------------------
app.use(express.static("public"));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "super_secret_key",
    resave: false,
    saveUninitialized: false
  })
);

// --------------------- MySQL 連線 ---------------------
const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "live_platform"
};
// Guard: if still using root with empty password, warn loudly
if (dbConfig.user === 'root' && !dbConfig.password) {
  console.warn('⚠️ DB is configured to use root with NO password. This will likely fail. Please set .env (DB_USER/DB_PASS).');
}
console.log('[boot] DB config ->', { host: dbConfig.host, port: dbConfig.port, user: dbConfig.user, name: dbConfig.database });

const db = mysql.createConnection(dbConfig);
db.connect(err => {
  if (err) {
    console.error('❌ 無法連線到資料庫：', err && err.message ? err.message : err);
    console.error('請檢查 .env 設定與 DB 使用者/密碼。當前設定：', { host: dbConfig.host, port: dbConfig.port, user: dbConfig.user, name: dbConfig.database });
    // 不再直接 throw，避免整個進程崩潰；可視需求改為 process.exit(1)
    return;
  }
  // Ensure 'age' column exists for older DBs created before this field was added
  db.query("ALTER TABLE users ADD COLUMN age INT DEFAULT NULL", (alterErr) => {
    if (alterErr) {
      // Ignore duplicate column error if column already exists
      if (alterErr.code === 'ER_DUP_FIELDNAME' || /Duplicate column name/.test(alterErr.message)) {
        // already present, ignore
      } else {
        console.warn('⚠️ 無法新增 users.age 欄位：', alterErr.message || alterErr);
      }
    }
  });
});

// --------------------- Health Check --------------------
app.get('/health', (req, res) => {
  db.ping(err => {
    const envSummary = {
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      name: dbConfig.database,
      hasPass: !!(process.env.DB_PASS)
    };
    if (err) {
      return res.status(500).json({ ok: false, error: String(err), env: envSummary });
    }
    res.json({ ok: true, env: envSummary });
  });
});

// --------------------- Multer：封面 & 頭像 ---------------------

// 直播封面：uploads/preview/<roomId>/cover.xxx
const coverStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const roomId = req.body.roomId;
    if (!roomId) return cb(new Error("缺少房間號 roomId"));
    const dir = path.join(__dirname, 'uploads', 'preview', roomId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, 'cover' + path.extname(file.originalname));
  }
});
const coverUpload = multer({ storage: coverStorage });

// 用戶頭像：uploads/avatars/avatar_<userId>.xxx
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!req.session.user || !req.session.user.id) {
      return cb(new Error("未登入，無法上傳頭像"));
    }
    const dir = path.join(__dirname, 'uploads', 'avatars');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const userId = req.session.user.id;
    cb(null, `avatar_${userId}${path.extname(file.originalname)}`);
  }
});
const avatarUpload = multer({ storage: avatarStorage });

// --------------------- Helper ---------------------
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// --------------------- Auth / User API ---------------------

// 註冊
app.post("/api/register", async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ message: "請完整輸入資料" });
  }

  db.query("SELECT id FROM users WHERE username = ?", [username], async (err, results) => {
    if (err) throw err;
    if (results.length > 0) {
      return res.status(409).json({ message: "使用者名稱已存在" });
    }
    const hashed = await bcrypt.hash(password, 10);
    // accept optional age and gender in registration payload
    const regGender = req.body.gender || '不透露';
    const regAge = req.body.age ? Number(req.body.age) : null;
    db.query(
      "INSERT INTO users (username, email, password, gender, age, avatar, balance) VALUES (?, ?, ?, ?, ?, '/uploads/default_avatar.png', 0.00)",
      [username, email, hashed, regGender, regAge],
      err2 => {
        if (err2) throw err2;
        return res.status(201).json({ message: "註冊成功！" });
      }
    );
  });
});

// 登入
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  db.query("SELECT * FROM users WHERE username = ?", [username], async (err, results) => {
    if (err) throw err;
    if (results.length === 0) return res.status(404).json({ message: "找不到帳號" });

    const user = results[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ message: "密碼錯誤" });

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      avatar: user.avatar,
      gender: user.gender,
      balance: user.balance
    };

  // session created
    return res.json({ message: "登入成功", redirect: "/index.html" });
  });
});

// 登出
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ message: "已登出" });
  });
});

// 取得個人資料（含擴充欄位）
app.get("/api/profile", (req, res) => {
  if (!req.session.user) return res.status(401).json({ message: "未登入" });
  db.query(
    "SELECT id, username, email, gender, age, avatar, balance FROM users WHERE id=?",
    [req.session.user.id],
    (err, results) => {
      if (err) throw err;
      if (!results[0]) return res.status(404).json({ message: "找不到使用者" });
      res.json(results[0]);
    }
  );
});

// 更新個人資料（目前先開放 username & gender）
app.post("/api/update-profile", (req, res) => {
  if (!req.session.user) return res.status(401).json({ message: "未登入" });
  const { username, gender, age } = req.body;
  const ageVal = (age === undefined || age === null || age === '') ? null : Number(age);

  db.query(
    "UPDATE users SET username = IFNULL(?, username), gender = IFNULL(?, gender), age = IFNULL(?, age) WHERE id=?",
    [username || null, gender || null, ageVal, req.session.user.id],
    err => {
      if (err) throw err;

      if (username) req.session.user.username = username;
      if (gender) req.session.user.gender = gender;
      if (ageVal !== null) req.session.user.age = ageVal;

      res.json({ message: "個人資料已更新" });
    }
  );
});

// 上傳頭像
app.post("/api/upload-avatar", avatarUpload.single("avatar"), (req, res) => {
  if (!req.session.user || !req.session.user.id) {
    return res.status(401).json({ message: "未登入" });
  }
  if (!req.file) {
    return res.status(400).json({ message: "❌ 未收到頭像檔案" });
  }

  const avatarPath = `/uploads/avatars/${req.file.filename}`;
  db.query(
    "UPDATE users SET avatar=? WHERE id=?",
    [avatarPath, req.session.user.id],
    err => {
      if (err) {
        console.error("❌ 更新頭像失敗：", err);
        return res.status(500).json({ message: "更新失敗" });
      }
      req.session.user.avatar = avatarPath;
      res.json({ message: "頭像更新成功", avatar: avatarPath });
    }
  );
});

// --------------------- Stream / 封面 / 狀態 ---------------------

// 建立新直播間
app.post("/api/start-stream", (req, res) => {
  if (!req.session.user) return res.status(401).json({ message: "未登入" });

  const { title, description, hashtags } = req.body;
  const roomId = generateRoomCode();

  db.query(
    "INSERT INTO streams (user_id, room_id, title, description, hashtags, status, last_active) VALUES (?,?,?,?,?,TRUE,NOW())",
    [req.session.user.id, roomId, title, description, hashtags],
    err => {
      if (err) throw err;

      // 更新 hashtag 熱門度
      const tags = hashtags ? hashtags.split(/\s+/).filter(t => t.startsWith('#')) : [];
      tags.forEach(tag => {
        db.query(
          "INSERT INTO hashtags (tag_name) VALUES (?) ON DUPLICATE KEY UPDATE usage_count = usage_count + 1",
          [tag]
        );
      });

      res.json({ message: "直播間建立成功！", roomId });
    }
  );
});

// 上傳直播封面
app.post('/api/upload-cover', coverUpload.single('cover'), (req, res) => {
  const { roomId } = req.body;
  if (!roomId) return res.status(400).json({ message: "❌ 缺少房間號 roomId" });
  if (!req.file) return res.status(400).json({ message: "❌ 未收到封面檔案" });

  const coverPath = `/uploads/preview/${roomId}/${req.file.filename}`;
  db.query(
    "UPDATE streams SET cover=? WHERE room_id=?",
    [coverPath, roomId],
    err => {
      if (err) {
        console.error("❌ MySQL 錯誤：", err);
        return res.status(500).json({ message: "資料庫更新失敗" });
      }
  // cover uploaded
      
      // 通知所有客戶端更新封面
      io.emit("cover-updated", { roomId, coverPath });
      
      res.json({ message: "封面上傳成功", cover: coverPath });
    }
  );
});

// 心跳包：維持直播狀態
app.post('/api/heartbeat', (req, res) => {
  const { roomId } = req.body;
  if (!roomId) return res.status(400).json({ message: "缺少房間號" });

  db.query(
    "UPDATE streams SET last_active=NOW(), status=TRUE WHERE room_id=?",
    [roomId],
    err => {
      if (err) {
        console.error("❌ 心跳更新失敗：", err);
        return res.status(500).json({ ok: false });
      }
      res.json({ ok: true });
    }
  );
});

// 結束直播
app.post('/api/end-stream', (req, res) => {
  const { roomId } = req.body;
  if (!roomId) return res.status(400).json({ message: "缺少房間號" });

  db.query(
    "UPDATE streams SET status=FALSE, last_active=NOW() WHERE room_id=?",
    [roomId],
    err => {
      if (err) {
        console.error("❌ 結束直播失敗：", err);
        return res.status(500).json({ message: "更新失敗" });
      }
      // 刪除該房間的 preview 檔案資料夾（若存在）
      const previewDir = path.join(__dirname, 'uploads', 'preview', String(roomId));
      fs.rm(previewDir, { recursive: true, force: true }, rmErr => {
        if (rmErr) {
          // don't block main flow; log warning
          console.warn(`could not remove preview dir ${previewDir}:`, rmErr);
        }

        // 通知前端該房間的封面已清除 / 直播已結束，讓 index.html 可以立即更新列表
        try {
          io.emit('cover-updated', { roomId, coverPath: null });
        } catch (emitErr) {
          console.warn('⚠️ 發送 cover-updated 事件失敗:', emitErr);
        }

        // 最後回應 API 請求
        res.json({ message: "直播已結束" });
      });
    }
  );
});

// 自動檢查超過 60 秒未心跳 → 下架（放寬容忍度，避免網路抖動導致誤下架）
setInterval(() => {
  db.query(
    "UPDATE streams SET status=FALSE WHERE status=TRUE AND TIMESTAMPDIFF(SECOND,last_active,NOW())>60",
    err => {
      if (err) console.error("❌ 檢查直播狀態失敗", err);
    }
  );
}, 15000);

// 熱門直播列表（只顯示在線）
app.get("/api/streams", (req, res) => {
  db.query(
    "SELECT s.room_id, s.title, s.cover, s.description, u.username FROM streams s JOIN users u ON s.user_id=u.id WHERE s.status=TRUE ORDER BY s.created_at DESC",
    (err, results) => {
      if (err) throw err;
      res.json(results);
    }
  );
});

// 直播資訊（viewer / broadcaster 使用）
app.get("/api/stream-info", (req, res) => {
  const { room } = req.query;
  db.query(
    "SELECT s.title, s.description, s.hashtags, s.cover, u.username FROM streams s JOIN users u ON s.user_id=u.id WHERE s.room_id=?",
    [room],
    (err, results) => {
      if (err) throw err;
      if (results.length === 0) return res.status(404).json({ message: "找不到直播間" });
      res.json(results[0]);
    }
  );
});

// broadcaster 權限驗證
app.get("/api/verify-broadcaster", (req, res) => {
  const { room } = req.query;
  if (!req.session.user) return res.status(401).json({ valid: false, reason: "未登入" });

  db.query("SELECT user_id FROM streams WHERE room_id=?", [room], (err, results) => {
    if (err) throw err;
    if (results.length === 0) return res.status(404).json({ valid: false, reason: "房間不存在" });
    if (results[0].user_id !== req.session.user.id) {
      return res.status(403).json({ valid: false, reason: "非房主" });
    }
    res.json({ valid: true });
  });
});

// viewer.html 映射
app.get("/viewer.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "viewer.html"));
});

// --------------------- Socket.io：WebRTC + Chat ---------------------
// make these maps global so all sockets share room counts and reaction stats
const roomViewers = new Map();  // tracks viewer counts per room
// per-room reaction registry: Map<roomId, Map<socketId, emojiType>>
const roomReactions = new Map();
// per-room PK vote tally: Map<combinedRoomId, Map<ownerId, count>>
const roomPkVotes = new Map();
// track which sockets are broadcasters in a room (roomId -> Set<socketId>)
const roomBroadcasters = new Map();
// track which socket is the broadcaster (owner) for a given roomId
const roomOwners = new Map(); // roomId -> socketId
// whether a room accepts PK invites
const roomPkEnabled = new Map(); // roomId -> boolean

io.on("connection", socket => {
  // socket connected
  console.log('[server] socket connected', socket.id);

  // WebRTC 事件：房間隔離版本
  socket.on("broadcaster", (roomId) => {
    if (!roomId) return;
    console.log('[server] broadcaster announces in room', roomId, socket.id);
    // 在房間內廣播 broadcaster 事件
    socket.to(roomId).emit("broadcaster", { roomId, broadcasterId: socket.id });

    // Fallback: treat this announce as an owner registration if none exists yet
    if (!roomOwners.has(roomId)) {
      roomOwners.set(roomId, socket.id);
      roomPkEnabled.set(roomId, true);
      if (!roomBroadcasters.has(roomId)) roomBroadcasters.set(roomId, new Set());
      roomBroadcasters.get(roomId).add(socket.id);
      console.log('[server] broadcaster announce auto-registered owner for room', roomId, 'socket', socket.id, 'owners size', roomOwners.size);
    }
  });
  
  // broadcaster declares itself as owner of a room
  socket.on('broadcaster-join', roomId => {
    try {
      if (roomId) {
        // Extract user info from session if available
        const userInfo = {
          socketId: socket.id,
          userId: (socket.handshake.session && socket.handshake.session.user && socket.handshake.session.user.id) || null,
          username: (socket.handshake.session && socket.handshake.session.user && socket.handshake.session.user.username) || '未知使用者'
        };
        socketToUser.set(socket.id, userInfo);
        
        roomOwners.set(roomId, socket.id);
        roomPkEnabled.set(roomId, true); // default allow PK
        socket.join(roomId);
        // register in roomBroadcasters
        if (!roomBroadcasters.has(roomId)) roomBroadcasters.set(roomId, new Set());
        roomBroadcasters.get(roomId).add(socket.id);
        console.log('[server] broadcaster joined room', roomId, socket.id, 'user:', userInfo.username, 'owners size', roomOwners.size);
      }
    } catch (e) {}
  });
  
  socket.on('pk-toggle', ({ roomId, enabled }) => {
    if (!roomId) return;
    roomPkEnabled.set(roomId, !!enabled);
  });
  
  // viewer-ready: 觀眾加入房間並準備接收串流
  socket.on('viewer-ready', ({ roomId, viewerId }) => {
    if (!roomId) return;
    // 通知房間內的 broadcaster 有新觀眾準備好了
    socket.to(roomId).emit('viewer-ready', { viewerId });
  });
  
  socket.on("watcher", () => {
    console.log('[server] watcher (legacy)', socket.id);
    socket.broadcast.emit("watcher", socket.id);
  });
  
  // WebRTC signaling: 點對點傳送（不限制成一個寶間，因為已經由 id 指定對象）
  socket.on("offer", (id, message) => socket.to(id).emit("offer", socket.id, message));
  socket.on("answer", (id, message) => socket.to(id).emit("answer", socket.id, message));
  socket.on("candidate", (id, message) => socket.to(id).emit("candidate", socket.id, message));
  socket.on("disconnect", () => socket.broadcast.emit("bye", socket.id));

  // 房間人數追蹤 (maps are global)

  function updateViewerCount(roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    const count = room ? room.size : 0;
    roomViewers.set(roomId, count);
    io.to(roomId).emit("viewer-count", count);
  }

  // Chatroom：加入房間
  socket.on("join-room", roomId => {
    socket.join(roomId);
    io.to(roomId).emit("system-message", "有個人加入直播，你好！");
    updateViewerCount(roomId);
    
    // If this is a PK combined room, send broadcaster info to the joining socket
    if (roomBroadcasters.has(roomId)) {
      const broadcasterIds = Array.from(roomBroadcasters.get(roomId));
      const broadcasterInfos = broadcasterIds.map(bid => {
        const info = socketToUser.get(bid) || { socketId: bid, userId: null, username: '未知使用者' };
        return { socketId: bid, ...info };
      });
      socket.emit('broadcaster-info', { roomId, broadcasters: broadcasterInfos });
      console.log('[server] Sent broadcaster info to viewer in room', roomId, ':', broadcasterInfos.map(b => b.username));
    }
    
    // ensure reaction map exists for this room
    if (!roomReactions.has(roomId)) roomReactions.set(roomId, new Map());
    // send current reaction stats to the joining client
    const map = roomReactions.get(roomId) || new Map();
    const counts = {};
    for (const t of map.values()) counts[t] = (counts[t] || 0) + 1;
    let topType = null, topCount = 0;
    for (const [k, v] of Object.entries(counts)) {
      if (v > topCount) { topType = k; topCount = v; }
    }
    io.to(roomId).emit('reaction-stats', { topType, topCount, counts });
  });

  // Chatroom：廣播訊息（server 端轉發給同房間的所有 client）
  socket.on('chat-message', data => {
    // data expected: { roomId, user, text, avatar }
    console.log('[server] chat-message received', data && data.roomId, socket.id);
    if (!data || !data.roomId) return;
    // forward userId if present so clients can deterministically color users
    io.to(data.roomId).emit('chat-message', {
      roomId: data.roomId,
      user: data.user,
      userId: data.userId || null,
      text: data.text,
      avatar: data.avatar,
      isHost: data.isHost ? true : false,
      sender: socket.id // attach sender socket id for fallback coloring
    });
  });

  // 系統訊息：由 server 轉發給指定房間的 clients
  socket.on('system-message', ({ roomId, text }) => {
    if (!roomId || !text) return;
    io.to(roomId).emit('system-message', text);
  });

  // Reaction events from viewers (e.g., heart, laugh, cry, like)
  socket.on('reaction', data => {
    // data: { roomId, type }
    console.log('[server] reaction received', socket.id, data);
    if (!data || !data.roomId || !data.type) {
      console.warn('[server] reaction: invalid payload', data);
      return;
    }
    // Forward raw event to room for visual effects (broadcaster/viewers)
    io.to(data.roomId).emit('reaction', { type: data.type, from: socket.id });

    // Register unique reaction per socket per room (count each viewer once)
    if (!roomReactions.has(data.roomId)) roomReactions.set(data.roomId, new Map());
    const map = roomReactions.get(data.roomId);
    // if this socket hasn't reacted yet, record and emit updated stats
    if (!map.has(socket.id)) {
      map.set(socket.id, data.type);
      // compute counts
      const counts = {};
      for (const t of map.values()) counts[t] = (counts[t] || 0) + 1;
      let topType = null, topCount = 0;
      for (const [k, v] of Object.entries(counts)) {
        if (v > topCount) { topType = k; topCount = v; }
      }
      io.to(data.roomId).emit('reaction-stats', { topType, topCount, counts });
      console.log('[server] reaction stats updated for room', data.roomId, topType, topCount);
    } else {
      // already counted this socket for this room; ignore for stats
      console.log('[server] reaction ignored for stats (already counted):', socket.id);
    }
    // optional: also emit as UDP packet for external consumers
    if (udpClient && UDP_HOST && UDP_PORT) {
      try {
        const payload = JSON.stringify({ roomId: data.roomId, type: data.type, from: socket.id, ts: Date.now() });
        udpClient.send(Buffer.from(payload), UDP_PORT, UDP_HOST, err => {
          if (err) console.warn('UDP send error for reaction:', err);
        });
      } catch (e) {
        console.warn('UDP emit failed:', e);
      }
    }
  });

  // Allow changing previously selected reaction (reselect): updates stats
  // data: { roomId, type }
  socket.on('reaction-change', data => {
    try {
      if (!data || !data.roomId || !data.type) return;
      // ensure map exists
      if (!roomReactions.has(data.roomId)) roomReactions.set(data.roomId, new Map());
      const map = roomReactions.get(data.roomId);
      // update this socket's recorded reaction to new type
      map.set(socket.id, data.type);
      // recompute counts and emit
      const counts = {};
      for (const t of map.values()) counts[t] = (counts[t] || 0) + 1;
      let topType = null, topCount = 0;
      for (const [k, v] of Object.entries(counts)) { if (v > topCount) { topType = k; topCount = v; } }
      io.to(data.roomId).emit('reaction-stats', { topType, topCount, counts });
      // also broadcast a visual-only reaction event so clients can animate the change
      io.to(data.roomId).emit('reaction', { type: data.type, from: socket.id, changed: true });
    } catch (e) {
      console.warn('reaction-change failed', e);
    }
  });

  // PK-specific emoji stream (separate from normal reactions)
  socket.on('pk-emoji', data => {
    if (!data || !data.roomId || !data.type) return;
    try {
      io.to(data.roomId).emit('pk-emoji', { type: data.type, from: socket.id });
    } catch (e) {
      console.warn('pk-emoji emit failed', e);
    }
  });

  // Debug: check whether a target room has an owner registered
  socket.on('pk-check-target', ({ targetRoom }) => {
    try {
      const owner = targetRoom ? roomOwners.get(targetRoom) || null : null;
      const pkEnabled = targetRoom ? roomPkEnabled.get(targetRoom) : undefined;
      console.log('[pk] check-target', targetRoom, 'owner', owner, 'pkEnabled', pkEnabled, 'owners size', roomOwners.size);
      socket.emit('pk-check-target', { targetRoom, owner, pkEnabled });
    } catch (e) {
      console.warn('pk-check-target failed', e);
    }
  });

  // PK: send an invite from one broadcaster room to another
  socket.on('pk-request', ({ fromRoom, targetRoom }) => {
    if (!fromRoom || !targetRoom) return;
    console.log('[pk] request from', fromRoom, 'to', targetRoom, 'socket', socket.id);
    let targetSocket = roomOwners.get(targetRoom) || null;
    if (!targetSocket && roomBroadcasters.has(targetRoom)) {
      // fallback: any broadcaster socket in that room
      const set = roomBroadcasters.get(targetRoom);
      targetSocket = set && set.size ? Array.from(set)[0] : null;
      console.warn('[pk] owner missing; fallback to broadcaster set for', targetRoom, '=>', targetSocket);
    }
    if (!targetSocket) {
      // last resort: any socket in the room (could be broadcaster if map not populated yet)
      const setAny = io.sockets.adapter.rooms.get(targetRoom) || new Set();
      targetSocket = Array.from(setAny).find(id => id !== socket.id) || null;
      console.warn('[pk] owner/broadcaster missing; fallback to any socket in room', targetRoom, '=>', targetSocket);
    }
    if (!targetSocket) {
      console.warn('[pk] target not found for', targetRoom, 'owners size', roomOwners.size, 'broadcasters size', roomBroadcasters.has(targetRoom) ? roomBroadcasters.get(targetRoom).size : 0);
      socket.emit('pk-error', { reason: 'target-not-found' });
      return;
    }
    // check if target accepts PK
    if (roomPkEnabled.has(targetRoom) && roomPkEnabled.get(targetRoom) === false) {
      console.warn('[pk] target disabled PK', targetRoom);
      socket.emit('pk-error', { reason: 'target-disabled' });
      return;
    }
    // forward invite to target broadcaster
    console.log('[pk] forwarding invite to socket', targetSocket);
    io.to(targetSocket).emit('pk-invite', { fromRoom, fromSocket: socket.id });
  });
  // response to pk invite: { fromRoom, targetRoom, accept }
  socket.on('pk-response', ({ fromRoom, targetRoom, accept }) => {
    try {
      console.log('[pk] response', accept ? 'accept' : 'reject', 'from', targetRoom, 'to', fromRoom);
      const fromOwner = roomOwners.get(fromRoom);
      if (!fromOwner) return;
      // notify the requester of accept/reject
      io.to(fromOwner).emit('pk-response', { fromRoom, targetRoom, accept, responderSocket: socket.id });
      if (!accept) return;

      // We need broadcaster user_ids to form combined id. Try to query DB for both room owners,
      // fallback to using room ids if user ids not found.
      const handleCombined = (ownerIdA, ownerIdB) => {
        // generate PK room with format: PK_xxxxx (random 5-char code)
        const combined = 'PK_' + generateRoomCode();

        // inform both broadcasters to start PK and include left/right owner mapping (preserve original order as left=fromRoom owner)
        let ownerASocket = roomOwners.get(fromRoom) || null;
        let ownerBSocket = roomOwners.get(targetRoom) || null;
        // fallback to broadcaster set if owner missing
        if (!ownerASocket && roomBroadcasters.has(fromRoom)) {
          const setA = roomBroadcasters.get(fromRoom);
          ownerASocket = setA && setA.size ? Array.from(setA)[0] : null;
          console.warn('[pk] owner socket missing for fromRoom; fallback broadcaster', fromRoom, ownerASocket);
        }
        if (!ownerBSocket && roomBroadcasters.has(targetRoom)) {
          const setB = roomBroadcasters.get(targetRoom);
          ownerBSocket = setB && setB.size ? Array.from(setB)[0] : null;
          console.warn('[pk] owner socket missing for targetRoom; fallback broadcaster', targetRoom, ownerBSocket);
        }
        const leftOwner = ownerIdA || String(fromRoom);
        const rightOwner = ownerIdB || String(targetRoom);
        let emittedStart = false;
        if (ownerASocket) { io.to(ownerASocket).emit('pk-start', { combinedRoom: combined, leftOwner: leftOwner, rightOwner: rightOwner }); emittedStart = true; }
        if (ownerBSocket) { io.to(ownerBSocket).emit('pk-start', { combinedRoom: combined, leftOwner: leftOwner, rightOwner: rightOwner }); emittedStart = true; }
        // fallback: emit to rooms if owner sockets missing
        if (!emittedStart) {
          console.warn('[pk] pk-start fallback broadcast to rooms', fromRoom, targetRoom);
          io.to(fromRoom).emit('pk-start', { combinedRoom: combined, leftOwner: leftOwner, rightOwner: rightOwner });
          io.to(targetRoom).emit('pk-start', { combinedRoom: combined, leftOwner: leftOwner, rightOwner: rightOwner });
        }
        console.log('[pk] pk-start emitted', { combined, ownerASocket, ownerBSocket, leftOwner, rightOwner });

        // notify viewers in both rooms to redirect to pk viewer page and include owner mapping
        try {
          io.to(fromRoom).emit('pk-merged', { combinedRoom: combined, leftOwner: leftOwner, rightOwner: rightOwner });
          const setA = io.sockets.adapter.rooms.get(fromRoom) || new Set();
          for (const sid of setA) io.to(sid).emit('pk-merged', { combinedRoom: combined, leftOwner: leftOwner, rightOwner: rightOwner });
        } catch (e) { console.warn('emit pk-merged to fromRoom failed', e); }
        try {
          io.to(targetRoom).emit('pk-merged', { combinedRoom: combined, leftOwner: leftOwner, rightOwner: rightOwner });
          const setB = io.sockets.adapter.rooms.get(targetRoom) || new Set();
          for (const sid of setB) io.to(sid).emit('pk-merged', { combinedRoom: combined, leftOwner: leftOwner, rightOwner: rightOwner });
        } catch (e) { console.warn('emit pk-merged to targetRoom failed', e); }
        console.log('[server] pk-merged emitted for', fromRoom, targetRoom, '->', combined);

        // merge reaction maps
        const newMap = new Map();
        if (roomReactions.has(fromRoom)) for (const [k,v] of roomReactions.get(fromRoom).entries()) newMap.set(k,v);
        if (roomReactions.has(targetRoom)) for (const [k,v] of roomReactions.get(targetRoom).entries()) newMap.set(k,v);
        if (newMap.size > 0) roomReactions.set(combined, newMap);

        // init pk vote counts for combined room using owner ids as keys
        const votes = new Map();
        votes.set(String(leftOwner), 0);
        votes.set(String(rightOwner), 0);
        roomPkVotes.set(combined, votes);
        try {
          const initialCounts = {};
          initialCounts[String(leftOwner)] = 0;
          initialCounts[String(rightOwner)] = 0;
          io.to(combined).emit('pk-votes-updated', { counts: initialCounts, total: 0 });
        } catch (e) {
          console.warn('pk: failed to emit initial vote snapshot', e);
        }

        // try to insert a combined stream row BEFORE marking old ones as ended
        // (so we can still query user_id from original streams if needed)
        const insertCombined = (ownerId) => {
          console.log('pk: insertCombined called with ownerId:', ownerId, 'combined room:', combined);
          if (!ownerId) {
            console.warn('❌ pk: no valid user_id found for combined stream; skipping DB insert (index will not show combined room)');
            try { io.emit('cover-updated', { roomId: combined, coverPath: null }); } catch (e) { console.warn('emit cover-updated failed', e); }
            return;
          }
          
          // Query usernames for both owners to create a friendly title
          console.log('pk: querying usernames for', leftOwner, rightOwner);
          db.query("SELECT username FROM users WHERE id IN (?,?)", [leftOwner, rightOwner], (errUsers, userRows) => {
            let title = 'PK直播對決';
            if (!errUsers && userRows && userRows.length >= 2) {
              const name1 = userRows[0].username;
              const name2 = userRows[1].username;
              title = `🔥 PK對決：${name1} vs ${name2}`;
              console.log('pk: found both usernames:', name1, 'vs', name2);
            } else if (!errUsers && userRows && userRows.length === 1) {
              title = `🔥 PK對決：${userRows[0].username} vs 神秘主播`;
              console.log('pk: found one username:', userRows[0].username);
            } else {
              console.warn('pk: failed to query usernames:', errUsers || 'no rows found');
            }
            
            db.query(
              "INSERT INTO streams (user_id, room_id, title, description, hashtags, status, last_active) VALUES (?,?,?,?,?,TRUE,NOW())",
              [ownerId, combined, title, 'PK直播對決', '#PK'],
              (err3) => {
                if (err3) {
                  console.error('❌ pk: failed to insert combined stream row:', err3.message || err3);
                  console.error('pk: insert params:', { ownerId, combined, title });
                } else {
                  console.log('✅ pk: inserted combined stream', combined, 'owner', ownerId, 'title', title);
                }
                try { io.emit('cover-updated', { roomId: combined, coverPath: null }); } catch (e) { console.warn('emit cover-updated failed', e); }
                
                // AFTER successful insert, mark original streams as ended
                db.query("UPDATE streams SET status=FALSE, last_active=NOW() WHERE room_id IN (?,?)", [fromRoom, targetRoom], (err4) => {
                  if (err4) console.warn('pk: failed to mark old streams ended', err4);
                  else console.log('pk: marked original streams as ended', fromRoom, targetRoom);
                });
              }
            );
          });
        };

        // prefer leftOwner for DB insert, fallback to rightOwner
        insertCombined(leftOwner || rightOwner);

        // clear old owners & broadcaster sets
        roomOwners.delete(fromRoom);
        roomOwners.delete(targetRoom);
        roomBroadcasters.delete(fromRoom);
        roomBroadcasters.delete(targetRoom);
        roomPkEnabled.set(combined, false);
      };

      // query DB for owner user_ids for both rooms (while they're still status=TRUE), then handle combined
      db.query("SELECT user_id FROM streams WHERE room_id=? AND status=TRUE LIMIT 1", [fromRoom], (err, rows) => {
        if (err) {
          console.warn('pk: failed to query fromRoom owner', err);
          // fallback: try without status filter (in case already marked false)
          db.query("SELECT user_id FROM streams WHERE room_id=? ORDER BY created_at DESC LIMIT 1", [fromRoom], (err1b, rows1b) => {
            const ownerA = (rows1b && rows1b[0]) ? rows1b[0].user_id : null;
            db.query("SELECT user_id FROM streams WHERE room_id=? AND status=TRUE LIMIT 1", [targetRoom], (err2, rows2) => {
              if (err2) {
                db.query("SELECT user_id FROM streams WHERE room_id=? ORDER BY created_at DESC LIMIT 1", [targetRoom], (err2b, rows2b) => {
                  const ownerB = (rows2b && rows2b[0]) ? rows2b[0].user_id : null;
                  handleCombined(ownerA, ownerB);
                });
              } else {
                const ownerB = (rows2 && rows2[0]) ? rows2[0].user_id : null;
                handleCombined(ownerA, ownerB);
              }
            });
          });
          return;
        }
        const ownerA = (rows && rows[0]) ? rows[0].user_id : null;
        db.query("SELECT user_id FROM streams WHERE room_id=? AND status=TRUE LIMIT 1", [targetRoom], (err2, rows2) => {
          if (err2) {
            console.warn('pk: failed to query targetRoom owner', err2);
            // fallback without status filter
            db.query("SELECT user_id FROM streams WHERE room_id=? ORDER BY created_at DESC LIMIT 1", [targetRoom], (err2b, rows2b) => {
              const ownerB = (rows2b && rows2b[0]) ? rows2b[0].user_id : null;
              handleCombined(ownerA, ownerB);
            });
            return;
          }
          const ownerB = (rows2 && rows2[0]) ? rows2[0].user_id : null;
          handleCombined(ownerA, ownerB);
        });
      });
      console.log('[pk] pk-response accepted, querying owners', { fromRoom, targetRoom });

    } catch (e) {
      console.warn('pk-response handling failed', e);
    }
  });

  // PK direct signaling routing between two broadcasters (peer-to-peer by socket id)
  socket.on('pk-offer', ({ to, offer }) => { if (to) io.to(to).emit('pk-offer', { from: socket.id, offer }); });
  socket.on('pk-answer', ({ to, answer }) => { if (to) io.to(to).emit('pk-answer', { from: socket.id, answer }); });
  socket.on('pk-candidate', ({ to, candidate }) => { if (to) io.to(to).emit('pk-candidate', { from: socket.id, candidate }); });

  // PK voting from viewers: { roomId, ownerId }
  socket.on('pk-vote', ({ roomId, ownerId }) => {
    try {
      if (!roomId || !ownerId) return;
      if (!roomPkVotes.has(roomId)) roomPkVotes.set(roomId, new Map());
      const m = roomPkVotes.get(roomId);
      const key = String(ownerId);
      m.set(key, (m.get(key) || 0) + 1);
      // broadcast updated counts to the combined room
      const counts = {};
      let total = 0;
      for (const [k, v] of m.entries()) { counts[k] = v; total += v; }
      io.to(roomId).emit('pk-votes-updated', { counts, total });
    } catch (e) {
      console.warn('pk-vote handling failed', e);
    }
  });

  // return list of partner socket ids in a given room (excluding requester)
  socket.on('pk-get-partners', (room) => {
    try {
      // prefer returning broadcaster sockets in the room so pk handshake targets broadcasters only
      let partnerIds = [];
      if (roomBroadcasters.has(room)) {
        partnerIds = Array.from(roomBroadcasters.get(room)).filter(sid => sid !== socket.id);
      }
      // fallback to any sockets in room if no broadcaster set yet
      if ((!partnerIds || partnerIds.length === 0)) {
        const set = io.sockets.adapter.rooms.get(room) || new Set();
        partnerIds = Array.from(set).filter(sid => sid !== socket.id);
      }
      // Include user info for each partner
      const partners = partnerIds.map(sid => {
        const userInfo = socketToUser.get(sid) || { socketId: sid, userId: null, username: '未知使用者' };
        return { socketId: sid, ...userInfo };
      });
      console.log('[pk] pk-get-partners', room, 'req', socket.id, 'partners', partners.map(p=>p.socketId));
      socket.emit('pk-partners', { room, partners });
    } catch (e) {
      socket.emit('pk-partners', { room, partners: [] });
    }
  });


  // Chatroom：離開訊息
  socket.on("disconnecting", () => {
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        io.to(room).emit("system-message", "一位觀眾離開直播");
        // 等待下一個 tick 再更新人數，確保用戶已經完全離開
        process.nextTick(() => updateViewerCount(room));
        // also remove from reaction registry if present and update stats
        try {
          if (roomReactions.has(room)) {
            const map = roomReactions.get(room);
            if (map && map.delete(socket.id)) {
              // recompute and emit stats
              const counts = {};
              for (const t of map.values()) counts[t] = (counts[t] || 0) + 1;
              let topType = null, topCount = 0;
              for (const [k, v] of Object.entries(counts)) {
                if (v > topCount) { topType = k; topCount = v; }
              }
              io.to(room).emit('reaction-stats', { topType, topCount, counts });
            }
          }
          // remove from broadcaster registry if present
          try {
            if (roomBroadcasters.has(room)) {
              const s = roomBroadcasters.get(room);
              if (s && s.delete && s.delete(socket.id)) {
                // left broadcaster set; if empty, remove the set
                if (s.size === 0) roomBroadcasters.delete(room);
              }
            }
          } catch (e) {}
        } catch (e) {
          console.warn('failed to update reaction stats on disconnect:', e);
        }
      }
    }
  });
});

// --------------------- 啟動伺服器 ---------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
http.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
