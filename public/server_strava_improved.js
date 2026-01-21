/**
 * 改進的 Strava 同步後端 API
 * 支持智慧合併和統一狀態管理
 */

// ===== 智慧合併中間件 =====
function smartMergeMiddleware(req, res, next) {
    if (req.method === 'POST' && req.body.data && req.body.mergeStrategy === 'smart') {
        // 對 calendarEvents 進行智慧合併
        if (req.body.data.calendarEvents) {
            req.body.data.calendarEvents = mergeCalendarEvents(
                req.body.data.calendarEvents,
                req.existingData?.calendarEvents || {}
            );
        }
    }
    next();
}

// ===== 智慧合併邏輯 =====
function mergeCalendarEvents(localEvents, cloudEvents) {
    // 合併策略：本地優先，雲端補充
    const mergedEvents = { ...cloudEvents, ...localEvents };
    
    // 同一天的活動需要合併陣列，避免重複
    Object.keys(cloudEvents).forEach(dateKey => {
        if (localEvents[dateKey] && cloudEvents[dateKey]) {
            const localActivities = localEvents[dateKey];
            const cloudActivities = cloudEvents[dateKey];
            
            // 合併活動，避免重複（基於 strava_id 或內容比對）
            const mergedActivities = [...localActivities];
            cloudActivities.forEach(cloudActivity => {
                const exists = localActivities.some(localActivity => {
                    // 比對 strava_id 或內容
                    if (localActivity.strava_id && cloudActivity.strava_id) {
                        return localActivity.strava_id === cloudActivity.strava_id;
                    }
                    // 比對內容
                    return JSON.stringify(localActivity) === JSON.stringify(cloudActivity);
                });
                if (!exists) {
                    mergedActivities.push(cloudActivity);
                }
            });
            
            mergedEvents[dateKey] = mergedActivities;
        }
    });
    
    return mergedEvents;
}

