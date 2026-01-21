# Strava Token 自動刷新系統

## 概述

本系統實現了 Strava access token 的自動刷新功能，解決了 token 在 6 小時後失效的問題。系統使用 refresh token 來自動更新 access token，確保用戶無需手動重新授權。

## 功能特點

### 1. 自動 Token 刷新
- **定期檢查**: 每分鐘檢查一次 token 是否即將過期
- **提前刷新**: 在 token 過期前 5 分鐘自動刷新
- **本地存儲**: refresh token 和 expires_at 時間戳存儲在本地

### 2. 雙重存儲機制
- **本地存儲**: localStorage 中保存 token 信息，用於前端自動刷新
- **服務器存儲**: 數據庫中保存 token 信息，用於後端 API 調用

### 3. 錯誤處理
- **刷新失敗**: 自動清除無效的 token
- **API 錯誤**: 當 API 調用失敗時，提示用戶重新綁定 Strava

## 文件結構

### 前端文件
- `auth.js`: Token 管理器和認證功能
- `oauth-callback.html`: OAuth 回調處理，保存 token 到本地和服務器
- `test_token_refresh.html`: Token 刷新功能測試頁面

### 後端 API
- `/api/strava/refresh-token`: 刷新 token 的 API 端點
- `/api/strava/save-token`: 保存 token 到數據庫
- `/api/strava/activities`: 獲取 Strava 活動數據（已簡化 token 檢查）

## 使用方法

### 1. 初始化 Token 管理器
```javascript
// 在頁面中引入 auth.js
<script src="auth.js"></script>

// Token 管理器會自動啟動並開始定期檢查
```

### 2. 手動刷新 Token
```javascript
// 檢查 token 是否過期
if (tokenManager.isTokenExpired()) {
    const success = await tokenManager.refreshToken();
    if (!success) {
        console.error('Token 刷新失敗');
    }
}

// 獲取有效的 access token
const accessToken = await tokenManager.getValidAccessToken();
```

### 3. 清除 Token
```javascript
// 清除所有 token
tokenManager.clearTokens();
```

## API 端點

### POST /api/strava/refresh-token
刷新 Strava token

**請求體:**
```json
{
    "refresh_token": "your_refresh_token"
}
```

**響應:**
```json
{
    "success": true,
    "access_token": "new_access_token",
    "refresh_token": "new_refresh_token",
    "expires_at": 1234567890
}
```

## 本地存儲項目

系統會在 localStorage 中保存以下項目：

- `strava_access_token`: 當前的 access token
- `strava_refresh_token`: 用於刷新的 refresh token
- `strava_expires_at`: token 過期時間戳

## 測試

使用 `test_token_refresh.html` 頁面來測試 token 刷新功能：

1. 檢查當前 token 狀態
2. 手動刷新 token
3. 測試 Strava API 調用
4. 清除所有 token

## 注意事項

1. **安全性**: refresh token 存儲在本地，請確保在安全的環境中使用
2. **過期處理**: 如果 refresh token 也過期，用戶需要重新授權 Strava
3. **錯誤恢復**: 當 token 刷新失敗時，系統會自動清除無效的 token
4. **定期檢查**: 系統每分鐘檢查一次 token 狀態，確保及時刷新

## 故障排除

### Token 刷新失敗
1. 檢查 refresh token 是否存在
2. 確認網絡連接正常
3. 檢查 Strava API 服務狀態
4. 如果問題持續，清除所有 token 並重新授權

### API 調用失敗
1. 確認 access token 有效
2. 檢查用戶是否已綁定 Strava
3. 查看瀏覽器控制台的錯誤信息

## 更新日誌

- **v1.0**: 實現基本的 token 自動刷新功能
- **v1.1**: 添加本地存儲和定期檢查機制
- **v1.2**: 簡化後端 API，移除重複的 token 刷新邏輯 