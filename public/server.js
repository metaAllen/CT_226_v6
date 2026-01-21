const fs = require('fs');
const https = require('https');
const http = require('http');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const mysql = require('mysql2/promise');
const Redis = require('ioredis');
const multer = require('multer');
require('dotenv').config();
const strava = require('strava-v3');
const webpush = require('web-push');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

strava.config({
  client_id: '168269',
  client_secret: '0aa416ff5e5cd0b95c6361562be252f501d37b3c'
});

// 調試環境變數
console.log('Environment variables:');
console.log('DB_HOST:', process.env.DB_HOST);
console.log('DB_PORT:', process.env.DB_PORT);
console.log('DB_USER:', process.env.DB_USER);
console.log('DB_NAME:', process.env.DB_NAME);
console.log('PORT:', process.env.PORT);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
const port = process.env.PORT || 3000;

// asyncHandler: 包裝 async 路由，捕捉異常
function asyncHandler(fn) {
  return function(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(err => {
      console.error('API Error:', req.method, req.url, err.stack || err);
      res.status(500).json({ error: 'Internal Server Error', detail: err.message });
    });
  };
}

// 配置 multer 用於文件上傳
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, 'public', 'uploads', 'avatars');
        // 確保上傳目錄存在
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        console.log('上傳目錄:', uploadDir);
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // 使用用戶ID和時間戳生成唯一檔名
        const userId = req.userId || `user_${Date.now()}`;
        const timestamp = Date.now();
        const ext = path.extname(file.originalname);
        cb(null, `${userId}_${timestamp}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 限制5MB
    },
    fileFilter: function (req, file, cb) {
        // 只允許圖片格式
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('只允許上傳圖片檔案'));
        }
    }
});

// 建立 mysql2 的 pool
async function getPool() {
    try {
        const pool = mysql.createPool({
            host: process.env.DB_HOST || 'localhost',
            port: process.env.DB_PORT || 3306,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 50,
        });
        // 測試連線
        const connection = await pool.getConnection();
        console.log('Test connection successful');
        connection.release();
        return pool;
    } catch (error) {
        console.error('Error in getPool:', error);
        throw error;
    }
}

// 初始化資料庫連線池
let pool;
(async () => {
    try {
        pool = await getPool();
        console.log('Successfully connected to MySQL (Docker)');
        
        // 初始化資料庫表格
        await initDatabase();
    } catch (err) {
        console.error('Failed to connect to Google Cloud SQL:', err.stack || err);
        process.exit(1);
    }
})();

// 初始化資料庫表格
async function initDatabase() {
    try {
        // 不要再 drop table
        // await pool.query('DROP TABLE IF EXISTS sync_logs');
        // await pool.query('DROP TABLE IF EXISTS user_data');
        // await pool.query('DROP TABLE IF EXISTS users');

        // 使用者資料表
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                user_id VARCHAR(255) PRIMARY KEY,
                username VARCHAR(255) UNIQUE,
                email VARCHAR(255) UNIQUE,
                name VARCHAR(255),
                password VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 好友關係表
        await pool.query(`
            CREATE TABLE IF NOT EXISTS friends (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(255),
                friend_id VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(user_id),
                FOREIGN KEY (friend_id) REFERENCES users(user_id),
                UNIQUE KEY unique_friendship (user_id, friend_id)
            )
        `);

        // 其他表也用 IF NOT EXISTS
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_data (
                user_id VARCHAR(255) PRIMARY KEY,
                data JSON,
                last_modified TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(user_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS sync_logs (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(255),
                action VARCHAR(50),
                data_type VARCHAR(50),
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(user_id)
            )
        `);

        // --- 聊天紀錄資料表設計 ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chat_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(64) NOT NULL,
                type VARCHAR(8) NOT NULL, -- 'user' or 'bot'
                content TEXT NOT NULL,
                timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user_id (user_id)
            )
        `);

        console.log('Database tables initialized successfully');
    } catch (err) {
        console.error('Database initialization error:', err);
        throw err;
    }
}

// 確保上傳目錄存在
const uploadDir = path.join(__dirname, 'public', 'uploads', 'avatars');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log('創建上傳目錄:', uploadDir);
}

// 靜態文件服務已移到所有 API 路由之後

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'your_refresh_jwt_secret';
const isProduction = process.env.NODE_ENV === 'production';

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(function (cookie) {
    const parts = cookie.split('=');
    const key = parts.shift()?.trim();
    if (!key) return;
    const value = decodeURIComponent(parts.join('='));
    list[key] = value;
  });
  return list;
}

function setRefreshTokenCookie(res, refreshToken) {
  // 不依賴 cookie-parser，直接用 res.cookie
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: isProduction, // 在生產環境使用 HTTPS 才設置 secure
    sameSite: 'Lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天
    path: '/api'
  });
}

function generateAccessToken(userId) {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '24h' });
}

function generateRefreshToken(userId) {
  return jwt.sign({ id: userId, type: 'refresh' }, REFRESH_TOKEN_SECRET, { expiresIn: '30d' });
}

// JWT 驗證中間件（帶 refresh token 自動續期）
const authenticateToken = (req, res, next) => {
    const bearer = req.headers.authorization;
    const token = bearer?.startsWith('Bearer ') ? bearer.split(' ')[1] : undefined;
    console.log('JWT 驗證 - Authorization header:', bearer ? '存在' : '不存在');
    console.log('JWT 驗證 - Token:', token ? `${token.substring(0, 20)}...` : '不存在');

    const tryVerifyAccess = () => {
        if (!token) return false;
        try {
            const { id } = jwt.verify(token, JWT_SECRET);
            req.userId = id;
            console.log('JWT 驗證成功 - userId:', id);
            return true;
        } catch (e) {
            console.warn('存取 token 驗證失敗，嘗試使用 refresh token：', e.message || e.toString());
            return false;
        }
    };

    if (tryVerifyAccess()) return next();

    // 嘗試使用 refresh token 自動續期
    const cookies = parseCookies(req.headers.cookie || '');
    const refreshToken = cookies['refresh_token'];
    if (!refreshToken) {
        return res.status(401).json({ error: '缺少 token' });
    }
    try {
        const { id, type } = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
        if (type !== 'refresh') throw new Error('Invalid refresh token type');

        // 使用 refresh token 簽發新 access token（並輪替 refresh token）
        const newAccessToken = generateAccessToken(id);
        const newRefreshToken = generateRefreshToken(id);
        setRefreshTokenCookie(res, newRefreshToken);

        // 可選：把新 access token 放在回應標頭，方便前端更新
        res.setHeader('x-new-access-token', newAccessToken);

        req.userId = id;
        console.log('使用 refresh token 自動續期成功 - userId:', id);
        // 將新的 token 附加到 req 以供下游使用（可選）
        req.newAccessToken = newAccessToken;
        return next();
    } catch (e) {
        console.error('Refresh token 驗證失敗:', e);
        return res.status(401).json({ error: 'token 無效' });
    }
};

// Redis 連線設定 (帶錯誤處理)
let redis;
try {
    redis = new Redis({
        host: 'localhost',
        port: 6379,
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3,
        lazyConnect: true
    });
    
    redis.on('error', (err) => {
        console.warn('Redis 連線錯誤:', err.message);
    });
    
    redis.on('connect', () => {
        console.log('Redis 連線成功');
    });
    
} catch (err) {
    console.warn('Redis 初始化失敗:', err.message);
    // 建立一個模擬的 Redis 物件，避免程式崩潰
    redis = {
        get: async () => null,
        set: async () => true,
        del: async () => true
    };
}

// ===== Strava OAuth2 認證流程 =====
const STRAVA_CLIENT_ID = '168269';
const STRAVA_CLIENT_SECRET = '0aa416ff5e5cd0b95c6361562be252f501d37b3c';
// 自動偵測 domain 或預設為公開網址
const DEFAULT_STRAVA_REDIRECT_URI = 'https://ironshrimp.duckdns.org/api/strava/callback';
const STRAVA_REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || DEFAULT_STRAVA_REDIRECT_URI;
console.log('Strava OAuth redirect_uri:', STRAVA_REDIRECT_URI);

// 產生 Strava 授權網址
app.get('/api/strava/auth', (req, res) => {
    const authorizeUrl = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(STRAVA_REDIRECT_URI)}&approval_prompt=auto&scope=activity:read_all,profile:read_all`;
    res.json({ url: authorizeUrl });
});

// --- Strava OAuth2 callback: 只回傳 access_token，不切換帳號 ---
app.get('/api/strava/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');
    strava.oauth.getToken(code, async function(err, payload) {
        if (err) {
            console.error('Strava token error:', err);
            return res.status(500).send('Strava token exchange failed');
        }
        
        console.log('Strava token payload:', JSON.stringify(payload, null, 2));
        // 取得 token 資訊
        const access_token = payload.access_token || (payload.body && payload.body.access_token);
        const refresh_token = payload.refresh_token || (payload.body && payload.body.refresh_token);
        const expires_at = payload.expires_at || (payload.body && payload.body.expires_at);
        
        console.log('Token info:', {
            access_token: access_token ? 'exists' : 'missing',
            refresh_token: refresh_token ? 'exists' : 'missing',
            expires_at: expires_at
        });
        // 取得 userId（需前端帶 token，這裡假設用戶已登入並帶 JWT）
        let userId = null;
        try {
            const jwtToken = req.cookies?.token || req.headers.authorization?.split(' ')[1];
            if (jwtToken) {
                const { id } = jwt.verify(jwtToken, JWT_SECRET);
                userId = id;
            }
        } catch (e) {}
        if (userId) {
            // 儲存到 user_data
            const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
            let userData = rows.length > 0 ? (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data) : {};
            userData.strava_token = access_token;
            userData.strava_refresh_token = refresh_token;
            userData.strava_expires_at = expires_at;
            await pool.query('UPDATE user_data SET data = ? WHERE user_id = ?', [JSON.stringify(userData), userId]);
        }
        // 跳轉到前端，帶上完整的 token 信息
        const redirectUrl = `/oauth-callback.html?strava_token=${encodeURIComponent(access_token)}&refresh_token=${encodeURIComponent(refresh_token)}&expires_at=${encodeURIComponent(expires_at)}`;
        res.redirect(redirectUrl);
    });
});

