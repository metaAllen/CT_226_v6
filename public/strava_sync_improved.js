/**
 * 改進的 Strava 同步系統
 * 解決當前實現的架構問題和性能問題
 */

// ===== 1. 統一狀態管理器 =====
class StravaStateManager {
    constructor() {
        this.state = {
            syncEnabled: false,
            tokenValid: false,
            lastSync: null,
            errorCount: 0,
            retryCount: 0,
            connectionStatus: 'disconnected', // disconnected, connecting, connected, error
            lastError: null
        };
        this.observers = [];
        this.history = [];
        this.maxHistorySize = 100;
    }
    
    // 狀態變更通知
    setState(newState) {
        const oldState = { ...this.state };
        this.state = { ...this.state, ...newState };
        
        // 記錄狀態變更歷史
        this.recordStateChange(oldState, this.state);
        
        // 通知觀察者
        this.notifyObservers(oldState, this.state);
        
        // 根據狀態調整系統行為
        this.adjustSystemBehavior();
    }
    
    // 記錄狀態變更歷史
    recordStateChange(oldState, newState) {
        const change = {
            timestamp: Date.now(),
            oldState: { ...oldState },
            newState: { ...newState },
            changes: this.getStateChanges(oldState, newState)
        };
        
        this.history.push(change);
        
        // 限制歷史記錄大小
        if (this.history.length > this.maxHistorySize) {
            this.history.shift();
        }
    }
    
    // 獲取狀態變更
    getStateChanges(oldState, newState) {
        const changes = {};
        Object.keys(newState).forEach(key => {
            if (oldState[key] !== newState[key]) {
                changes[key] = {
                    from: oldState[key],
                    to: newState[key]
                };
            }
        });
        return changes;
    }
    
    // 觀察者模式
    subscribe(observer) {
        this.observers.push(observer);
        return () => {
            const index = this.observers.indexOf(observer);
            if (index > -1) {
                this.observers.splice(index, 1);
            }
        };
    }
    
    notifyObservers(oldState, newState) {
        this.observers.forEach(observer => {
            try {
                observer(oldState, newState);
            } catch (error) {
                console.error('Observer error:', error);
            }
        });
    }
    
    // 根據狀態調整系統行為
    adjustSystemBehavior() {
        if (this.state.syncEnabled && this.state.tokenValid) {
            // 正常狀態：降低檢查頻率
            this.emit('state:normal');
        } else if (this.state.syncEnabled && !this.state.tokenValid) {
            // 問題狀態：提高檢查頻率
            this.emit('state:problem');
        } else {
            // 同步禁用：停止所有活動
            this.emit('state:disabled');
        }
    }
    
    // 事件發射器
    emit(event, data) {
        this.observers.forEach(observer => {
            if (typeof observer === 'function' && observer.handleEvent) {
                observer.handleEvent(event, data);
            }
        });
    }
}

// ===== 2. 統一錯誤處理器 =====
class StravaErrorHandler {
    constructor(stateManager) {
        this.stateManager = stateManager;
        this.errorTypes = {
            TOKEN_EXPIRED: 'TOKEN_EXPIRED',
            NETWORK_ERROR: 'NETWORK_ERROR',
            API_ERROR: 'API_ERROR',
            AUTH_ERROR: 'AUTH_ERROR',
            RATE_LIMIT: 'RATE_LIMIT',
            SERVER_ERROR: 'SERVER_ERROR'
        };
        
        this.errorHandlers = new Map();
        this.setupErrorHandlers();
    }
    
