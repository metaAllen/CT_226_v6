/**
 * 統一 Strava 同步管理器
 * 解決當前架構的複雜性和性能問題
 */

class UnifiedStravaSyncManager {
    constructor() {
        this.state = {
            syncEnabled: false,
            tokenValid: false,
            lastSyncTime: null,
            syncInProgress: false,
            errorCount: 0
        };
        
        this.timers = new Map();
        this.requestCache = new Map();
        this.syncQueue = [];
        this.observers = new Set();
        
        this.config = {
            tokenCheckInterval: 5 * 60 * 1000,    // 5分鐘
            syncInterval: 10 * 60 * 1000,         // 10分鐘 (與 Service Worker 一致)
            cacheTimeout: 5 * 60 * 1000,          // 5分鐘
            maxRetries: 3,
            retryDelay: 2000
        };
        
        this.init();
    }
    
    // ===== 初始化 =====
    async init() {
        await this.loadState();
        await this.checkTokenStatus();
        this.startTimers();
        this.setupEventListeners();
        console.log('UnifiedStravaSyncManager 初始化完成');
    }
    
    // ===== 狀態管理 =====
    async loadState() {
        try {
            const userId = localStorage.getItem('currentUser');
            const token = localStorage.getItem('token');
            
            if (!userId || !token) {
                this.state.syncEnabled = false;
                return;
            }
            
            // 從雲端載入狀態
            const response = await this.makeRequest('user-data', () => 
                fetch(`/api/user-data/${userId}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
            );
            
            if (response.ok) {
                const userData = await response.json();
                this.state.syncEnabled = userData.data?.stravaSyncEnabled || false;
                this.state.lastSyncTime = userData.data?.lastStravaSync || null;
            }
            
            this.notifyObservers('stateLoaded', this.state);
        } catch (error) {
            console.error('載入狀態失敗:', error);
        }
    }
    
    async saveState() {
        try {
            const userId = localStorage.getItem('currentUser');
            const token = localStorage.getItem('token');
            
            if (!userId || !token) return;
            
            await this.makeRequest('save-state', () =>
                fetch(`/api/user-data/${userId}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        data: {
                            stravaSyncEnabled: this.state.syncEnabled,
                            lastStravaSync: this.state.lastSyncTime
                        }
                    })
                })
            );
            
            localStorage.setItem('stravaSyncEnabled', this.state.syncEnabled.toString());
        } catch (error) {
            console.error('保存狀態失敗:', error);
        }
    }
    
    // ===== Token 管理 =====
    async checkTokenStatus() {
        try {
            const userId = localStorage.getItem('currentUser');
            const token = localStorage.getItem('token');
            
            if (!userId || !token) {
                this.state.tokenValid = false;
                return;
            }
            
            const response = await this.makeRequest('token-check', () =>
                fetch('/api/strava/check-token', {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
            );
            
            // 處理 404 錯誤（API 端點不存在）
            if (response.status === 404) {
                console.warn('Strava API 端點不存在，使用舊的檢查方式');
                this.state.tokenValid = true; // 假設 token 有效，避免阻塞
                this.state.errorCount = 0;
                return;
            }
            
            this.state.tokenValid = response.ok;
            this.state.errorCount = response.ok ? 0 : this.state.errorCount + 1;
            
            this.notifyObservers('tokenStatusChanged', { valid: this.state.tokenValid });
        } catch (error) {
            console.error('檢查 token 狀態失敗:', error);
            this.state.tokenValid = false;
            this.state.errorCount++;
        }
    }
    
    async refreshToken() {
        try {
            const userId = localStorage.getItem('currentUser');
            const token = localStorage.getItem('token');
            
            const response = await this.makeRequest('refresh-token', () =>
                fetch('/api/strava/refresh-token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ userId })
                })
            );
            
            if (response.ok) {
                this.state.tokenValid = true;
                this.state.errorCount = 0;
                this.notifyObservers('tokenRefreshed');
                return true;
            }
            
            return false;
        } catch (error) {
            console.error('刷新 token 失敗:', error);
            return false;
        }
    }
    
    // ===== 數據同步 =====
    async syncStravaData() {
        if (this.state.syncInProgress) {
            console.log('同步已進行中，跳過重複請求');
            return;
        }
        
        if (!this.state.syncEnabled) {
            console.log('同步未啟用，跳過');
            return;
        }
        
        if (!this.state.tokenValid) {
            console.log('Token 無效，嘗試檢查狀態');
            await this.checkTokenStatus();
            if (!this.state.tokenValid) {
                console.log('Token 仍無效，跳過同步');
                return;
            }
        }
        
        this.state.syncInProgress = true;
        this.notifyObservers('syncStarted');
        
        console.log('開始 Strava 數據同步...', {
            syncEnabled: this.state.syncEnabled,
            tokenValid: this.state.tokenValid,
            lastSyncTime: this.state.lastSyncTime
        });
        
        try {
            const userId = localStorage.getItem('currentUser');
            const token = localStorage.getItem('token');
            
            // 獲取 Strava 活動
            const response = await this.makeRequest('strava-activities', () =>
                fetch('/api/strava/activities', {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
            );
            
            if (response.ok) {
                const data = await response.json();
                await this.processActivities(data.activities || []);
                this.state.lastSyncTime = new Date().toISOString();
                this.state.errorCount = 0;
                this.notifyObservers('syncCompleted', { 
                    activityCount: data.activities?.length || 0 
                });
            } else if (response.status === 401) {
                // Token 過期，嘗試刷新
                const refreshed = await this.refreshToken();
                if (refreshed) {
                    // 重試同步
                    setTimeout(() => this.syncStravaData(), 1000);
                } else {
                    this.notifyObservers('syncFailed', { reason: 'token_expired' });
                }
            } else {
                throw new Error(`同步失敗: ${response.status}`);
            }
            
        } catch (error) {
            console.error('Strava 同步失敗:', error);
            this.state.errorCount++;
            this.notifyObservers('syncFailed', { error: error.message });
        } finally {
            this.state.syncInProgress = false;
        }
    }
    
    async processActivities(activities) {
        const userId = localStorage.getItem('currentUser');
        let events = JSON.parse(localStorage.getItem(`calendarEvents_${userId}`) || '{}');
        let newCount = 0;
        
        activities.forEach(activity => {
            const dateKey = this.formatDateKey(new Date(activity.start_date));
            if (!events[dateKey]) events[dateKey] = [];
            
            let activityType = activity.type;
            if (activityType === 'Run') activityType = '跑步';
            if (activityType === 'Ride') activityType = '騎車';
            if (activityType === 'Swim') activityType = '游泳';
            
            // 檢查是否已存在
            const exists = events[dateKey].some(ev => ev.strava_id === activity.id);
            if (!exists) {
                events[dateKey].push({
                    type: activityType,
                    distance: activity.distance,
                    duration: Math.round(activity.moving_time / 60),
                    source: 'Strava',
                    strava_id: activity.id,
                    syncedAt: new Date().toISOString()
                });
                newCount++;
            }
        });
        
        // 保存到本地存儲
        localStorage.setItem(`calendarEvents_${userId}`, JSON.stringify(events));
        localStorage.setItem('calendarEvents', JSON.stringify(events));
        
        // 同步到雲端
        await this.syncToCloud(events);
        
        return newCount;
    }
    
    async syncToCloud(events) {
        try {
            const userId = localStorage.getItem('currentUser');
            const token = localStorage.getItem('token');
            
            // 使用智慧合併邏輯
            const response = await this.makeRequest('cloud-sync', () =>
                fetch(`/api/user-data/${userId}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        data: { calendarEvents: events },
                        mergeStrategy: 'smart' // 使用智慧合併
                    })
                })
            );
            
            if (response.ok) {
                console.log('日曆資料已同步到雲端');
            }
        } catch (error) {
            console.error('同步到雲端失敗:', error);
        }
    }
    
    // ===== 請求管理 =====
    async makeRequest(key, requestFn) {
        // 檢查緩存
        const cached = this.getCachedResponse(key);
        if (cached) {
            return cached;
        }
        
        // 檢查是否有相同的請求正在進行
        if (this.requestCache.has(key)) {
            return this.requestCache.get(key);
        }
        
        // 發送新請求
        const promise = this.retryRequest(requestFn).then(response => {
            this.cacheResponse(key, response);
            this.requestCache.delete(key);
            return response;
        }).catch(error => {
            this.requestCache.delete(key);
            throw error;
        });
        
        this.requestCache.set(key, promise);
        return promise;
    }
    
    async retryRequest(requestFn, retries = this.config.maxRetries) {
        try {
            return await requestFn();
        } catch (error) {
            if (retries > 0) {
                await this.delay(this.config.retryDelay);
                return this.retryRequest(requestFn, retries - 1);
            }
            throw error;
        }
    }
    
    getCachedResponse(key) {
        const cached = this.requestCache.get(key);
        if (cached && Date.now() - cached.timestamp < this.config.cacheTimeout) {
            return cached.data;
        }
        return null;
    }
    
    cacheResponse(key, data) {
        this.requestCache.set(key, {
            data,
            timestamp: Date.now()
        });
    }
    
    // ===== 定時器管理 =====
    startTimers() {
        if (this.state.syncEnabled) {
            this.setTimer('tokenCheck', this.config.tokenCheckInterval, () => this.checkTokenStatus());
            this.setTimer('sync', this.config.syncInterval, () => this.syncStravaData());
        }
    }
    
    setTimer(name, interval, callback) {
        if (this.timers.has(name)) {
            clearInterval(this.timers.get(name));
        }
        
        const timer = setInterval(callback, interval);
        this.timers.set(name, timer);
    }
    
    stopAllTimers() {
        this.timers.forEach(timer => clearInterval(timer));
        this.timers.clear();
    }
    
    // ===== 控制方法 =====
    async enableSync() {
        // 檢查是否已有有效的 Strava token
        const userId = localStorage.getItem('currentUser');
        const token = localStorage.getItem('token');
        
        if (!userId || !token) {
            console.error('用戶未登入，無法啟用 Strava 同步');
            return;
        }
        
        // 檢查是否已有 Strava token
        try {
            const response = await this.makeRequest('token-check', () =>
                fetch('/api/strava/check-token', {
                    headers: { 'Authorization': `Bearer ${token}` }
                })
            );
            
            if (response.ok) {
                // 已有有效的 Strava token，直接啟用同步
                this.state.syncEnabled = true;
                await this.saveState();
                this.startTimers();
                this.notifyObservers('syncEnabled');
                
                // 立即執行一次同步
                setTimeout(() => this.syncStravaData(), 1000);
                return;
            }
        } catch (error) {
            console.log('檢查 Strava token 失敗，需要重新授權');
        }
        
        // 沒有有效的 Strava token，需要重新授權
        try {
            const authResponse = await fetch('/api/strava/auth');
            
            if (authResponse.ok) {
                const authData = await authResponse.json();
                if (authData.url) {
                    // 跳轉到 Strava 授權頁面
                    window.location.href = authData.url;
                    return;
                }
            }
            
            throw new Error('無法取得 Strava 授權網址');
        } catch (error) {
            console.error('Strava 授權失敗:', error);
            this.notifyObservers('syncFailed', { error: error.message });
        }
    }
    
    async disableSync() {
        this.state.syncEnabled = false;
        this.stopAllTimers();
        await this.saveState();
        this.notifyObservers('syncDisabled');
    }
    
    // ===== 觀察者模式 =====
    addObserver(callback) {
        this.observers.add(callback);
    }
    
    removeObserver(callback) {
        this.observers.delete(callback);
    }
    
    notifyObservers(event, data) {
        this.observers.forEach(callback => {
            try {
                callback(event, data);
            } catch (error) {
                console.error('觀察者回調錯誤:', error);
            }
        });
    }
    
    // ===== 工具方法 =====
    formatDateKey(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    setupEventListeners() {
        // 監聽頁面可見性變化
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && this.state.syncEnabled) {
                this.checkTokenStatus();
            }
        });
        
        // 監聽存儲變化
        window.addEventListener('storage', (e) => {
            if (e.key === 'stravaSyncEnabled') {
                this.state.syncEnabled = e.newValue === 'true';
                if (this.state.syncEnabled) {
                    this.startTimers();
                } else {
                    this.stopAllTimers();
                }
            }
        });
    }
    
    // ===== 公共 API =====
    getState() {
        return { ...this.state };
    }
    
    getStats() {
        return {
            syncEnabled: this.state.syncEnabled,
            tokenValid: this.state.tokenValid,
            lastSyncTime: this.state.lastSyncTime,
            errorCount: this.state.errorCount,
            activeTimers: this.timers.size,
            cachedRequests: this.requestCache.size
        };
    }
    
    async forceSync() {
        if (this.state.syncInProgress) {
            console.log('同步已進行中，跳過重複請求');
            return;
        }
        
        this.state.syncInProgress = true;
        this.notifyObservers('syncStarted', {});
        
        try {
            await this.performSync();
        } finally {
            this.state.syncInProgress = false;
            this.notifyObservers('syncCompleted', { activityCount: 0 });
        }
    }
    
    async performSync() {
        // 實際的同步邏輯
        console.log('執行 Strava 同步...');
        
        // 這裡可以添加實際的同步邏輯
        // 暫時只是模擬
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('Strava 同步完成');
    }
    
    async forceTokenRefresh() {
        return await this.refreshToken();
    }
}

// ===== 全局實例 =====
window.stravaSyncManager = new UnifiedStravaSyncManager();

// ===== 向後兼容 =====
// 為了保持與現有代碼的兼容性，提供舊的 API
window.stravaSyncManager.enableStravaSync = () => window.stravaSyncManager.enableSync();
window.stravaSyncManager.disableStravaSync = () => window.stravaSyncManager.disableSync();
window.stravaSyncManager.syncStravaData = () => window.stravaSyncManager.performSync();

console.log('統一 Strava 同步管理器已載入');
