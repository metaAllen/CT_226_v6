# 全站登錄檢查功能實現

## 功能概述

在所有頁面自動檢查用戶登錄狀態，如果未登錄則自動跳轉到會員頁面引導登錄。

## 實現方式

### 1. **通用登錄檢查腳本** (`js/login-check.js`)

#### 主要功能：
- **自動檢查**：頁面載入時自動檢查登錄狀態
- **智能跳轉**：未登錄時自動跳轉到會員頁面
- **路徑保存**：保存當前頁面路徑，登錄後自動返回
- **Token 驗證**：可選的 token 有效性驗證
- **頁面過濾**：排除會員頁面和測試頁面

#### 核心函數：
```javascript
// 檢查登錄狀態
function checkLoginStatus() {
    const token = localStorage.getItem('token');
    const currentUser = localStorage.getItem('currentUser');
    return !!(token && currentUser);
}

// 跳轉到會員頁面
function redirectToMembership() {
    // 保存當前頁面路徑
    sessionStorage.setItem('redirectAfterLogin', window.location.pathname);
    window.location.href = '/membership/membership.html';
}
```

### 2. **頁面集成**

#### 已添加登錄檢查的頁面：
- ✅ `index.html` (主頁)
- ✅ `clendar/clendar.html` (日曆頁面)
- ✅ `stats.html` (統計頁面)
- ✅ `chat/chat_v5_CT226.html` (聊天頁面)

#### 添加方式：
```html
<!-- 在 <head> 中添加 -->
<script src="js/login-check.js"></script>
```

### 3. **登錄後自動返回**

#### 會員頁面功能：
- 登錄成功後檢查是否有保存的返回路徑
- 自動跳轉回原來的頁面
- 清除 sessionStorage 中的路徑信息

```javascript
// 登錄成功後檢查返回路徑
const redirectPath = sessionStorage.getItem('redirectAfterLogin');
if (redirectPath) {
    sessionStorage.removeItem('redirectAfterLogin');
    window.location.href = redirectPath;
}
```

## 功能特點

### 1. **智能頁面過濾**
- **會員頁面**：不會觸發跳轉（避免無限循環）
  - `membership/membership.html`
  - `oauth-callback.html`
  - `login.html`
- **測試頁面**：不會觸發跳轉
  - `test_*.html`
  - `debug_*.html`
  - `quick_test*.html`
  - `force_fix_*.html`

### 2. **多時機檢查**
- **頁面載入時**：DOMContentLoaded 事件
- **頁面可見時**：visibilitychange 事件（用戶從其他標籤頁回來時）

### 3. **用戶體驗優化**
- **路徑保存**：登錄後自動返回原頁面
- **無感檢查**：已登錄用戶不會受到影響
- **快速響應**：立即檢查，無延遲

## 使用方式

### 1. **在新頁面中添加登錄檢查**

```html
<!DOCTYPE html>
<html>
<head>
    <!-- 添加登錄檢查腳本 -->
    <script src="js/login-check.js"></script>
</head>
<body>
    <!-- 頁面內容 -->
</body>
</html>
```

### 2. **測試功能**

使用 `test_login_check.html` 頁面測試：
- 檢查當前登錄狀態
- 測試登錄檢查功能
- 模擬登錄/登出
- 測試跳轉功能

### 3. **手動調用**

```javascript
// 檢查登錄狀態
if (window.LoginCheck) {
    const isLoggedIn = window.LoginCheck.checkLoginStatus();
    if (!isLoggedIn) {
        window.LoginCheck.redirectToMembership();
    }
}
```

## 技術細節

### 1. **檢查邏輯**
```javascript
// 檢查 token 和 currentUser 是否存在
const token = localStorage.getItem('token');
const currentUser = localStorage.getItem('currentUser');
return !!(token && currentUser);
```

### 2. **路徑保存機制**
```javascript
// 保存當前頁面路徑到 sessionStorage
sessionStorage.setItem('redirectAfterLogin', window.location.pathname);
```

### 3. **Token 驗證（可選）**
```javascript
// 驗證 token 有效性
const response = await fetch('/api/verify-token', {
    headers: { 'Authorization': `Bearer ${token}` }
});
if (!response.ok) {
    // 清除無效數據並跳轉
    localStorage.removeItem('token');
    localStorage.removeItem('currentUser');
    redirectToMembership();
}
```

## 注意事項

### 1. **路徑配置**
- 確保 `js/login-check.js` 路徑正確
- 確保會員頁面路徑 `/membership/membership.html` 正確

### 2. **測試頁面**
- 測試頁面不會觸發登錄檢查
- 可以正常訪問測試功能

### 3. **性能考慮**
- 檢查邏輯輕量，不會影響頁面載入速度
- Token 驗證為可選功能，默認不啟用

## 故障排除

### 1. **無限跳轉**
- 檢查會員頁面路徑是否正確
- 確認 `isMembershipPage()` 函數邏輯

### 2. **檢查不生效**
- 確認腳本路徑正確
- 檢查瀏覽器控制台是否有錯誤

### 3. **登錄後不返回**
- 檢查 sessionStorage 是否正常工作
- 確認會員頁面的返回邏輯

## 未來改進

### 1. **可選功能**
- 添加配置選項控制檢查行為
- 支持自定義跳轉頁面
- 添加白名單頁面配置

### 2. **用戶體驗**
- 添加登錄提示動畫
- 支持記住用戶選擇
- 添加登錄狀態指示器

### 3. **安全性**
- 增強 token 驗證邏輯
- 添加登錄狀態加密
- 支持多設備登錄管理