    // 設置錯誤處理器
    setupErrorHandlers() {
        this.errorHandlers.set(this.errorTypes.TOKEN_EXPIRED, this.handleTokenExpired.bind(this));
        this.errorHandlers.set(this.errorTypes.NETWORK_ERROR, this.handleNetworkError.bind(this));
        this.errorHandlers.set(this.errorTypes.API_ERROR, this.handleApiError.bind(this));
        this.errorHandlers.set(this.errorTypes.AUTH_ERROR, this.handleAuthError.bind(this));
        this.errorHandlers.set(this.errorTypes.RATE_LIMIT, this.handleRateLimit.bind(this));
        this.errorHandlers.set(this.errorTypes.SERVER_ERROR, this.handleServerError.bind(this));
    }
    
    // 統一錯誤處理入口
    async handleError(error, context = {}) {
        const errorType = this.classifyError(error);
        const errorInfo = {
            type: errorType,
            error: error,
            context: context,
            timestamp: Date.now(),
            stack: error.stack
        };
        
        // 記錄錯誤
        this.logError(errorInfo);
        
        // 更新狀態
        this.stateManager.setState({
            lastError: errorInfo,
            errorCount: this.stateManager.state.errorCount + 1
        });
        
        // 根據錯誤類型處理
        const handler = this.errorHandlers.get(errorType);
        if (handler) {
            try {
                return await handler(error, context);
            } catch (handlerError) {
                console.error('Error handler failed:', handlerError);
                return false;
            }
        } else {
            return await this.handleUnknownError(error, context);
        }
    }
    
    // 錯誤分類
    classifyError(error) {
        if (error.statusCode === 401) return this.errorTypes.TOKEN_EXPIRED;
        if (error.statusCode === 429) return this.errorTypes.RATE_LIMIT;
        if (error.statusCode >= 500) return this.errorTypes.SERVER_ERROR;
        if (error.statusCode >= 400) return this.errorTypes.API_ERROR;
        if (error.code === 'NETWORK_ERROR' || error.name === 'NetworkError') return this.errorTypes.NETWORK_ERROR;
        if (error.message && error.message.includes('auth')) return this.errorTypes.AUTH_ERROR;
        return this.errorTypes.API_ERROR;
    }
    
    // 具體錯誤處理方法
    async handleTokenExpired(error, context) {
        console.log('處理 Token 過期錯誤');
        this.stateManager.setState({ tokenValid: false });
        
        // 觸發重新授權
        this.stateManager.emit('error:tokenExpired', { error, context });
        return false;
    }
    
    async handleNetworkError(error, context) {
        console.log('處理網絡錯誤');
        this.stateManager.setState({ connectionStatus: 'error' });
        
        // 網絡錯誤通常需要重試
        this.stateManager.emit('error:networkError', { error, context });
        return true; // 允許重試
    }
    
    async handleApiError(error, context) {
        console.log('處理 API 錯誤:', error.statusCode);
        
        if (error.statusCode === 404) {
            // 資源不存在，不需要重試
            return false;
        }
        
        // 其他 API 錯誤可能需要重試
        this.stateManager.emit('error:apiError', { error, context });
        return true;
    }
    
    async handleAuthError(error, context) {
        console.log('處理認證錯誤');
        this.stateManager.setState({ tokenValid: false });
        
        // 認證錯誤需要重新授權
        this.stateManager.emit('error:authError', { error, context });
        return false;
    }
    
    async handleRateLimit(error, context) {
        console.log('處理速率限制錯誤');
        
        // 速率限制需要等待
        const retryAfter = error.headers?.['retry-after'] || 60;
        this.stateManager.emit('error:rateLimit', { error, context, retryAfter });
        
        // 延遲重試
        setTimeout(() => {
            this.stateManager.emit('retry:rateLimit', { context });
        }, retryAfter * 1000);
        
        return false;
    }
    
    async handleServerError(error, context) {
        console.log('處理服務器錯誤');
        
        // 服務器錯誤可能需要重試
        this.stateManager.emit('error:serverError', { error, context });
        return true;
    }
    
    async handleUnknownError(error, context) {
        console.log('處理未知錯誤:', error);
        
        // 未知錯誤記錄並嘗試重試
        this.stateManager.emit('error:unknown', { error, context });
        return true;
    }
    
