// Service Worker for clendar

// 週期性同步間隔（單位：毫秒）
const SYNC_INTERVAL = 10 * 60 * 1000; // 10 分鐘
let syncTimer = null;

// 儲存 client
let clientsList = [];

// 後台自動同步邏輯
async function syncStravaData() {
  // 這裡僅做範例，實際應根據你的 API 實作
  // 你可以用 fetch('/api/strava/activities?...') 取得資料
  // 並用 postMessage 通知前端
  // 這裡只做簡單通知
  const allClients = await self.clients.matchAll({ includeUncontrolled: true });
  allClients.forEach(client => {
    client.postMessage({ type: 'strava-sync', status: 'start' });
  });
  // 模擬同步延遲
  await new Promise(r => setTimeout(r, 2000));
  allClients.forEach(client => {
    client.postMessage({ type: 'strava-sync', status: 'done' });
  });
}

function startAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(syncStravaData, SYNC_INTERVAL);
}

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
  startAutoSync();
});

// 前端可 postMessage 來觸發立即同步
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'sync-now') {
    syncStravaData();
  }
});

// 處理 Web Push 推播
self.addEventListener('push', function(event) {
  let data = {};
  try {
    data = event.data.json();
  } catch {
    data = { type: 'push-sync', title: '日曆推播', body: event.data.text() };
  }
  // 顯示通知
  event.waitUntil(
    self.registration.showNotification(data.title || '日曆推播', {
      body: data.body || '有新運動資料同步',
      icon: '/images/calendar_2.png',
      data: data
    })
  );
  // 通知所有分頁
  self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
    clients.forEach(client => {
      client.postMessage(data);
    });
  });
});

// 點擊通知可聚焦分頁
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clientsArr => {
      for (const client of clientsArr) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/clendar/clendar.html');
    })
  );
});