// --- 匯入 Strava 活動到目前登入用戶的日曆 ---
app.post('/api/strava/import-activities', authenticateToken, async (req, res) => {
    const { strava_token } = req.body;
    const userId = req.userId;
    if (!strava_token) return res.status(400).json({ error: 'Missing strava_token' });
    try {
        // 取得 Strava 活動
        const activities = await strava.athlete.listActivities({ access_token: strava_token, per_page: 100 });
        // 取得目前用戶的 user_data
        const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
        let userData = rows.length > 0 ? (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data) : {};
        if (!userData.calendarEvents) userData.calendarEvents = {};
        // 將 Strava 活動寫入 calendarEvents
        for (const act of activities) {
            const dateKey = act.start_date_local ? act.start_date_local.split('T')[0] : act.start_date.split('T')[0];
            if (!userData.calendarEvents[dateKey]) userData.calendarEvents[dateKey] = [];
            // 避免重複匯入同一活動（用 id 判斷）
            if (!userData.calendarEvents[dateKey].some(e => e.strava_id === act.id)) {
                userData.calendarEvents[dateKey].push({
                    strava_id: act.id,
                    type: act.type, // Run, Ride, Swim, etc.
                    name: act.name,
                    distance: act.distance / 1000, // 公里
                    moving_time: act.moving_time,
                    elapsed_time: act.elapsed_time,
                    start_time: act.start_date_local,
                    source: 'strava'
                });
            }
        }
        // 更新 user_data
        await pool.query('UPDATE user_data SET data = ? WHERE user_id = ?', [JSON.stringify(userData), userId]);
        res.json({ success: true, imported: activities.length });
    } catch (err) {
        console.error('Strava import activities error:', err);
        res.status(500).json({ error: 'Failed to import Strava activities' });
    }
});

// --- API: 獲取 Strava 活動數據 ---
app.get('/api/strava/activities', authenticateToken, async (req, res) => {
    console.log('Strava activities API 調用 - userId:', req.userId);
    
    // 檢查快取
    const cacheKey = `strava_activities_${req.userId}`;
    try {
        const cached = await redis.get(cacheKey);
        if (cached) {
            console.log('從快取返回 Strava 活動數據');
            return res.json(JSON.parse(cached));
        }
    } catch (cacheErr) {
        console.warn('Redis 快取讀取失敗:', cacheErr.message);
    }
    
    try {
        // 從用戶數據中獲取 Strava token
        const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [req.userId]);
        if (rows.length === 0) {
            console.error('Strava activities error: user not found, userId:', req.userId);
            return res.status(404).json({ error: 'User not found' });
        }
        let userData = rows[0].data;
        try {
            if (typeof userData === 'string') {
                userData = JSON.parse(userData);
            }
        } catch (parseErr) {
            console.error('Strava activities error: user_data JSON 解析失敗', parseErr, userData);
            return res.status(500).json({ error: '用戶資料格式錯誤，請聯絡管理員' });
        }
        let stravaToken = userData.strava_token;
        
        console.log('Strava activities - userData keys:', Object.keys(userData));
        console.log('Strava activities - strava_token exists:', !!stravaToken);
        console.log('Strava activities - strava_refresh_token exists:', !!userData.strava_refresh_token);
        
        // 檢查 token 是否存在
        if (!stravaToken) {
            console.error('Strava activities error: strava_token not found, userId:', req.userId);
            console.log('User data keys:', Object.keys(userData));
            return res.status(401).json({ error: 'Strava token not found，請重新綁定 Strava' });
        }
        // 獲取 Strava 活動數據
        let activities;
        try {
            activities = await strava.athlete.listActivities({ 
                access_token: stravaToken, 
                per_page: 50,
                after: Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000) // 最近30天
            });
        } catch (stravaErr) {
            // 若 access_token 無效，嘗試使用 refresh token 刷新
            if (stravaErr.statusCode === 401 && userData.strava_refresh_token) {
                console.log('Strava token 失效，嘗試使用 refresh token 刷新，userId:', req.userId);
                try {
                    const refreshPayload = await new Promise((resolve, reject) => {
                        strava.oauth.refreshToken(userData.strava_refresh_token, (err, payload) => {
                            if (err) reject(err);
                            else resolve(payload);
                        });
                    });

                    const newAccessToken = refreshPayload.access_token;
                    const newRefreshToken = refreshPayload.refresh_token;
                    const newExpiresAt = refreshPayload.expires_at;

                    // 更新數據庫中的 token 信息
                    userData.strava_token = newAccessToken;
                    userData.strava_refresh_token = newRefreshToken;
                    userData.strava_expires_at = newExpiresAt;
                    await pool.query('UPDATE user_data SET data = ? WHERE user_id = ?', [JSON.stringify(userData), req.userId]);

                    console.log('Token refreshed successfully on server side for user:', req.userId);

                    // 使用新的 token 重試 API 調用
                    activities = await strava.athlete.listActivities({ 
                        access_token: newAccessToken, 
                        per_page: 50,
                        after: Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000)
                    });
                } catch (refreshErr) {
                    console.error('Token refresh failed on server side:', refreshErr);
                    // 刷新失敗，清除 token 信息
                    userData.strava_token = undefined;
                    userData.strava_refresh_token = undefined;
                    userData.strava_expires_at = undefined;
                    await pool.query('UPDATE user_data SET data = ? WHERE user_id = ?', [JSON.stringify(userData), req.userId]);
                    return res.status(401).json({ error: 'Strava token 失效，請重新綁定 Strava' });
                }
            } else {
                // 若 access_token 無效且沒有 refresh token，主動清除 user_data 的 Strava 欄位
                if (stravaErr.statusCode === 401) {
                    userData.strava_token = undefined;
                    userData.strava_refresh_token = undefined;
                    userData.strava_expires_at = undefined;
                    await pool.query('UPDATE user_data SET data = ? WHERE user_id = ?', [JSON.stringify(userData), req.userId]);
                    console.error('Strava token 失效，已自動清除，userId:', req.userId);
                    return res.status(401).json({ error: 'Strava token 失效，請重新綁定 Strava' });
                }
                console.error('Strava API error:', stravaErr);
                return res.status(502).json({ error: 'Strava API 連線失敗', details: stravaErr.message || stravaErr.toString() });
            }
        }
        // 處理活動數據
        const processedActivities = (activities || []).map(activity => ({
            id: activity.id,
            type: activity.type,
            distance: activity.distance / 1000, // 轉換為公里
            moving_time: activity.moving_time,
            start_date: activity.start_date,
            name: activity.name
        }));
        
        const responseData = { activities: processedActivities };
        
        // 儲存到快取 (5分鐘過期)
        try {
            await redis.set(cacheKey, JSON.stringify(responseData), 'EX', 300);
            console.log('Strava 活動數據已快取');
        } catch (cacheErr) {
            console.warn('Redis 快取儲存失敗:', cacheErr.message);
        }
        
        res.json(responseData);
    } catch (err) {
        console.error('Strava activities error (unhandled):', err);
        res.status(500).json({ 
            error: 'Failed to get Strava activities (unhandled)',
            details: err && (err.message || err.toString()),
            stack: err && err.stack
        });
    }
});

// --- API: 保存 Strava token ---
app.post('/api/strava/save-token', authenticateToken, async (req, res) => {
    try {
        const { strava_token, strava_refresh_token, strava_expires_at } = req.body;
        if (!strava_token) {
            return res.status(400).json({ error: 'Missing strava_token' });
        }
        
        // 獲取用戶數據
        const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [req.userId]);
        let userData = {};
        if (rows.length > 0) {
            userData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
        }
        
        // 保存完整的 Strava token 信息
        userData.strava_token = strava_token;
        if (strava_refresh_token) {
            userData.strava_refresh_token = strava_refresh_token;
        }
        if (strava_expires_at) {
            userData.strava_expires_at = strava_expires_at;
        }
        
        // 設置 Strava 同步狀態為啟用
        userData.stravaSyncEnabled = true;
        
        console.log('Saving Strava token for user:', req.userId, {
            has_token: !!strava_token,
            has_refresh_token: !!strava_refresh_token,
            has_expires_at: !!strava_expires_at,
            stravaSyncEnabled: true
        });
        
        // 更新用戶數據
        await pool.query('UPDATE user_data SET data = ? WHERE user_id = ?', [JSON.stringify(userData), req.userId]);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Save Strava token error:', err);
        res.status(500).json({ error: 'Failed to save Strava token' });
    }
});

// --- API: 刷新 Strava token ---
app.post('/api/strava/refresh-token', authenticateToken, async (req, res) => {
    try {
        const { refresh_token } = req.body;
        if (!refresh_token) {
            return res.status(400).json({ error: 'Missing refresh_token' });
        }

        // 使用 Strava API 刷新 token
        const refreshPayload = await new Promise((resolve, reject) => {
            strava.oauth.refreshToken(refresh_token, (err, payload) => {
                if (err) reject(err);
                else resolve(payload);
            });
        });

        const newAccessToken = refreshPayload.access_token;
        const newRefreshToken = refreshPayload.refresh_token;
        const newExpiresAt = refreshPayload.expires_at;

        // 更新用戶數據庫中的 token 信息
        const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [req.userId]);
        let userData = {};
        if (rows.length > 0) {
            userData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
        }

        userData.strava_token = newAccessToken;
        userData.strava_refresh_token = newRefreshToken;
        userData.strava_expires_at = newExpiresAt;

        await pool.query('UPDATE user_data SET data = ? WHERE user_id = ?', [JSON.stringify(userData), req.userId]);

        console.log('Token refreshed successfully for user:', req.userId);

        res.json({
            success: true,
            access_token: newAccessToken,
            refresh_token: newRefreshToken,
            expires_at: newExpiresAt
        });
    } catch (err) {
        console.error('Strava refresh token error:', err);
        res.status(500).json({ 
            error: 'Failed to refresh Strava token',
            details: err.message || err.toString()
        });
    }
});