    // 記錄錯誤
    logError(errorInfo) {
        console.error('Strava Error:', {
            type: errorInfo.type,
            message: errorInfo.error.message,
            statusCode: errorInfo.error.statusCode,
            context: errorInfo.context,
            timestamp: new Date(errorInfo.timestamp).toISOString()
        });
    }
}

// ===== 3. 智能定時器管理器 =====
class SmartTimerManager {
    constructor(stateManager) {
        this.stateManager = stateManager;
        this.timers = new Map();
        this.active = false;
        this.config = {
            normal: {
                tokenCheck: 5 * 60 * 1000,      // 5分鐘
                connectionCheck: 15 * 60 * 1000, // 15分鐘
                syncCheck: 30 * 60 * 1000       // 30分鐘
            },
            problem: {
                tokenCheck: 30 * 1000,           // 30秒
                connectionCheck: 2 * 60 * 1000,  // 2分鐘
                syncCheck: 5 * 60 * 1000        // 5分鐘
            },
            disabled: {
                tokenCheck: 0,                   // 停止
                connectionCheck: 0,              // 停止
                syncCheck: 0                     // 停止
            }
        };
        
        this.setupStateListener();
    }
    
    // 設置狀態監聽器
    setupStateListener() {
        this.stateManager.subscribe((oldState, newState) => {
            if (oldState.syncEnabled !== newState.syncEnabled || 
                oldState.tokenValid !== newState.tokenValid) {
                this.adjustTimers(newState);
            }
        });
    }
    
    // 根據狀態調整定時器
    adjustTimers(state) {
        let config;
        
        if (!state.syncEnabled) {
            config = this.config.disabled;
        } else if (state.tokenValid) {
            config = this.config.normal;
        } else {
            config = this.config.problem;
        }
        
        this.setTimer('tokenCheck', config.tokenCheck);
        this.setTimer('connectionCheck', config.connectionCheck);
        this.setTimer('syncCheck', config.syncCheck);
        
        console.log(`調整定時器配置: ${state.syncEnabled ? (state.tokenValid ? '正常' : '問題') : '禁用'}`);
    }
    
    // 設置定時器
    setTimer(name, interval) {
        if (this.timers.has(name)) {
            clearInterval(this.timers.get(name));
            this.timers.delete(name);
        }
        
        if (interval <= 0) {
            console.log(`停止定時器: ${name}`);
            return;
        }
        
        const timer = setInterval(() => {
            this.executeTimer(name);
        }, interval);
        
        this.timers.set(name, timer);
        console.log(`設置定時器: ${name}, 間隔: ${interval / 1000}秒`);
    }
    
    // 執行定時器任務
    executeTimer(name) {
        console.log(`執行定時器: ${name}`);
        
        switch (name) {
            case 'tokenCheck':
                this.stateManager.emit('timer:tokenCheck');
                break;
            case 'connectionCheck':
                this.stateManager.emit('timer:connectionCheck');
                break;
            case 'syncCheck':
                this.stateManager.emit('timer:syncCheck');
                break;
            default:
                console.warn(`未知定時器: ${name}`);
        }
    }
    
    // 停止所有定時器
    stopAllTimers() {
        this.timers.forEach((timer, name) => {
            clearInterval(timer);
            console.log(`停止定時器: ${name}`);
        });
        this.timers.clear();
    }
    
    // 獲取定時器狀態
    getTimerStatus() {
        const status = {};
        this.timers.forEach((timer, name) => {
            status[name] = 'active';
        });
        return status;
    }
}

// ===== 4. 請求管理器 =====
class RequestManager {
    constructor() {
        this.pendingRequests = new Map();
        this.cache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5分鐘
        this.retryConfig = {
            maxRetries: 3,
            baseDelay: 1000,
            maxDelay: 30000,
            backoffMultiplier: 2
        };
    }
    