// ===== 改進的用戶數據 API =====
app.post('/api/user-data/:userId', authenticateToken, smartMergeMiddleware, async (req, res) => {
    const userId = req.params.userId;
    const currentUserId = req.userId;
    
    if (currentUserId !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    try {
        const conn = await pool.getConnection();
        
        // 獲取現有數據
        const [rows] = await conn.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
        let existingData = rows.length > 0 ? 
            (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data) : {};
        
        // 將現有數據附加到請求對象，供中間件使用
        req.existingData = existingData;
        
        // 合併數據
        const updatedData = {
            ...existingData,
            ...req.body.data,
            lastUpdated: new Date().toISOString()
        };
        
        // 更新數據庫
        await conn.query(
            'INSERT INTO user_data (user_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?',
            [userId, JSON.stringify(updatedData), JSON.stringify(updatedData)]
        );
        
        conn.release();
        
        // 清除相關緩存
        await redis.del(`user_data_${userId}`);
        await redis.del(`calendar_events_${userId}`);
        
        res.json({ success: true, data: updatedData });
    } catch (err) {
        console.error('更新用戶數據失敗:', err);
        res.status(500).json({ error: 'Internal server error', details: err.message });
    }
});

// ===== 改進的 Strava Token 檢查 API =====
app.get('/api/strava/check-token', authenticateToken, async (req, res) => {
    const userId = req.userId;
    
    try {
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
        
        if (rows.length === 0) {
            conn.release();
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userData = typeof rows[0].data === 'string' ? 
            JSON.parse(rows[0].data) : rows[0].data;
        
        conn.release();
        
        if (!userData.strava_access_token) {
            return res.status(401).json({ error: 'No Strava token found' });
        }
        
        // 檢查 token 是否過期
        const tokenExpiresAt = userData.strava_token_expires_at;
        if (tokenExpiresAt && new Date(tokenExpiresAt) <= new Date()) {
            return res.status(401).json({ error: 'Token expired' });
        }
        
        // 測試 token 有效性
        try {
            const testResponse = await fetch('https://www.strava.com/api/v3/athlete', {
                headers: {
                    'Authorization': `Bearer ${userData.strava_access_token}`
                }
            });
            
            if (testResponse.ok) {
                res.json({ valid: true, expiresAt: tokenExpiresAt });
            } else {
                res.status(401).json({ error: 'Token invalid' });
            }
        } catch (error) {
            console.error('Token 測試失敗:', error);
            res.status(401).json({ error: 'Token test failed' });
        }
        
    } catch (err) {
        console.error('檢查 Strava token 失敗:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===== 改進的 Strava Token 刷新 API =====
app.post('/api/strava/refresh-token', authenticateToken, async (req, res) => {
    const userId = req.userId;
    
    try {
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
        
        if (rows.length === 0) {
            conn.release();
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userData = typeof rows[0].data === 'string' ? 
            JSON.parse(rows[0].data) : rows[0].data;
        
        if (!userData.strava_refresh_token) {
            conn.release();
            return res.status(400).json({ error: 'No refresh token found' });
        }
        
        // 使用 refresh token 獲取新的 access token
        const tokenResponse = await fetch('https://www.strava.com/oauth/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                client_id: process.env.STRAVA_CLIENT_ID,
                client_secret: process.env.STRAVA_CLIENT_SECRET,
                grant_type: 'refresh_token',
                refresh_token: userData.strava_refresh_token
            })
        });
        
        if (!tokenResponse.ok) {
            conn.release();
            return res.status(401).json({ error: 'Token refresh failed' });
        }
        
        const tokenData = await tokenResponse.json();
        
        // 更新用戶數據
        userData.strava_access_token = tokenData.access_token;
        userData.strava_refresh_token = tokenData.refresh_token;
        userData.strava_token_expires_at = new Date(tokenData.expires_at * 1000).toISOString();
        userData.lastTokenRefresh = new Date().toISOString();
        
        await conn.query(
            'UPDATE user_data SET data = ? WHERE user_id = ?',
            [JSON.stringify(userData), userId]
        );
        
        conn.release();
        
        // 清除緩存
        await redis.del(`user_data_${userId}`);
        
        res.json({ 
            success: true, 
            expiresAt: userData.strava_token_expires_at 
        });
        
    } catch (err) {
        console.error('刷新 Strava token 失敗:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===== 改進的 Strava 活動獲取 API =====
app.get('/api/strava/activities', authenticateToken, async (req, res) => {
    const userId = req.userId;
    const after = req.query.after || Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
    
    try {
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
        
        if (rows.length === 0) {
            conn.release();
            return res.status(404).json({ error: 'User not found' });
        }
        
        const userData = typeof rows[0].data === 'string' ? 
            JSON.parse(rows[0].data) : rows[0].data;
        
        conn.release();
        
        if (!userData.strava_access_token) {
            return res.status(401).json({ error: 'No Strava token found' });
        }
        
        // 獲取 Strava 活動
        const activitiesResponse = await fetch(
            `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100`,
            {
                headers: {
                    'Authorization': `Bearer ${userData.strava_access_token}`
                }
            }
        );
        
        if (activitiesResponse.status === 401) {
            return res.status(401).json({ error: 'Token expired or invalid' });
        }
        
        if (!activitiesResponse.ok) {
            return res.status(activitiesResponse.status).json({ 
                error: 'Failed to fetch activities' 
            });
        }
        
        const activities = await activitiesResponse.json();
        
        // 過濾和格式化活動數據
        const formattedActivities = activities.map(activity => ({
            id: activity.id,
            type: activity.type,
            name: activity.name,
            distance: activity.distance / 1000, // 轉換為公里
            moving_time: activity.moving_time,
            elapsed_time: activity.elapsed_time,
            start_date: activity.start_date,
            start_date_local: activity.start_date_local
        }));
        
        res.json({ 
            success: true, 
            activities: formattedActivities,
            count: formattedActivities.length
        });
        
    } catch (err) {
        console.error('獲取 Strava 活動失敗:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===== 統一的 Strava 狀態管理 API =====
app.post('/api/strava/status', authenticateToken, async (req, res) => {
    const userId = req.userId;
    const { action, enabled } = req.body;
    
    try {
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
        
        let userData = rows.length > 0 ? 
            (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data) : {};
        
        if (action === 'enable') {
            userData.stravaSyncEnabled = true;
            userData.stravaSyncEnabledAt = new Date().toISOString();
        } else if (action === 'disable') {
            userData.stravaSyncEnabled = false;
            userData.stravaSyncDisabledAt = new Date().toISOString();
        } else if (action === 'toggle') {
            userData.stravaSyncEnabled = enabled;
            if (enabled) {
                userData.stravaSyncEnabledAt = new Date().toISOString();
            } else {
                userData.stravaSyncDisabledAt = new Date().toISOString();
            }
        }
        
        await conn.query(
            'INSERT INTO user_data (user_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?',
            [userId, JSON.stringify(userData), JSON.stringify(userData)]
        );
        
        conn.release();
        
        // 清除緩存
        await redis.del(`user_data_${userId}`);
        
        res.json({ 
            success: true, 
            stravaSyncEnabled: userData.stravaSyncEnabled 
        });
        
    } catch (err) {
        console.error('更新 Strava 狀態失敗:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===== 健康檢查 API =====
app.get('/api/strava/health', authenticateToken, async (req, res) => {
    const userId = req.userId;
    
    try {
        const conn = await pool.getConnection();
        const [rows] = await conn.query('SELECT data FROM user_data WHERE user_id = ?', [userId]);
        
        if (rows.length === 0) {
            conn.release();
            return res.json({ 
                status: 'not_configured',
                message: 'User not found or not configured'
            });
        }
        
        const userData = typeof rows[0].data === 'string' ? 
            JSON.parse(rows[0].data) : rows[0].data;
        
        conn.release();
        
        const health = {
            status: 'healthy',
            stravaSyncEnabled: userData.stravaSyncEnabled || false,
            hasAccessToken: !!userData.strava_access_token,
            hasRefreshToken: !!userData.strava_refresh_token,
            tokenExpiresAt: userData.strava_token_expires_at,
            lastSync: userData.lastStravaSync,
            lastTokenRefresh: userData.lastTokenRefresh
        };
        
        // 檢查 token 是否過期
        if (userData.strava_token_expires_at && 
            new Date(userData.strava_token_expires_at) <= new Date()) {
            health.status = 'token_expired';
            health.message = 'Strava token has expired';
        }
        
        res.json(health);
        
    } catch (err) {
        console.error('健康檢查失敗:', err);
        res.status(500).json({ 
            status: 'error',
            message: 'Health check failed',
            error: err.message 
        });
    }
});

console.log('改進的 Strava 同步後端 API 已載入');