// --- API: 更新 Strava 同步狀態 ---
app.post('/api/strava/update-sync-status', asyncHandler(async (req, res) => {
  const { stravaSyncEnabled } = req.body;
  // ...原本的狀態儲存邏輯...
  // 假設有 userId
  // ...
  // 狀態變更後推播
  const payload = JSON.stringify({ type: 'stravaSyncStatusChanged' });
  let success = 0;
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      success++;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
      }
    }
  }
  res.json({ ok: true, pushSent: success });
}));

// --- API: 註冊 ---
app.post('/api/register', async (req, res) => {
  const { username, password, name, email } = req.body;
  try {
    const userId = `user_${Date.now()}`;
    // 加密密码
    const hashedPassword = await bcrypt.hash(password, 10);
    // 新增使用者
    await pool.query('INSERT INTO users (user_id, username, email, name, password) VALUES (?, ?, ?, ?, ?)',
      [userId, username, email, name, hashedPassword]);
    // 初始化使用者資料
    const initialData = {
      trainingGoals: [],
      calendarEvents: {},
      schedules: [],
      todaySchedule: "",
      chatHistory: [],
      selectedScheduleType: null,
      selectedScheduleDistance: null,
      selectedScheduleLevel: null,
      events: null,
      profile: {}
    };
    await pool.query('INSERT INTO user_data (user_id, data) VALUES (?, ?)',
      [userId, JSON.stringify(initialData)]);
    // 發放 access/refresh token
    const token = generateAccessToken(userId);
    const refreshToken = generateRefreshToken(userId);
    setRefreshTokenCookie(res, refreshToken);
    res.json({
      success: true,
      user: {
        userId,
        username
      },
      token
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// --- API: 登入 ---
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    // 修改查詢，獲取 username 而不是 name
    const [rows] = await pool.query('SELECT user_id, username, password FROM users WHERE username = ?', [username]);
    if (rows.length === 0) {
      console.error('Login error: User not found for username', username);
      return res.status(401).json({ error: 'User not found' });
    }
    const user = rows[0];
    // 驗證密碼
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      console.error('Login error: Invalid password for username', username);
      return res.status(401).json({ error: 'Invalid password' });
    }
    // 發放 access/refresh token
    const token = generateAccessToken(user.user_id);
    const refreshToken = generateRefreshToken(user.user_id);
    setRefreshTokenCookie(res, refreshToken);
    
    // 記錄返回的數據，用於調試
    console.log('Login success, returning user data:', {
      userId: user.user_id,
      username: user.username
    });

    res.json({ 
      success: true, 
      user: {
        userId: user.user_id,
        username: user.username
      },
      token 
    });
  } catch (err) {
    console.error('Login error (exception):', err);
    res.status(500).json({ error: 'Login failed', details: err.message });
  }
});

// --- API: 登出 ---
app.post('/api/logout', (req, res) => {
  // 清除 refresh token cookie
  res.clearCookie('refresh_token', { path: '/api' });
  res.json({ success: true });
});

// --- API: 使用 refresh token 取得新的 access token ---
app.post('/api/refresh-token', (req, res) => {
  try {
    const cookies = parseCookies(req.headers.cookie || '');
    const refreshToken = cookies['refresh_token'];
    if (!refreshToken) {
      return res.status(401).json({ error: '缺少 refresh token' });
    }
    const { id, type } = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
    if (type !== 'refresh') return res.status(401).json({ error: 'refresh token 無效' });

    const newAccessToken = generateAccessToken(id);
    const newRefreshToken = generateRefreshToken(id);
    setRefreshTokenCookie(res, newRefreshToken);
    return res.json({ success: true, token: newAccessToken });
  } catch (e) {
    console.error('Refresh token endpoint error:', e);
    return res.status(401).json({ error: 'refresh token 驗證失敗' });
  }
});

// --- API: 取得用戶資料 ---
app.get('/api/data', authenticateToken, async (req, res) => {
    const cacheKey = `data_${req.userId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json({ data: JSON.parse(cached) });
    }
    try {
        const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [req.userId]);
        if (rows.length === 0) return res.status(404).json({ error: '找不到用戶' });
        let userData = rows[0].data;
        if (typeof userData === 'string') {
            try { userData = JSON.parse(userData); } catch { userData = {}; }
        }
        await redis.set(cacheKey, JSON.stringify(userData || {}), 'EX', 60);
        res.json({ data: userData || {} });
    } catch (e) {
        console.error('获取用户数据失败:', e);
        res.status(500).json({ error: '获取用户数据失败' });
    }
});

// --- API: 儲存用戶資料 ---
app.post('/api/data', authenticateToken, async (req, res) => {
    try {
        await pool.query('UPDATE user_data SET data = ? WHERE user_id = ?', 
            [JSON.stringify(req.body.data), req.userId]);
        await redis.del(`data_${req.userId}`);
        res.json({ success: true });
    } catch (e) {
        console.error('更新用户数据失败:', e);
        res.status(500).json({ error: '更新用户数据失败' });
    }
});

// --- API: 健康檢查 ---
app.get('/api/health', async (req, res) => {
  try {
    const db = await pool;
    await db.query('SELECT 1');
    res.json({ status: 'ok', db: true });
  } catch (e) {
    console.error('Health check failed:', e);
    res.status(500).json({ status: 'fail', db: false });
  }
});

// --- API: 取得雲端資料 ---
app.get('/api/user-data/:user_id', authenticateToken, async (req, res) => {
    const { user_id } = req.params;
    if (req.userId !== user_id) return res.status(403).json({ error: 'Forbidden' });
    const cacheKey = `userData_${user_id}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));
    }
    try {
        const [rows] = await pool.query('SELECT data, last_modified FROM user_data WHERE user_id = ?', [user_id]);
        if (rows.length === 0) return res.status(404).json({ error: 'User data not found' });
        let userData;
        if (typeof rows[0].data === 'string') {
            userData = JSON.parse(rows[0].data);
        } else {
            userData = rows[0].data;
        }
        const result = {
            data: userData,
            last_modified: rows[0].last_modified
        };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 30);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get user data' });
    }
});

// --- API: 上傳/覆蓋雲端資料 ---
app.post('/api/user-data/:user_id', authenticateToken, async (req, res) => {
    const { user_id } = req.params;
    const { data } = req.body;
    if (req.userId !== user_id) return res.status(403).json({ error: 'Forbidden' });
    try {
        await pool.query(
            'INSERT INTO user_data (user_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?, last_modified = CURRENT_TIMESTAMP',
            [user_id, JSON.stringify(data), JSON.stringify(data)]
        );
        await redis.del(`userData_${user_id}`);
        await redis.del(`data_${user_id}`);
        await redis.del(`schedules_${user_id}`);
        await redis.del(`events_${user_id}`);
        await redis.del(`todaySchedule_${user_id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update user data' });
    }
});

// --- API: 取得今日課表 ---
app.get('/api/today-schedule/:user', async (req, res) => {
    const { user } = req.params;
    const cacheKey = `todaySchedule_${user}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));
    }
    try {
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT data FROM user_data WHERE user_id = ?', [user]);
        conn.release();
        if (rows.length === 0) {
            await redis.set(cacheKey, JSON.stringify(""), 'EX', 30);
            return res.json("");
        }
        let data;
        if (typeof rows[0].data === 'string') {
            data = JSON.parse(rows[0].data);
        } else {
            data = rows[0].data;
        }
        await redis.set(cacheKey, JSON.stringify(data.todaySchedule || ""), 'EX', 30);
        res.json(data.todaySchedule || "");
    } catch (err) {
        console.error('Get today schedule error:', err);
        res.status(500).json({ error: 'Internal server error', details: err.message });
    }
});

// --- API: 取得課表 ---
app.get('/api/schedules/:user', async (req, res) => {
    const { user } = req.params;
    const cacheKey = `schedules_${user}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));
    }
    try {
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT data FROM user_data WHERE user_id = ?', [user]);
        conn.release();
        if (rows.length === 0) {
            const defaultSchedules = [
                {
                    "Monday": "休息日",
                    "Tuesday": "休息日",
                    "Wednesday": "騎25K (或訓練台50分)",
                    "Thursday": "跑6K",
                    "Friday": "游1K",
                    "Saturday": "騎40K (或訓練台80分)",
                    "Sunday": "跑10K"
                }
            ];
            await redis.set(cacheKey, JSON.stringify(defaultSchedules), 'EX', 30);
            return res.json(defaultSchedules);
        }
        let data;
        if (typeof rows[0].data === 'string') {
            data = JSON.parse(rows[0].data);
        } else {
            data = rows[0].data;
        }
        await redis.set(cacheKey, JSON.stringify(data.schedules || []), 'EX', 30);
        res.json(data.schedules || []);
    } catch (err) {
        console.error('Get schedules error:', err);
        res.status(500).json({ error: 'Internal server error', details: err.message });
    }
});

// --- API: 更新今日課表 ---
app.post('/api/today-schedule/:user', async (req, res) => {
    const { user } = req.params;
    const { todaySchedule } = req.body;
    try {
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT data FROM user_data WHERE user_id = ?', [user]);
        let userData;
        if (rows.length === 0) {
            userData = {
                trainingGoals: [],
                calendarEvents: {},
                schedules: [],
                todaySchedule: todaySchedule,
                chatHistory: [],
                selectedScheduleType: null,
                selectedScheduleDistance: null,
                selectedScheduleLevel: null,
                events: null
            };
        } else {
            if (typeof rows[0].data === 'string') {
                userData = JSON.parse(rows[0].data);
            } else {
                userData = rows[0].data;
            }
            userData.todaySchedule = todaySchedule;
        }
        await conn.query('INSERT INTO user_data (user_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?',
            [user, JSON.stringify(userData), JSON.stringify(userData)]);
        conn.release();
        await redis.del(`todaySchedule_${user}`);
        await redis.del(`data_${user}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Update today schedule error:', err);
        res.status(500).json({ error: 'Internal server error', details: err.message });
    }
});