    // 發送請求（帶去重和緩存）
    async makeRequest(key, requestFn, options = {}) {
        // 檢查是否有相同的請求正在進行
        if (this.pendingRequests.has(key)) {
            console.log(`請求去重: ${key}`);
            return this.pendingRequests.get(key);
        }
        
        // 檢查緩存
        const cached = this.getCachedResponse(key);
        if (cached && !options.forceRefresh) {
            console.log(`使用緩存: ${key}`);
            return cached;
        }
        
        // 發送新請求
        const promise = this.executeRequest(key, requestFn, options);
        this.pendingRequests.set(key, promise);
        
        return promise;
    }
    
    // 執行請求
    async executeRequest(key, requestFn, options) {
        let lastError;
        
        for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
            try {
                const response = await requestFn();
                
                // 請求成功，緩存響應
                this.cacheResponse(key, response);
                this.pendingRequests.delete(key);
                
                return response;
            } catch (error) {
                lastError = error;
                
                if (attempt === this.retryConfig.maxRetries) {
                    // 最後一次嘗試失敗
                    break;
                }
                
                // 計算延遲時間
                const delay = Math.min(
                    this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffMultiplier, attempt),
                    this.retryConfig.maxDelay
                );
                
                console.log(`請求失敗，${delay}ms 後重試 (${attempt + 1}/${this.retryConfig.maxRetries}): ${key}`);
                
                // 等待後重試
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        // 所有重試都失敗
        this.pendingRequests.delete(key);
        throw lastError;
    }
    
    // 獲取緩存的響應
    getCachedResponse(key) {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
            return cached.data;
        }
        
        // 清理過期的緩存
        if (cached) {
            this.cache.delete(key);
        }
        
        return null;
    }
    
    // 緩存響應
    cacheResponse(key, data) {
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
        
        // 限制緩存大小
        if (this.cache.size > 100) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
    }
    
    // 清理緩存
    clearCache() {
        this.cache.clear();
        console.log('緩存已清理');
    }
    
    // 獲取緩存統計
    getCacheStats() {
        return {
            size: this.cache.size,
            pendingRequests: this.pendingRequests.size
        };
    }
}

// ===== 5. 數據存儲管理器 =====
class DataStorageManager {
    constructor() {
        this.localStorage = new LocalStorageAdapter();
        this.cloudStorage = new CloudStorageAdapter();
        this.syncQueue = [];
        this.syncing = false;
        this.syncInterval = 5000; // 5秒同步一次
        this.maxQueueSize = 100;
        
        this.startSyncLoop();
    }
    
    // 設置項目
    async setItem(key, value) {
        // 先更新本地
        await this.localStorage.setItem(key, value);
        
        // 加入同步隊列
        this.addToSyncQueue(key, value);
        
        // 觸發同步
        this.triggerSync();
    }
    
    // 獲取項目
    async getItem(key) {
        // 優先從本地獲取
        let value = await this.localStorage.getItem(key);
        
        // 如果本地沒有，嘗試從雲端獲取
        if (value === null) {
            value = await this.cloudStorage.getItem(key);
            if (value !== null) {
                await this.localStorage.setItem(key, value);
            }
        }
        
        return value;
    }
    
    // 添加到同步隊列
    addToSyncQueue(key, value) {
        // 檢查是否已存在相同的key
        const existingIndex = this.syncQueue.findIndex(item => item.key === key);
        if (existingIndex > -1) {
            // 更新現有項目
            this.syncQueue[existingIndex] = { key, value, timestamp: Date.now() };
        } else {
            // 添加新項目
            this.syncQueue.push({ key, value, timestamp: Date.now() });
        }
        
        // 限制隊列大小
        if (this.syncQueue.length > this.maxQueueSize) {
            this.syncQueue.shift();
        }
    }
    
    // 觸發同步
    triggerSync() {
        if (this.syncing) return;
        
        this.syncing = true;
        this.processSyncQueue();
    }
    
