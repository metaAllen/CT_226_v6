# 🔧 API 診斷指南

## 📊 **測試結果分析**

根據您的測試結果，我發現了以下問題：

### **問題 1：認證失敗 (403 Forbidden)**
```
GET /api/user-data/test 403 (Forbidden)
```

**原因：** 用戶未登入或 Token 無效

**解決方案：**
1. 打開主頁面（如 `clendar.html` 或 `index.html`）
2. 進行用戶登入
3. 確保 `localStorage` 中有有效的 `token`
4. 重新載入測試頁面

### **問題 2：API 端點不存在 (404 Not Found)**
```
GET /api/strava/health 404 (Not Found)
GET /api/strava/check-token 404 (Not Found)
```

**原因：** 服務器未重啟，新 API 端點未載入

**解決方案：**
```bash
# 重啟 Node.js 服務器
pm2 restart server
# 或
node server.js
```

### **問題 3：服務器錯誤 (500 Internal Server Error)**
```
POST /api/strava/refresh-token 500 (Internal Server Error)
```

**原因：** 服務器內部錯誤，可能是配置問題

## 🚀 **修復步驟**

### **步驟 1：檢查用戶登入**
1. 打開主頁面
2. 確認已登入
3. 檢查瀏覽器控制台是否有認證相關錯誤

### **步驟 2：重啟服務器**
```bash
# 如果使用 PM2
pm2 restart server

# 如果直接運行
node server.js
```

### **步驟 3：驗證 API 端點**
重啟服務器後，檢查以下端點是否存在：
- `GET /api/strava/health`
- `GET /api/strava/check-token`
- `POST /api/strava/refresh-token`
- `POST /api/strava/status`

### **步驟 4：重新測試**
1. 重新載入 `test_api_endpoints.html`
2. 點擊「檢查服務器狀態」按鈕
3. 依次測試各個 API 端點

## 🔍 **診斷工具**

### **使用改進的測試頁面**
我已經更新了 `test_api_endpoints.html`，新增了：
- ✅ **服務器狀態檢查**：自動檢查服務器運行狀態
- ✅ **詳細錯誤信息**：提供具體的解決建議
- ✅ **認證狀態檢查**：檢查用戶登入狀態

### **手動檢查方法**
```javascript
// 在瀏覽器控制台檢查
console.log('Token:', localStorage.getItem('token'));
console.log('User ID:', localStorage.getItem('currentUser'));

// 測試基本連接
fetch('/api/user-data/test', {
    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
}).then(r => console.log('Response:', r.status));
```

## 📋 **檢查清單**

### **服務器端檢查**
- [ ] 服務器是否正在運行？
- [ ] 新的 API 端點是否已添加到 `server.js`？
- [ ] 服務器是否已重啟？
- [ ] 數據庫連接是否正常？

### **客戶端檢查**
- [ ] 用戶是否已登入？
- [ ] `localStorage` 中是否有有效的 `token`？
- [ ] 瀏覽器控制台是否有錯誤？
- [ ] 網絡連接是否正常？

### **API 端點檢查**
- [ ] `/api/strava/health` - 健康檢查
- [ ] `/api/strava/check-token` - Token 檢查
- [ ] `/api/strava/refresh-token` - Token 刷新
- [ ] `/api/strava/status` - 狀態管理

## 🎯 **預期結果**

修復完成後，您應該看到：
- ✅ 認證測試：200 OK
- ✅ 健康檢查：200 OK
- ✅ Token 檢查：200 OK 或 401 Unauthorized（如果未配置 Strava）
- ✅ 狀態管理：200 OK
- ✅ Token 刷新：200 OK 或 400 Bad Request（如果沒有 refresh token）

## 🆘 **如果問題持續存在**

1. **檢查服務器日誌**
   ```bash
   # 查看 PM2 日誌
   pm2 logs server
   
   # 或直接運行查看錯誤
   node server.js
   ```

2. **檢查數據庫連接**
   - 確認 MySQL 服務運行正常
   - 檢查數據庫連接配置

3. **檢查環境變量**
   - 確認 `.env` 文件配置正確
   - 檢查 Strava API 配置

4. **聯繫支持**
   - 提供完整的錯誤日誌
   - 說明已嘗試的解決方案

## 🎉 **成功指標**

當所有問題修復後，您應該看到：
- 🟢 所有 API 端點返回 200 或適當的業務邏輯狀態碼
- 🟢 統一 Strava 同步管理器正常運行
- 🟢 沒有無限遞歸或堆棧溢出錯誤
- 🟢 系統穩定運行

**按照這個指南操作，您的系統應該能夠完全正常運行！** 🚀