// --- API: 更新課表 ---
app.post('/api/schedules/:user', async (req, res) => {
    const { user } = req.params;
    const { schedules } = req.body;
    try {
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT data FROM user_data WHERE user_id = ?', [user]);
        
        let userData;
        if (rows.length === 0) {
            userData = {
                trainingGoals: [],
                calendarEvents: {},
                schedules: schedules,
                todaySchedule: "",
                chatHistory: [],
                selectedScheduleType: null,
                selectedScheduleDistance: null,
                selectedScheduleLevel: null,
                events: null
            };
        } else {
            if (typeof rows[0].data === 'string') {
                userData = JSON.parse(rows[0].data);
            } else {
                userData = rows[0].data;
            }
            userData.schedules = schedules;
        }
        
        await conn.query('INSERT INTO user_data (user_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?',
            [user, JSON.stringify(userData), JSON.stringify(userData)]);
        
        conn.release();
        await redis.del(`schedules_${user}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Update schedules error:', err);
        res.status(500).json({ error: 'Internal server error', details: err.message });
    }
});

// --- API: 取得參加賽事 ---
app.get('/api/events/:user', async (req, res) => {
    const { user } = req.params;
    const cacheKey = `events_${user}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));
    }
    try {
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT data FROM user_data WHERE user_id = ?', [user]);
        conn.release();
        if (rows.length === 0) {
            await redis.set(cacheKey, JSON.stringify([]), 'EX', 30);
            return res.json([]);
        }
        let data;
        if (typeof rows[0].data === 'string') {
            data = JSON.parse(rows[0].data);
        } else {
            data = rows[0].data;
        }
        await redis.set(cacheKey, JSON.stringify(data.events || []), 'EX', 30);
        res.json(data.events || []);
    } catch (err) {
        console.error('Get events error:', err);
        res.status(500).json({ error: 'Internal server error', details: err.message });
    }
});

// --- API: 取得使用者資料 ---
app.get('/api/user-data/:user', async (req, res) => {
    const { user } = req.params;
    const cacheKey = `userData_${user}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));
    }
    try {
        const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [user]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'User data not found' });
        }
        let userData;
        if (typeof rows[0].data === 'string') {
            userData = JSON.parse(rows[0].data);
        } else {
            userData = rows[0].data;
        }
        await redis.set(cacheKey, JSON.stringify(userData), 'EX', 30);
        res.json(userData);
    } catch (err) {
        console.error('Get user data error:', err);
        res.status(500).json({ error: 'Failed to get user data' });
    }
});

// --- API: 檢查稱呼是否可用 ---
app.get('/api/check-display-name/:displayName', authenticateToken, async (req, res) => {
    const { displayName } = req.params;
    const userId = req.userId;
    
    if (!displayName || displayName.trim() === '') {
        return res.json({ available: false, error: '稱呼不能為空' });
    }
    
    try {
        // 查詢是否有其他用戶使用相同稱呼
        const [existingUsers] = await pool.query(
            `SELECT u.user_id, ud.data 
             FROM users u 
             JOIN user_data ud ON u.user_id = ud.user_id 
             WHERE u.user_id != ?`,
            [userId]
        );
        
        for (const existingUser of existingUsers) {
            let userData;
            try {
                userData = typeof existingUser.data === 'string' ? JSON.parse(existingUser.data) : existingUser.data;
                while (userData && userData.data) userData = userData.data;
                
                if (userData.profile && userData.profile.displayName && 
                    userData.profile.displayName.trim() === displayName.trim()) {
                    return res.json({ available: false, error: '稱呼已被使用' });
                }
            } catch (error) {
                console.error('解析用戶資料失敗:', error);
                continue;
            }
        }
        
        res.json({ available: true });
    } catch (error) {
        console.error('檢查稱呼失敗:', error);
        res.status(500).json({ error: '檢查稱呼時發生錯誤' });
    }
});

// --- API: 保存用戶資料 ---
app.post('/api/user-data/:user', authenticateToken, async (req, res) => {
    const { user } = req.params;
    if (req.userId !== user) return res.status(403).json({ error: 'Forbidden' });
    
    try {
        const { data } = req.body;
        if (!data) return res.status(400).json({ error: 'Missing data' });
        
        // 檢查稱呼唯一性
        if (data.profile && data.profile.displayName) {
            const displayName = data.profile.displayName.trim();
            if (displayName) {
                // 查詢是否有其他用戶使用相同稱呼
                const [existingUsers] = await pool.query(
                    `SELECT u.user_id, ud.data 
                     FROM users u 
                     JOIN user_data ud ON u.user_id = ud.user_id 
                     WHERE u.user_id != ?`,
                    [user]
                );
                
                for (const existingUser of existingUsers) {
                    let userData;
                    try {
                        userData = typeof existingUser.data === 'string' ? JSON.parse(existingUser.data) : existingUser.data;
                        while (userData && userData.data) userData = userData.data;
                        
                        if (userData.profile && userData.profile.displayName && 
                            userData.profile.displayName.trim() === displayName) {
                            return res.status(400).json({ error: '稱呼已被使用，請選擇其他稱呼' });
                        }
                    } catch (error) {
                        console.error('解析用戶資料失敗:', error);
                        continue;
                    }
                }
            }
        }
        
        // 獲取現有資料
        const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [user]);
        let existingData = {};
        if (rows.length > 0) {
            existingData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
        }
        
        // 合併資料
        const updatedData = { ...existingData, ...data };
        const jsonData = JSON.stringify(updatedData);
        
        // 保存資料
        if (rows.length > 0) {
            await pool.query('UPDATE user_data SET data = ? WHERE user_id = ?', [jsonData, user]);
        } else {
            await pool.query('INSERT INTO user_data (user_id, data) VALUES (?, ?)', [user, jsonData]);
        }
        
        // 清除相關快取
        await redis.del(`data_${user}`);
        await redis.del(`userData_${user}`);
        await redis.del(`leaderboard_${user}`);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Save user data error:', err);
        res.status(500).json({ error: 'Failed to save user data' });
    }
});

// --- API: 同步配對狀態（前端用於避免 404） ---
app.post('/api/sync-pairing', authenticateToken, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        
        const userId = req.userId;
        const { action, partnerId, partnerName, partnerAvatarUrl } = req.body || {};

        if (action === 'pair') {
            // 驗證輸入
            if (!partnerId || !partnerName) {
                await connection.rollback();
                return res.status(400).json({ error: 'Missing partnerId or partnerName' });
            }
            
            // 讀取雙方資料
            const [userRows] = await connection.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
            const [partnerRows] = await connection.query('SELECT data FROM user_data WHERE user_id = ?', [partnerId]);
            
            let userData = userRows.length > 0 ? (typeof userRows[0].data === 'string' ? JSON.parse(userRows[0].data) : userRows[0].data) : {};
            let partnerData = partnerRows.length > 0 ? (typeof partnerRows[0].data === 'string' ? JSON.parse(partnerRows[0].data) : partnerRows[0].data) : {};
            
        while (userData && userData.data) userData = userData.data;
            while (partnerData && partnerData.data) partnerData = partnerData.data;

            // 設定配對關係
            userData.pairing = {
                partnerId: partnerId,
                partnerName: partnerName,
                partnerAvatarUrl: partnerAvatarUrl || null,
                pairedAt: new Date().toISOString()
            };
            
            partnerData.pairing = {
                partnerId: userId,
                partnerName: req.user?.displayName || req.user?.username || '夥伴',
                partnerAvatarUrl: req.user?.avatarUrl || null,
                pairedAt: new Date().toISOString()
            };
            
            // 原子性更新雙方資料
            await connection.query('INSERT INTO user_data (user_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?', 
                [userId, JSON.stringify(userData), JSON.stringify(userData)]);
            await connection.query('INSERT INTO user_data (user_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?', 
                [partnerId, JSON.stringify(partnerData), JSON.stringify(partnerData)]);
            
            await connection.commit();
            
            // 清除快取
            await redis.del(`data_${userId}`, `userData_${userId}`, `data_${partnerId}`, `userData_${partnerId}`);
            await redis.del(`pairing_${userId}`, `pairing_${partnerId}`);
            
            // 審計日誌：配對成功
            console.log('📊 審計日誌: pairing_success', {
                userId: userId,
                partnerId: partnerId,
                action: 'pair',
                timestamp: new Date().toISOString(),
                userAgent: req.get('User-Agent'),
                ip: req.ip
            });
            
            res.json({ success: true, message: '配對成功' });
            
        } else if (action === 'unpair') {
            // 讀取使用者資料
            const [userRows] = await connection.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
            let userData = userRows.length > 0 ? (typeof userRows[0].data === 'string' ? JSON.parse(userRows[0].data) : userRows[0].data) : {};
            while (userData && userData.data) userData = userData.data;
            
            const oldPartnerId = userData.pairing?.partnerId;
            userData.pairing = null;
            
            // 更新使用者資料
            await connection.query('INSERT INTO user_data (user_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?', 
                [userId, JSON.stringify(userData), JSON.stringify(userData)]);
            
            // 如果之前有配對，清除對方的配對
            if (oldPartnerId) {
                const [partnerRows] = await connection.query('SELECT data FROM user_data WHERE user_id = ?', [oldPartnerId]);
                if (partnerRows.length > 0) {
                    let partnerData = typeof partnerRows[0].data === 'string' ? JSON.parse(partnerRows[0].data) : partnerRows[0].data;
                    while (partnerData && partnerData.data) partnerData = partnerData.data;
                    
                    if (partnerData.pairing && partnerData.pairing.partnerId === userId) {
                        partnerData.pairing = null;
                        await connection.query('UPDATE user_data SET data = ? WHERE user_id = ?', 
                            [JSON.stringify(partnerData), oldPartnerId]);
                    }
                }
            }
            
            await connection.commit();

        // 清除快取
            await redis.del(`data_${userId}`, `userData_${userId}`);
            if (oldPartnerId) {
                await redis.del(`data_${oldPartnerId}`, `userData_${oldPartnerId}`, `pairing_${oldPartnerId}`);
            }
            await redis.del(`pairing_${userId}`);
            
            res.json({ success: true, message: '取消配對成功' });
            
        } else {
            await connection.rollback();
            res.status(400).json({ error: 'Invalid action' });
        }
        
    } catch (err) {
        await connection.rollback();
        console.error('sync-pairing transaction failed:', err);
        
        // 審計日誌：配對失敗
        console.log('📊 審計日誌: pairing_failed', {
            userId: req.userId,
            action: req.body?.action,
            partnerId: req.body?.partnerId,
            error: err.message,
            timestamp: new Date().toISOString(),
            userAgent: req.get('User-Agent'),
            ip: req.ip
        });
        
        res.status(500).json({ error: 'Failed to sync pairing', details: err.message });
    } finally {
        connection.release();
    }
});

// --- API: 取消配對（相容舊前端路由 /api/unpair/:partnerId） ---
app.post('/api/unpair/:partnerId', authenticateToken, async (req, res) => {
    try {
        const userId = req.userId;
        const partnerId = req.params.partnerId;

        // 讀取使用者資料
        const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
        let userData = rows.length > 0 ? (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data) : {};
        while (userData && userData.data) userData = userData.data;

        // 僅在當前 pairing 指向該 partnerId 時清除
        if (userData.pairing && userData.pairing.partnerId === partnerId) {
            userData.pairing = null;
        }

        // 保存當前使用者
        await pool.query('INSERT INTO user_data (user_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?', [userId, JSON.stringify(userData), JSON.stringify(userData)]);

        // 嘗試同步清除對方（若對方 pairing 指向我）
        try {
            const [pRows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [partnerId]);
            if (pRows.length > 0) {
                let pData = typeof pRows[0].data === 'string' ? JSON.parse(pRows[0].data) : pRows[0].data;
                while (pData && pData.data) pData = pData.data;
                if (pData.pairing && pData.pairing.partnerId === userId) {
                    pData.pairing = null;
                    await pool.query('UPDATE user_data SET data = ? WHERE user_id = ?', [JSON.stringify(pData), partnerId]);
                    await redis.del(`data_${partnerId}`);
                    await redis.del(`userData_${partnerId}`);
                }
            }
        } catch (e) {
            console.warn('Unpair partner side cleanup failed (non-fatal):', e && (e.message || e.toString()));
        }

        // 清除快取
        await redis.del(`data_${userId}`);
        await redis.del(`userData_${userId}`);

        // 記錄同步日志（可選）
        try {
            await pool.query('INSERT INTO sync_logs (user_id, action, data_type) VALUES (?, ?, ?)', [userId, 'unpair', 'pairing']);
        } catch (e) {}

        res.json({ success: true });
    } catch (err) {
        console.error('Unpair endpoint error:', err);
        res.status(500).json({ error: 'Failed to unpair' });
    }
});

// --- API: 取得同步記錄 ---
app.get('/api/sync-logs/:user', async (req, res) => {
    const { user } = req.params;
    const cacheKey = `syncLogs_${user}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));
    }
    try {
        const [rows] = await pool.query(
            'SELECT * FROM sync_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT 50',
            [user]
        );
        await redis.set(cacheKey, JSON.stringify(rows), 'EX', 30);
        res.json(rows);
    } catch (err) {
        console.error('Get sync logs error:', err);
        res.status(500).json({ error: 'Failed to get sync logs' });
    }
});