    // 處理同步隊列
    async processSyncQueue() {
        if (this.syncQueue.length === 0) {
            this.syncing = false;
            return;
        }
        
        try {
            while (this.syncQueue.length > 0) {
                const item = this.syncQueue.shift();
                
                try {
                    await this.cloudStorage.setItem(item.key, item.value);
                    console.log(`同步成功: ${item.key}`);
                } catch (error) {
                    console.error(`同步失敗: ${item.key}`, error);
                    
                    // 將失敗的項目重新加入隊列（最多重試3次）
                    if (!item.retryCount || item.retryCount < 3) {
                        item.retryCount = (item.retryCount || 0) + 1;
                        this.syncQueue.push(item);
                    }
                }
            }
        } finally {
            this.syncing = false;
        }
    }
    
    // 啟動同步循環
    startSyncLoop() {
        setInterval(() => {
            if (this.syncQueue.length > 0 && !this.syncing) {
                this.triggerSync();
            }
        }, this.syncInterval);
    }
    
    // 獲取同步狀態
    getSyncStatus() {
        return {
            syncing: this.syncing,
            queueSize: this.syncQueue.length,
            lastSync: this.syncQueue.length > 0 ? this.syncQueue[this.syncQueue.length - 1].timestamp : null
        };
    }
}

// ===== 6. 主控制器 =====
class StravaSyncController {
    constructor() {
        this.stateManager = new StravaStateManager();
        this.errorHandler = new StravaErrorHandler(this.stateManager);
        this.timerManager = new SmartTimerManager(this.stateManager);
        this.requestManager = new RequestManager();
        this.storageManager = new DataStorageManager();
        
        this.setupEventHandlers();
        this.initialize();
    }
    
    // 設置事件處理器
    setupEventHandlers() {
        // 狀態變更事件
        this.stateManager.subscribe((oldState, newState) => {
            this.onStateChange(oldState, newState);
        });
        
        // 錯誤事件
        this.stateManager.subscribe((oldState, newState) => {
            if (newState.lastError) {
                this.onError(newState.lastError);
            }
        });
        
        // 定時器事件
        this.stateManager.subscribe((oldState, newState) => {
            if (newState.syncEnabled) {
                this.setupTimerHandlers();
            }
        });
    }
    
    // 初始化
    async initialize() {
        try {
            // 從存儲中恢復狀態
            const savedState = await this.storageManager.getItem('stravaState');
            if (savedState) {
                this.stateManager.setState(savedState);
            }
            
            // 檢查初始狀態
            await this.checkInitialState();
            
            console.log('Strava 同步控制器初始化完成');
        } catch (error) {
            console.error('初始化失敗:', error);
        }
    }
    
    // 檢查初始狀態
    async checkInitialState() {
        try {
            // 檢查 token 有效性
            const tokenValid = await this.checkTokenValidity();
            this.stateManager.setState({ tokenValid });
            
            // 檢查同步狀態
            const syncEnabled = await this.storageManager.getItem('stravaSyncEnabled') === 'true';
            this.stateManager.setState({ syncEnabled });
            
        } catch (error) {
            console.error('檢查初始狀態失敗:', error);
        }
    }
    
    // 檢查 token 有效性
    async checkTokenValidity() {
        try {
            const token = await this.storageManager.getItem('strava_access_token');
            if (!token) return false;
            
            // 這裡可以添加實際的 token 驗證邏輯
            return true;
        } catch (error) {
            return false;
        }
    }
    
    // 狀態變更處理
    onStateChange(oldState, newState) {
        console.log('狀態變更:', {
            syncEnabled: `${oldState.syncEnabled} → ${newState.syncEnabled}`,
            tokenValid: `${oldState.tokenValid} → ${newState.tokenValid}`,
            connectionStatus: `${oldState.connectionStatus} → ${newState.connectionStatus}`
        });
        
        // 保存狀態到存儲
        this.storageManager.setItem('stravaState', newState);
    }
    
