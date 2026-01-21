# 導航列統整說明

## 概述
將所有分頁的導航列統一整合到 `nav.js` 文件中，實現統一維護和功能管理。

## 統整內容

### 1. 創建統一導航列組件 (`nav.js`)
- **NavigationBar 類別**：管理所有導航列功能
- **自動檢測當前頁面**：根據 URL 路徑自動判斷當前頁面
- **動態生成導航列**：根據頁面位置生成正確的相對路徑
- **統一事件處理**：處理所有導航按鈕的點擊事件

### 2. 支援的頁面類型
- **主頁面**：`index.html`, `stats.html`
- **子頁面**：`clendar/clendar.html`, `chat/chat_v5_CT226.html`, `membership/membership.html`
- **特殊頁面**：`chat/chat_gemini.html`（聊天頁面的特殊配置）

### 3. 導航列功能

#### 基本功能
- **自動激活當前頁面**：根據 URL 自動設置當前頁面的激活狀態
- **統一樣式**：所有頁面使用相同的導航列樣式和動畫效果
- **響應式設計**：支援不同螢幕尺寸的顯示

#### 特殊功能
- **日曆按鈕事件**：
  - 點擊時同步雲端資料
  - 同步 Strava 狀態到雲端
  - 在日曆頁面時同步 Strava 狀態從雲端

- **統計按鈕事件**：
  - 點擊時主動同步雲端資料

#### 聊天按鈕特殊樣式
- 圓形背景設計
- 懸浮效果和動畫
- 特殊的位置和大小設定

### 4. 移除的重複代碼

#### 從各頁面移除的內容：
1. **HTML 結構**：移除所有 `<div class="nav-buttons">` 區塊
2. **CSS 樣式**：移除所有 `.nav-buttons` 和 `.nav-button` 相關樣式
3. **JavaScript 事件**：移除所有導航按鈕的事件監聽器代碼

#### 更新的頁面：
- `index.html`
- `stats.html`
- `clendar/clendar.html`
- `chat/chat_v5_CT226.html`
- `chat/chat_gemini.html`
- `membership/membership.html`

### 5. 使用方法

#### 自動初始化
```html
<!-- 在每個頁面的 </body> 前添加 -->
<script src="nav.js"></script>
```

#### 手動初始化（可選）
```javascript
// 如果需要手動控制導航列
const nav = new NavigationBar();
nav.init();
```

### 6. 配置說明

#### 導航配置結構
```javascript
{
    home: { href: 'index.html', icon: 'images/home.svg', text: '主頁' },
    stats: { href: 'stats.html', icon: 'images/stats.svg', text: '統計' },
    chat: { href: 'chat/chat_v5_CT226.html', icon: 'images/chat.svg', text: '聊天' },
    calendar: { href: 'clendar/clendar.html', icon: 'images/calendar.svg', text: '日曆' },
    membership: { href: 'membership/membership.html', icon: 'images/user.svg', text: '會員' }
}
```

#### 路徑配置
- **主頁面配置**：使用相對路徑（如 `index.html`）
- **子頁面配置**：使用上級路徑（如 `../index.html`）
- **特殊頁面配置**：針對特定頁面的特殊路徑設定

### 7. 維護優勢

#### 統一維護
- 所有導航列功能集中在一個文件中
- 修改樣式或功能只需要更新一個文件
- 減少代碼重複和維護成本

#### 功能擴展
- 新增導航功能只需要修改 `nav.js`
- 支援動態配置和自定義事件
- 易於添加新的特殊功能

#### 錯誤處理
- 統一的錯誤處理機制
- 自動檢測和修復路徑問題
- 更好的用戶體驗

### 8. 注意事項

#### 依賴關係
- 需要確保 `nav.js` 文件在所有頁面都能正確載入
- 依賴於 `localStorage` 中的用戶認證信息
- 需要網路連接來同步雲端資料

#### 相容性
- 支援現代瀏覽器的 ES6 語法
- 自動降級處理不支援的功能
- 保持向後相容性

### 9. 未來擴展

#### 可能的改進
- 添加更多動畫效果
- 支援自定義主題
- 添加導航歷史記錄
- 支援鍵盤快捷鍵

#### 新功能建議
- 導航列狀態持久化
- 用戶自定義導航順序
- 多語言支援
- 無障礙功能增強