// --- API: 驗證 token ---
app.get('/api/verify-token', authenticateToken, async (req, res) => {
    const cacheKey = `verify_${req.userId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));
    }
    try {
        const [rows] = await pool.query(
            'SELECT user_id, username FROM users WHERE user_id = ?',
            [req.userId]
        );
        if (rows.length === 0) {
            const result = { valid: false, user: null };
            await redis.set(cacheKey, JSON.stringify(result), 'EX', 10);
            return res.status(401).json({ error: '用戶不存在' });
        }
        const user = rows[0];
        const result = {
            valid: true,
            user: {
                userId: user.user_id,
                username: user.username
            }
        };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 10);
        res.json(result);
    } catch (err) {
        console.error('Token verification error:', err);
        res.status(500).json({ error: '驗證失敗' });
    }
});

// --- API: 搜尋用戶 ---
app.get('/api/search-users', authenticateToken, async (req, res) => {
    const { query } = req.query;
    if (!query) {
        return res.json([]);
    }
    const cacheKey = `searchUsers_${req.userId}_${query}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));
    }
    try {
        // 先獲取所有用戶的基本資訊
        const [users] = await pool.query(
            'SELECT user_id, username FROM users WHERE user_id != ?',
            [req.userId]
        );
        
        // 獲取好友列表
        const [friends] = await pool.query(
            'SELECT friend_id FROM friends WHERE user_id = ?',
            [req.userId]
        );
        const friendIds = new Set(friends.map(f => f.friend_id));
        
        // 獲取每個用戶的詳細資訊（包括稱呼）
        const usersWithDetails = await Promise.all(users.map(async (user) => {
            try {
                const [userDataRows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [user.user_id]);
                let avatarUrl = null;
                let avatarType = null;
                let displayName = null;
                
                if (userDataRows.length > 0) {
                    let userData = typeof userDataRows[0].data === 'string' ? JSON.parse(userDataRows[0].data) : userDataRows[0].data;
                    while (userData && userData.data) userData = userData.data;
                    
                    if (userData.profile) {
                        avatarUrl = userData.profile.avatarUrl;
                        avatarType = userData.profile.avatarType;
                        displayName = userData.profile.displayName;
                    }
                }
                
                return {
                    id: user.user_id,
                    username: user.username,
                    displayName: displayName,
                    avatarUrl: avatarUrl,
                    avatarType: avatarType
                };
            } catch (error) {
                console.error('獲取用戶詳細資訊失敗:', error);
                return {
                    id: user.user_id,
                    username: user.username,
                    displayName: null,
                    avatarUrl: null,
                    avatarType: null
                };
            }
        }));
        
        // 過濾符合搜尋條件的用戶（搜尋稱呼或帳號）
        const filteredUsers = usersWithDetails.filter(user => {
            const searchText = query.toLowerCase();
            const username = user.username.toLowerCase();
            const displayName = (user.displayName || '').toLowerCase();
            
            return username.includes(searchText) || displayName.includes(searchText);
        });
        
        // 添加好友狀態並限制結果數量
        const usersWithFriendStatus = filteredUsers.slice(0, 10).map(user => ({
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            // 顯示稱呼，如果沒有稱呼則顯示帳號
            displayText: user.displayName || user.username,
            isFriend: friendIds.has(user.id),
            avatarUrl: user.avatarUrl,
            avatarType: user.avatarType
        }));
        
        await redis.set(cacheKey, JSON.stringify(usersWithFriendStatus), 'EX', 30);
        res.json(usersWithFriendStatus);
    } catch (err) {
        console.error('Search users error:', err);
        res.status(500).json({ error: '搜尋失敗' });
    }
});

// --- API: 添加好友 ---
app.post('/api/add-friend', authenticateToken, async (req, res) => {
    const { friendId } = req.body;
    const userId = req.userId;
    try {
        const [users] = await pool.query(
            'SELECT user_id FROM users WHERE user_id = ?',
            [friendId]
        );
        if (users.length === 0) {
            return res.status(404).json({ error: '用戶不存在' });
        }
        const [existingFriends] = await pool.query(
            'SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
            [userId, friendId, friendId, userId]
        );
        if (existingFriends.length > 0) {
            return res.status(400).json({ error: '已經是好友了' });
        }
        await pool.query(
            'INSERT INTO friends (user_id, friend_id) VALUES (?, ?), (?, ?)',
            [userId, friendId, friendId, userId]
        );
        await redis.del(`friends_${userId}`);
        await redis.del(`friends_${friendId}`);
        await redis.del(`searchUsers_${userId}_*`);
        await redis.del(`searchUsers_${friendId}_*`);
        res.json({ success: true });
    } catch (err) {
        console.error('Add friend error:', err);
        res.status(500).json({ error: '添加好友失敗' });
    }
});