    // 錯誤處理
    onError(errorInfo) {
        console.error('系統錯誤:', errorInfo);
        
        // 這裡可以添加錯誤通知、日誌記錄等邏輯
    }
    
    // 設置定時器處理器
    setupTimerHandlers() {
        // Token 檢查定時器
        this.stateManager.subscribe((oldState, newState) => {
            if (newState.syncEnabled && newState.tokenValid) {
                this.timerManager.adjustTimers(newState);
            }
        });
    }
    
    // 公共方法
    async enableSync() {
        this.stateManager.setState({ syncEnabled: true });
        await this.storageManager.setItem('stravaSyncEnabled', 'true');
    }
    
    async disableSync() {
        this.stateManager.setState({ syncEnabled: false });
        await this.storageManager.setItem('stravaSyncEnabled', 'false');
        this.timerManager.stopAllTimers();
    }
    
    async syncData() {
        if (!this.stateManager.state.syncEnabled) {
            throw new Error('同步未啟用');
        }
        
        try {
            // 執行同步邏輯
            const result = await this.performSync();
            this.stateManager.setState({ 
                lastSync: Date.now(),
                errorCount: 0 
            });
            return result;
        } catch (error) {
            await this.errorHandler.handleError(error, { action: 'syncData' });
            throw error;
        }
    }
    
    // 執行同步
    async performSync() {
        // 這裡實現具體的同步邏輯
        console.log('執行數據同步...');
        
        // 模擬同步過程
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        return { success: true, syncedAt: Date.now() };
    }
    
    // 獲取系統狀態
    getSystemStatus() {
        return {
            state: this.stateManager.state,
            timers: this.timerManager.getTimerStatus(),
            cache: this.requestManager.getCacheStats(),
            sync: this.storageManager.getSyncStatus()
        };
    }
}

// ===== 7. 適配器類 =====

// 本地存儲適配器
class LocalStorageAdapter {
    async setItem(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.error('本地存儲失敗:', error);
            throw error;
        }
    }
    
    async getItem(key) {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : null;
        } catch (error) {
            console.error('本地存儲讀取失敗:', error);
            return null;
        }
    }
}

// 雲端存儲適配器
class CloudStorageAdapter {
    async setItem(key, value) {
        try {
            // 這裡實現雲端存儲邏輯
            const response = await fetch('/api/storage/set', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value })
            });
            
            if (!response.ok) {
                throw new Error(`雲端存儲失敗: ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            console.error('雲端存儲失敗:', error);
            throw error;
        }
    }
    
    async getItem(key) {
        try {
            const response = await fetch(`/api/storage/get?key=${encodeURIComponent(key)}`);
            
            if (!response.ok) {
                if (response.status === 404) return null;
                throw new Error(`雲端存儲讀取失敗: ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            console.error('雲端存儲讀取失敗:', error);
            return null;
        }
    }
}

// ===== 8. 導出和使用 =====

// 創建全局實例
window.stravaSyncController = new StravaSyncController();

// 導出類供其他模塊使用
window.StravaSyncController = StravaSyncController;
window.StravaStateManager = StravaStateManager;
window.StravaErrorHandler = StravaErrorHandler;
window.SmartTimerManager = SmartTimerManager;
window.RequestManager = RequestManager;
window.DataStorageManager = DataStorageManager;

console.log('改進的 Strava 同步系統已載入');

// 使用示例
/*
// 啟用同步
await window.stravaSyncController.enableSync();

// 執行同步
await window.stravaSyncController.syncData();

// 獲取系統狀態
const status = window.stravaSyncController.getSystemStatus();
console.log('系統狀態:', status);

// 監聽狀態變更
window.stravaSyncController.stateManager.subscribe((oldState, newState) => {
    console.log('狀態變更:', newState);
});
*/
