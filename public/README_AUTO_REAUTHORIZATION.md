# Strava 自動重新授權功能

## 概述

本次修改實現了Strava token失效時的自動重新授權功能，用戶不再需要手動點擊Strava同步按鈕來重新授權。

## 修改內容

### 1. 前端修改

#### `auth.js` - Token管理器改進
- **修改位置**: `tokenManager.refreshToken()` 方法
- **改進內容**: 
  - 當沒有refresh token時，自動觸發重新授權
  - 當token刷新失敗時，自動觸發重新授權
  - 移除自動清除token的邏輯，讓重新授權流程處理

#### `clendar/clendar.html` - 同步邏輯改進
- **修改位置**: `syncStravaData()` 函數
- **改進內容**: 
  - 移除401錯誤時的alert提示
  - 直接自動重新授權，無需用戶手動操作

- **修改位置**: `checkStravaConnection()` 函數
- **改進內容**: 
  - 當token刷新失敗時，自動觸發重新授權
  - 當API返回401時，自動觸發重新授權

- **修改位置**: Strava同步按鈕點擊事件
- **改進內容**: 
  - 當連接檢查失敗時，自動重新授權而不是提示用戶手動點擊

### 2. 後端修改

#### `server.js` - API錯誤處理改進
- **修改位置**: `/api/strava/activities` 端點
- **改進內容**: 
  - 當token刷新失敗時，不立即清除token
  - 讓前端處理重新授權流程
  - 簡化錯誤處理邏輯

## 功能特點

### 1. 自動重新授權觸發條件
- Token過期且refresh token不存在
- Token刷新失敗
- API調用返回401錯誤
- 連接檢查失敗

### 2. 用戶體驗改進
- 無需手動點擊按鈕重新授權
- 系統自動檢測token狀態
- 無縫的重新授權流程
- 減少用戶干預

### 3. 錯誤處理優化
- 移除不必要的alert提示
- 自動處理token失效情況
- 保持用戶操作的連續性

## 測試方法

### 1. 使用測試頁面
訪問 `test_auto_reauthorization.html` 進行測試：

1. **檢查Token狀態**: 查看當前token是否有效
2. **模擬Token失效**: 設置過期時間或清除token
3. **測試自動重新授權**: 驗證自動重新授權功能
4. **測試API調用**: 檢查API調用時的自動處理
5. **測試連接檢查**: 驗證連接檢查功能

### 2. 實際使用測試
1. 登入系統並綁定Strava
2. 等待token自然過期或手動清除token
3. 嘗試同步Strava數據
4. 觀察是否自動跳轉到授權頁面

## 技術實現

### 1. 自動重新授權流程
```javascript
// 當檢測到token失效時
try {
    const res = await fetch('/api/strava/auth');
    const data = await res.json();
    if (data.url) {
        window.location.href = data.url; // 自動跳轉到授權頁面
    }
} catch (authError) {
    console.error('自動重新授權失敗:', authError);
}
```

### 2. Token狀態檢查
```javascript
// 定期檢查token狀態
setInterval(async () => {
    if (tokenManager.isTokenExpired()) {
        const success = await tokenManager.refreshToken();
        if (!success) {
            // 自動觸發重新授權
        }
    }
}, 60 * 1000);
```

## 注意事項

1. **安全性**: 自動重新授權不會影響安全性，仍然需要用戶在Strava頁面確認授權
2. **用戶體驗**: 用戶可能會看到頁面跳轉，但這是必要的授權流程
3. **錯誤處理**: 如果自動重新授權失敗，系統會記錄錯誤但不中斷用戶操作
4. **兼容性**: 修改與現有功能完全兼容，不會影響正常使用

## 故障排除

### 1. 自動重新授權不工作
- 檢查瀏覽器控制台是否有錯誤信息
- 確認網絡連接正常
- 檢查Strava API服務狀態

### 2. 重複跳轉到授權頁面
- 檢查token是否正確保存
- 確認授權流程是否完整
- 查看localStorage中的token狀態

### 3. API調用仍然失敗
- 檢查用戶是否已登入
- 確認Strava同步狀態是否啟用
- 查看服務器日誌中的錯誤信息

## 更新日誌

- **v1.0**: 實現基本的自動重新授權功能
- **v1.1**: 優化錯誤處理和用戶體驗
- **v1.2**: 添加測試頁面和文檔