// --- API: 獲取好友列表 ---
app.get('/api/friends', authenticateToken, async (req, res) => {
    const cacheKey = `friends_${req.userId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));
    }
    try {
        const [friends] = await pool.query(
            `SELECT u.user_id, u.username 
             FROM friends f 
             JOIN users u ON f.friend_id = u.user_id 
             WHERE f.user_id = ?`,
            [req.userId]
        );
        
        // 獲取每個好友的詳細資訊（包括稱呼）
        const result = await Promise.all(friends.map(async (friend) => {
            try {
                const [userDataRows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [friend.user_id]);
                let avatarUrl = null;
                let avatarType = null;
                let displayName = null;
                
                if (userDataRows.length > 0) {
                    let userData = typeof userDataRows[0].data === 'string' ? JSON.parse(userDataRows[0].data) : userDataRows[0].data;
                    while (userData && userData.data) userData = userData.data;
                    
                    if (userData.profile) {
                        avatarUrl = userData.profile.avatarUrl;
                        avatarType = userData.profile.avatarType;
                        displayName = userData.profile.displayName;
                    }
                }
                
                return {
                    id: friend.user_id,
                    username: friend.username,
                    displayName: displayName,
                    // 顯示稱呼，如果沒有稱呼則顯示帳號
                    displayText: displayName || friend.username,
                    avatarUrl: avatarUrl,
                    avatarType: avatarType
                };
            } catch (error) {
                console.error('獲取好友詳細資訊失敗:', error);
                return {
                    id: friend.user_id,
                    username: friend.username,
                    displayName: null,
                    displayText: friend.username,
                    avatarUrl: null,
                    avatarType: null
                };
            }
        }));
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 30);
        res.json(result);
    } catch (err) {
        console.error('Get friends error:', err);
        res.status(500).json({ error: '獲取好友列表失敗' });
    }
});

// --- API: 獲取統計資料 ---
app.get('/api/stats/:user_id', authenticateToken, async (req, res) => {
    const { user_id } = req.params;
    const { year, month } = req.query;
    
    if (req.userId !== user_id) return res.status(403).json({ error: 'Forbidden' });
    
    // 如果有指定年月，使用不同的快取鍵
    const cacheKey = year && month ? `stats_${user_id}_${year}_${month}` : `stats_${user_id}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));
    }
    
    try {
        const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [user_id]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'User data not found' });
        }
        
        let userData;
        if (typeof rows[0].data === 'string') {
            userData = JSON.parse(rows[0].data);
        } else {
            userData = rows[0].data;
        }
        const calendarEvents = userData.calendarEvents || {};
        const schedules = userData.schedules || [];
        
        // 計算本週統計
        const today = new Date();
        const day = today.getDay() || 7; // 週日為 0，轉成 7
        const startOfWeek = new Date(today);
        startOfWeek.setDate(today.getDate() - day + 1); // 本週一
        
        let weeklySwim = 0;
        let weeklyBike = 0;
        let weeklyRun = 0;
        
        for (let i = 0; i < 7; i++) {
            const date = new Date(startOfWeek);
            date.setDate(startOfWeek.getDate() + i);
            const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            
            if (calendarEvents[dateKey]) {
                calendarEvents[dateKey].forEach(event => {
                    if (typeof event === 'object' && event.type && event.distance !== undefined) {
                        let type = event.type;
                        // 處理 Strava 英文類型
                        if (type === 'Run') type = '跑步';
                        if (type === 'Ride') type = '騎車';
                        if (type === 'Swim') type = '游泳';
                        
                        switch(type) {
                            case '游泳': weeklySwim += Number(event.distance) || 0; break;
                            case '騎車': weeklyBike += Number(event.distance) || 0; break;
                            case '跑步': weeklyRun += Number(event.distance) || 0; break;
                        }
                    } else if (typeof event === 'string') {
                        if (/游泳|swim/i.test(event)) {
                            const m = event.match(/([\d.]+)\s*km/i);
                            if (m) weeklySwim += Number(m[1]);
                        } else if (/騎車|bike|cycling/i.test(event)) {
                            const m = event.match(/([\d.]+)\s*km/i);
                            if (m) weeklyBike += Number(m[1]);
                        } else if (/跑步|run|running/i.test(event)) {
                            const m = event.match(/([\d.]+)\s*km/i);
                            if (m) weeklyRun += Number(m[1]);
                        } else {
                            const m = event.match(/([\d.]+)\s*km/i);
                            if (m) weeklyRun += Number(m[1]);
                        }
                    }
                });
            }
        }
        
        const weeklyTotal = weeklySwim + weeklyBike + weeklyRun;
        
        // 計算本週進度（與課表目標比較）
        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(startOfWeek.getDate() + 6);
        
        let swimGoal = 0, bikeGoal = 0, runGoal = 0;
        const weekDays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        
        let d = new Date(startOfWeek);
        while (d <= endOfWeek) {
            const weekDay = weekDays[d.getDay()];
            if (schedules.length > 0 && schedules[0][weekDay]) {
                const val = schedules[0][weekDay];
                if (/游/i.test(val)) {
                    const m = val.match(/([\d.]+)\s*[kK]/);
                    if (m) swimGoal += Number(m[1]);
                }
                if (/跑/i.test(val)) {
                    const m = val.match(/([\d.]+)\s*[kK]/);
                    if (m) runGoal += Number(m[1]);
                }
                if (/訓練台|騎|單車|自行車|bike/i.test(val)) {
                    const m = val.match(/([\d.]+)\s*[kK]/);
                    if (m) bikeGoal += Number(m[1]);
                }
            }
            d.setDate(d.getDate() + 1);
        }
        
        const swimRate = swimGoal > 0 ? Math.min(100, Math.round(weeklySwim / swimGoal * 100)) : 0;
        const bikeRate = bikeGoal > 0 ? Math.min(100, Math.round(weeklyBike / bikeGoal * 100)) : 0;
        const runRate = runGoal > 0 ? Math.min(100, Math.round(weeklyRun / runGoal * 100)) : 0;
        
        // 計算每週訓練達成率
        const weeklyGoal = { swim: 5, bike: 100, run: 20 };
        
        // 使用指定的年月或當前年月
        const targetYear = year ? parseInt(year) : today.getFullYear();
        const targetMonth = month ? parseInt(month) : today.getMonth() + 1;
        
        const firstDay = new Date(targetYear, targetMonth - 1, 1);
        const lastDay = new Date(targetYear, targetMonth, 0);
        
        const weeks = [];
        let start = new Date(firstDay);
        start.setDate(start.getDate() - start.getDay());
        
        while (start <= lastDay) {
            const weekStart = new Date(start);
            const weekEnd = new Date(start);
            weekEnd.setDate(weekEnd.getDate() + 6);
            weeks.push({ start: new Date(weekStart), end: new Date(weekEnd) });
            start.setDate(start.getDate() + 7);
        }
        
        const weeklyAchievements = weeks.map((w, idx) => {
            let swim = 0, bike = 0, run = 0;
            let d = new Date(w.start);
            
            while (d <= w.end) {
                if (d >= firstDay && d <= lastDay) {
                    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                    if (calendarEvents[dateKey]) {
                        calendarEvents[dateKey].forEach(event => {
                            if (typeof event === 'object' && event.type && event.distance !== undefined) {
                                let type = event.type;
                                // 處理 Strava 英文類型
                                if (type === 'Run') type = '跑步';
                                if (type === 'Ride') type = '騎車';
                                if (type === 'Swim') type = '游泳';
                                
                                switch(type) {
                                    case '游泳': swim += Number(event.distance) || 0; break;
                                    case '騎車': bike += Number(event.distance) || 0; break;
                                    case '跑步': run += Number(event.distance) || 0; break;
                                }
                            } else if (typeof event === 'string') {
                                if (/游泳|swim/i.test(event)) {
                                    const m = event.match(/([\d.]+)\s*km/i);
                                    if (m) swim += Number(m[1]);
                                } else if (/騎車|bike/i.test(event)) {
                                    const m = event.match(/([\d.]+)\s*km/i);
                                    if (m) bike += Number(m[1]);
                                } else if (/跑步|run/i.test(event)) {
                                    const m = event.match(/([\d.]+)\s*km/i);
                                    if (m) run += Number(m[1]);
                                } else {
                                    const m = event.match(/([\d.]+)\s*km/i);
                                    if (m) run += Number(m[1]);
                                }
                            }
                        });
                    }
                }
                d.setDate(d.getDate() + 1);
            }
            
            const swimRate = Math.min(100, Math.round(swim / weeklyGoal.swim * 100));
            const bikeRate = Math.min(100, Math.round(bike / weeklyGoal.bike * 100));
            const runRate = Math.min(100, Math.round(run / weeklyGoal.run * 100));
            const avgRate = Math.round((swimRate + bikeRate + runRate) / 3);
            
            return {
                week: idx + 1,
                startDate: w.start,
                endDate: w.end,
                swim,
                bike,
                run,
                swimRate,
                bikeRate,
                runRate,
                avgRate
            };
        });
        
        const statsData = {
            weeklyStats: {
                swim: weeklySwim,
                bike: weeklyBike,
                run: weeklyRun,
                total: weeklyTotal
            },
            weeklyProgress: {
                swim: { actual: weeklySwim, goal: swimGoal, rate: swimRate },
                bike: { actual: weeklyBike, goal: bikeGoal, rate: bikeRate },
                run: { actual: weeklyRun, goal: runGoal, rate: runRate }
            },
            weeklyAchievements,
            currentMonth: targetMonth,
            currentYear: targetYear
        };
        
        await redis.set(cacheKey, JSON.stringify(statsData), 'EX', 300); // 5分鐘快取
        res.json(statsData);
        
    } catch (err) {
        console.error('Get stats error:', err);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// --- API: 獲取好友排行榜 ---
app.get('/api/leaderboard/:user_id', authenticateToken, async (req, res) => {
    const { user_id } = req.params;
    if (req.userId !== user_id) return res.status(403).json({ error: 'Forbidden' });
    
    const cacheKey = `leaderboard_${user_id}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        return res.json(JSON.parse(cached));
    }
    
    try {
        // 獲取用戶的好友列表
        const [friends] = await pool.query(
            `SELECT u.user_id, u.username 
             FROM friends f 
             JOIN users u ON f.friend_id = u.user_id 
             WHERE f.user_id = ?`,
            [user_id]
        );
        
        // 獲取用戶自己的資料
        const [userDataRows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [user_id]);
        let userData = {};
        if (userDataRows.length > 0) {
            if (typeof userDataRows[0].data === 'string') {
                userData = JSON.parse(userDataRows[0].data);
            } else {
                userData = userDataRows[0].data;
            }
        }
        
        // 計算用戶自己的本月跑步距離
        const today = new Date();
        const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        
        let userMonthlyRun = 0;
        const userCalendarEvents = userData.calendarEvents || {};
        
        // 遍歷本月的每一天
        for (let date = new Date(startOfMonth); date <= endOfMonth; date.setDate(date.getDate() + 1)) {
            const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            
            if (userCalendarEvents[dateKey]) {
                userCalendarEvents[dateKey].forEach(event => {
                    if (typeof event === 'object' && event.distance !== undefined) {
                        let type = event.type;
                        // 處理 Strava 英文類型
                        if (type === 'Run') type = '跑步';
                        if (type === 'Ride') type = '騎車';
                        if (type === 'Swim') type = '游泳';
                        
                        if (type === '跑步') {
                            userMonthlyRun += Number(event.distance) || 0;
                        }
                    } else if (typeof event === 'string' && /跑步|run|running/i.test(event)) {
                        const m = event.match(/([\d.]+)\s*km/i);
                        if (m) userMonthlyRun += Number(m[1]);
                    }
                });
            }
        }
        
        // 獲取好友的本月跑步距離
        const friendsData = [];
        for (const friend of friends) {
            let friendMonthlyRun = 0;
            let friendData = {};
            
            try {
                const [friendDataRows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [friend.user_id]);
                if (friendDataRows.length > 0) {
                    if (typeof friendDataRows[0].data === 'string') {
                        friendData = JSON.parse(friendDataRows[0].data);
                    } else {
                        friendData = friendDataRows[0].data;
                    }
                }
            } catch (error) {
                console.error('獲取好友資料失敗:', error);
            }
            
            // 計算好友的本月跑步距離
            const friendCalendarEvents = friendData.calendarEvents || {};
            for (const date in friendCalendarEvents) {
                const eventDate = new Date(date);
                if (eventDate >= startOfMonth && eventDate <= endOfMonth) {
                    const events = friendCalendarEvents[date];
                    for (const event of events) {
                        if (event.type === '跑步' || event.type === 'Run') {
                            friendMonthlyRun += parseFloat(event.distance) || 0;
                        }
                    }
                }
            }
            
            // 獲取好友的頭像和稱呼資訊
            let avatarUrl = null;
            let avatarType = null;
            let displayName = null;
            try {
                let userData = friendData;
                while (userData && userData.data) userData = userData.data;
                if (userData.profile) {
                    avatarUrl = userData.profile.avatarUrl;
                    avatarType = userData.profile.avatarType;
                    displayName = userData.profile.displayName;
                }
            } catch (error) {
                console.error('獲取好友頭像失敗:', error);
            }
            friendsData.push({
                userId: friend.user_id,
                username: friend.username,
                displayName: displayName,
                // 顯示稱呼，如果沒有稱呼則顯示帳號
                displayText: displayName || friend.username,
                avatarUrl: avatarUrl,
                avatarType: avatarType,
                monthlyRun: friendMonthlyRun
            });
        }
        
        // 獲取用戶自己的資料
        const [userInfoRows] = await pool.query('SELECT username FROM users WHERE user_id = ?', [user_id]);
        const userInfo = userInfoRows.length > 0 ? userInfoRows[0] : { username: '我' };
        // 取得自己頭像和稱呼
        let selfAvatarUrl = null;
        let selfAvatarType = null;
        let selfDisplayName = null;
        let flatUserData = userData;
        while (flatUserData && flatUserData.data) flatUserData = flatUserData.data;
        if (flatUserData.profile) {
            selfAvatarUrl = flatUserData.profile.avatarUrl;
            selfAvatarType = flatUserData.profile.avatarType;
            selfDisplayName = flatUserData.profile.displayName;
        }
        friendsData.push({
            userId: user_id,
            username: userInfo.username || '我',
            displayName: selfDisplayName,
            // 顯示稱呼，如果沒有稱呼則顯示帳號
            displayText: selfDisplayName || userInfo.username || '我',
            avatarUrl: selfAvatarUrl,
            avatarType: selfAvatarType,
            monthlyRun: userMonthlyRun,
            isCurrentUser: true
        });
        // 按跑步距離排序
        friendsData.sort((a, b) => b.monthlyRun - a.monthlyRun);
        // 添加排名
        friendsData.forEach((item, index) => {
            item.rank = index + 1;
        });
        // 直接回傳所有排行榜資料
        await redis.set(cacheKey, JSON.stringify(friendsData), 'EX', 300); // 5分鐘快取
        res.json(friendsData);
        
    } catch (err) {
        console.error('Get leaderboard error:', err);
        res.status(500).json({ error: 'Failed to get leaderboard' });
    }
});

// ====== JWT 驗證中介層（簡易範例） ======

function authMiddleware(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: '未登入' });
    const token = authHeader.replace('Bearer ', '');
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Token 無效' });
    }
}

// ====== 正式安全版：移除好友 API ======
app.post('/api/remove-friend', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id; // 只從 token 取得
        const { friendId } = req.body;
        if (!userId || !friendId) {
            return res.status(400).json({ error: '缺少 userId 或 friendId' });
        }
        const [result] = await pool.query(
            'DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
            [userId, friendId, friendId, userId]
        );
        
        // 清除相關快取，確保 UI 即時更新
        await redis.del(`friends_${userId}`);
        await redis.del(`friends_${friendId}`);
        await redis.del(`searchUsers_${userId}_*`);
        await redis.del(`searchUsers_${friendId}_*`);
        
        res.json({ success: true });
    } catch (err) {
        console.error('移除好友失敗:', err);
        res.status(500).json({ error: '伺服器錯誤' });
    }
});

// --- 管理 API: 攤平所有 user_data 的 data 巢狀層 ---
app.post('/api/admin/flatten-userdata', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT user_id, data FROM user_data');
        let updated = 0;
        for (const row of rows) {
            let dataObj;
            try {
                dataObj = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
            } catch {
                continue;
            }
            // 解開所有 data 層
            let flat = dataObj;
            while (flat && flat.data) flat = flat.data;
            // 只在有巢狀時才更新
            if (flat !== dataObj) {
                await pool.query('UPDATE user_data SET data = ? WHERE user_id = ?', [JSON.stringify(flat), row.user_id]);
                updated++;
            }
        }
        res.json({ success: true, updated });
    } catch (err) {
        console.error('Flatten user_data error:', err);
        res.status(500).json({ error: 'Failed to flatten user_data' });
    }
});

// --- API: 清除快取 ---
app.post('/api/clear-cache', authenticateToken, async (req, res) => {
    try {
        const userId = req.userId;
        // 清除該用戶相關的快取
        const keys = [
            `stats_${userId}`,
            `stats_${userId}_*`,
            `leaderboard_${userId}`,
            `userData_${userId}`,
            `data_${userId}`
        ];
        
        for (const key of keys) {
            if (key.includes('*')) {
                // 使用 pattern 清除
                const pattern = key.replace('*', '');
                const allKeys = await redis.keys(pattern);
                if (allKeys.length > 0) {
                    await redis.del(...allKeys);
                }
            } else {
                await redis.del(key);
            }
        }
        
        res.json({ success: true, message: '快取已清除' });
    } catch (err) {
        console.error('清除快取失敗:', err);
        res.status(500).json({ error: '清除快取失敗' });
    }
});

// --- API: 取得公開個人資料（含課表資訊） ---
app.get('/api/public-profile/:user_id', async (req, res) => {
    const { user_id } = req.params;
    try {
        const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [user_id]);
        if (rows.length === 0) return res.status(404).json({ error: 'User data not found' });
        let d = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
        while (d && d.data) d = d.data;
        res.json({
            profile: d.profile || {},
            selectedScheduleType: d.selectedScheduleType || '',
            selectedScheduleDistance: d.selectedScheduleDistance || '',
            selectedScheduleLevel: d.selectedScheduleLevel || ''
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get public profile' });
    }
});

// --- API: 取得當前用戶資料（用於頭像載入） ---
app.get('/api/user-data', authenticateToken, async (req, res) => {
    try {
        const userId = req.userId;
        
        // 獲取用戶資料
        const [userDataRows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
        if (userDataRows.length === 0) return res.status(404).json({ error: 'User data not found' });
        
        // 獲取用戶基本信息
        const [userRows] = await pool.query('SELECT username FROM users WHERE user_id = ?', [userId]);
        if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });
        
        let d = typeof userDataRows[0].data === 'string' ? JSON.parse(userDataRows[0].data) : userDataRows[0].data;
        while (d && d.data) d = d.data;
        
        // 添加用戶名到回應中
        d.username = userRows[0].username;
        
        res.json(d);
    } catch (err) {
        console.error('Get user data error:', err);
        res.status(500).json({ error: 'Failed to get user data' });
    }
});

// --- API: 上傳頭像 ---
app.post('/api/upload-avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '沒有上傳檔案' });
        }
        // 新增：檢查檔案型態與大小
        const allowedTypes = ['image/jpeg', 'image/png'];
        if (!allowedTypes.includes(req.file.mimetype)) {
            return res.status(400).json({ error: '只允許 JPG/PNG 圖片' });
        }
        if (req.file.size > 5 * 1024 * 1024) {
            return res.status(400).json({ error: '檔案大小不能超過 5MB' });
        }

        const userId = req.userId;
        const avatarUrl = `/uploads/avatars/${req.file.filename}`;
        console.log('上傳頭像:', { userId, filename: req.file.filename, avatarUrl });

        // 更新用戶資料中的頭像URL
        const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
        if (rows.length === 0) {
            return res.status(404).json({ error: '用戶資料不存在' });
        }

        let userData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
        while (userData && userData.data) userData = userData.data;
        console.log('原始用戶資料:', userData);

        // 更新頭像URL
        if (!userData.profile) userData.profile = {};
        userData.profile.avatarUrl = avatarUrl;
        userData.profile.avatarType = 'custom';
        console.log('更新後的用戶資料:', userData);

        // 保存到資料庫
        console.log('保存用戶資料:', JSON.stringify(userData));
        await pool.query('UPDATE user_data SET data = ? WHERE user_id = ?', [JSON.stringify(userData), userId]);

        // 清除相關快取
        await redis.del(`userData_${userId}`);

        const response = { 
            success: true, 
            avatarUrl: avatarUrl,
            avatarType: 'custom',
            message: '頭像上傳成功' 
        };
        console.log('回應給客戶端:', response);
        res.json(response);
    } catch (err) {
        console.error('上傳頭像失敗:', err);
        res.status(500).json({ error: '上傳頭像失敗' });
    }
});

// --- API: 更新頭像（選擇內建頭像或自訂頭像） ---
app.post('/api/update-avatar', authenticateToken, async (req, res) => {
    try {
        const userId = req.userId;
        const { avatarType, avatarUrl } = req.body;

        // 新增：檢查 avatarType 與 avatarUrl 格式
        if (!avatarType || !avatarUrl) {
            return res.status(400).json({ error: '缺少必要參數' });
        }
        if (!['builtin', 'custom'].includes(avatarType)) {
            return res.status(400).json({ error: 'avatarType 不合法' });
        }
        if (
            (avatarType === 'builtin' && !avatarUrl.startsWith('/images/profile/')) ||
            (avatarType === 'custom' && !avatarUrl.startsWith('/uploads/avatars/'))
        ) {
            return res.status(400).json({ error: 'avatarUrl 路徑不合法' });
        }

        // 更新用戶資料中的頭像資訊
        const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
        if (rows.length === 0) {
            return res.status(404).json({ error: '用戶資料不存在' });
        }

        let userData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
        while (userData && userData.data) userData = userData.data;

        // 更新頭像資訊
        if (!userData.profile) userData.profile = {};
        userData.profile.avatarType = avatarType; // 'builtin' 或 'custom'
        userData.profile.avatarUrl = avatarUrl;

        // 保存到資料庫
        await pool.query('UPDATE user_data SET data = ? WHERE user_id = ?', [JSON.stringify(userData), userId]);

        // 清除相關快取
        await redis.del(`userData_${userId}`);

        res.json({ 
            success: true, 
            avatarUrl: avatarUrl,
            avatarType: avatarType,
            message: '頭像更新成功' 
        });
    } catch (err) {
        console.error('更新頭像失敗:', err);
        res.status(500).json({ error: '更新頭像失敗' });
    }
});

// --- API: 取得內建頭像列表 ---
app.get('/api/builtin-avatars', (req, res) => {
    const builtinAvatars = [
        { id: 'alien', name: '外星人', url: '/images/profile/alien.png' },
        { id: 'anubis', name: '阿努比斯', url: '/images/profile/anubis.png' },
        { id: 'aphrodite', name: '阿芙羅狄蒂', url: '/images/profile/aphrodite.png' },
        { id: 'banshee', name: '女妖', url: '/images/profile/banshee.png' },
        { id: 'dracula', name: '德古拉', url: '/images/profile/dracula.png' },
        { id: 'genie', name: '精靈', url: '/images/profile/genie.png' },
        { id: 'harpy', name: '哈耳庇厄', url: '/images/profile/harpy.png' },
        { id: 'mythical-creature', name: '神話生物', url: '/images/profile/mythical-creature.png' },
        { id: 'oni', name: '鬼', url: '/images/profile/oni.png' },
        { id: 'succubus', name: '魅魔', url: '/images/profile/succubus.png' },
        { id: 'unicorn', name: '獨角獸', url: '/images/profile/unicorn.png' },
        { id: 'zeus', name: '宙斯', url: '/images/profile/zeus.png' }
    ];
    res.json(builtinAvatars);
});

// --- 全域錯誤處理 ---
process.on('uncaughtException', err => {
  console.error('Uncaught Exception:', err.stack || err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason && reason.stack ? reason.stack : reason);
});

// --- HTTPS 憑證設定 ---
let options;
try {
  options = {
    key: fs.readFileSync('/etc/letsencrypt/live/ironshrimp.duckdns.org/privkey.pem', { encoding: 'utf8' }),
    cert: fs.readFileSync('/etc/letsencrypt/live/ironshrimp.duckdns.org/fullchain.pem', { encoding: 'utf8' })
  };
} catch (err) {
  console.error('❌ 無法讀取 SSL 憑證，請檢查檔案權限或使用 sudo 執行：', err.message);
  process.exit(1);
}

// --- 啟動 HTTPS Server ---
https.createServer(options, app).listen(443, '0.0.0.0', () => {
  console.log('✅ HTTPS server running at https://ironshrimp.duckdns.org');
});

// --- HTTP 3000 供本地測試 ---
app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
});

// 僅在非生產環境下啟用全域 log middleware
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });
}

// --- API: 取得聊天紀錄 ---
app.get('/api/chat-history/:user_id', authenticateToken, async (req, res) => {
    if (req.userId !== req.params.user_id) return res.status(403).json({ error: 'Forbidden' });
    const { limit = 100, offset = 0 } = req.query;
    const [rows] = await pool.query(
        'SELECT type, content, timestamp FROM chat_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?',
        [req.userId, Number(limit), Number(offset)]
    );
    // 回傳時倒序為正序
    res.json({ chatHistory: rows.reverse() });
});

// --- API: 新增一則聊天訊息，並只保留最新100則 ---
app.post('/api/chat-history/:user_id', authenticateToken, async (req, res) => {
    if (req.userId !== req.params.user_id) return res.status(403).json({ error: 'Forbidden' });
    const { type, content } = req.body;
    if (!type || !content) return res.status(400).json({ error: 'Missing type or content' });
    await pool.query('INSERT INTO chat_history (user_id, type, content) VALUES (?, ?, ?)', [req.userId, type, content]);
    // 只保留最新100則
    await pool.query(
        'DELETE FROM chat_history WHERE user_id = ? AND id NOT IN (SELECT id FROM (SELECT id FROM chat_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT 100) AS t)',
        [req.userId, req.userId]
    );
    res.json({ success: true });
});

// --- API: 刪除單則訊息 ---
app.delete('/api/chat-history/:user_id', authenticateToken, async (req, res) => {
    if (req.userId !== req.params.user_id) return res.status(403).json({ error: 'Forbidden' });
    const { timestamp } = req.body;
    if (!timestamp) return res.status(400).json({ error: 'Missing timestamp' });
    await pool.query('DELETE FROM chat_history WHERE user_id = ? AND timestamp = ?', [req.userId, timestamp]);
    res.json({ success: true });
});

// --- API: 刪除全部訊息 ---
app.delete('/api/chat-history/:user_id/all', authenticateToken, async (req, res) => {
    if (req.userId !== req.params.user_id) return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM chat_history WHERE user_id = ?', [req.userId]);
    res.json({ success: true });
});

// ===== Web Push 推播相關 =====
const vapidKeys = webpush.generateVAPIDKeys();
webpush.setVapidDetails(
  'mailto:your@email.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// 儲存所有訂閱（可改為 DB）
let subscriptions = [];

app.use(bodyParser.json());

// 提供前端取得 public key
app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// 前端註冊訂閱
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!subscriptions.find(s => s.endpoint === sub.endpoint)) {
    subscriptions.push(sub);
  }
  res.status(201).json({});
});

// 測試推播 API
app.post('/api/push/send', async (req, res) => {
  const { title, body } = req.body;
  const payload = JSON.stringify({ title, body });
  let success = 0;
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      success++;
    } catch (err) {
      // 失效訂閱自動移除
      if (err.statusCode === 410 || err.statusCode === 404) {
        subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
      }
    }
  }
  res.json({ sent: success });
});

// 新增：Firebase Custom Token 產生 API (須確保已安裝 firebase-admin)
try {
  admin.initializeApp({
    credential: admin.credential.cert(require('./serviceAccountKey.json'))
  });
} catch (e) {
  // 避免重複初始化錯誤
}

app.post('/api/firebase/custom-token', authenticateToken, async (req, res) => {
  try {
    const uid = req.userId; // 用自己本地會員 userId 當 firebase uid
    const customToken = await admin.auth().createCustomToken(uid);
    res.json({ customToken });
  } catch (error) {
    console.error('產生 customToken 失敗:', error);
    res.status(500).json({ error: 'Failed to create Firebase custom token' });
  }
});

// ==【新】GET 雙邊配對 api ==
// 配對狀態快取
const pairingCache = new Map();
const pairingCacheTimeout = 30 * 1000; // 30秒快取

app.get('/api/pairing/:userId', async (req, res) => {
    const userId = req.params.userId;
    
    // 輸入驗證
    if (!userId || !/^user_\d+$/.test(userId)) {
        return res.status(400).json({ error: 'Invalid userId format' });
    }
    
    try {
        // 檢查快取
        const cacheKey = `pairing_${userId}`;
        const cached = pairingCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < pairingCacheTimeout) {
            return res.json(cached.data);
        }
        
        // 查詢資料庫
        const [rows] = await pool.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
        if (rows.length === 0) {
            const result = { paired: false };
            pairingCache.set(cacheKey, { data: result, timestamp: Date.now() });
            return res.json(result);
        }
        
        let userData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
        while (userData && userData.data) userData = userData.data;
        
        const result = userData.pairing && userData.pairing.partnerId ? {
            paired: true,
            partnerId: userData.pairing.partnerId,
            partnerName: userData.pairing.partnerName,
            partnerAvatarUrl: userData.pairing.partnerAvatarUrl,
            pairedAt: userData.pairing.pairedAt
        } : { paired: false };
        
        // 更新快取
        pairingCache.set(cacheKey, { data: result, timestamp: Date.now() });
        res.json(result);
        
    } catch (error) {
        console.error('配對狀態查詢失敗:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===== 靜態文件服務（必須在所有 API 路由之後） =====
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname))); // 根目錄靜態檔案
app.use('/clendar', express.static(path.join(__dirname, 'clendar')));

// 根路徑路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});






