// 檢查登入狀態
async function checkAuthStatus() {
    const userInfo = getUserInfo();
    if (!userInfo.isValid) {
        handleLogout();
        return false;
    }

    try {
        const response = await authFetch('/api/verify-token');
        if (!response.ok) {
            handleLogout();
            return false;
        }
        return true;
    } catch (err) {
        console.error('Token verification error:', err);
        handleLogout();
        return false;
    }
}

// 處理登出
function handleLogout() {
    localStorage.removeItem('currentUser');
    localStorage.removeItem('username');
    localStorage.removeItem('token');
    
    // 清除 Strava tokens
    localStorage.removeItem('strava_access_token');
    localStorage.removeItem('strava_refresh_token');
    localStorage.removeItem('strava_expires_at');
    
    // 如果不在會員頁面，則重定向到會員頁面
    if (!window.location.pathname.includes('membership')) {
        window.location.href = '/membership/membership.html';
    }
}

// 獲取用戶信息
function getUserInfo() {
    const userId = localStorage.getItem('currentUser');
    const username = localStorage.getItem('username');
    const token = localStorage.getItem('token');

    return {
        userId,
        username,
        token,
        isValid: Boolean(userId && username && token)
    };
}

// 設置用戶信息
function setUserInfo(userId, username, token) {
    if (!userId || !username || !token) {
        throw new Error('無效的用戶信息');
    }

    localStorage.setItem('currentUser', userId);
    localStorage.setItem('username', username);
    localStorage.setItem('token', token);
}

// 封裝 fetch：攔截 401，嘗試刷新並重試一次
async function authFetch(input, init = {}) {
    const token = localStorage.getItem('token');
    const headers = new Headers(init.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const opts = { ...init, headers };

    let res = await fetch(input, opts);
    // 若伺服器已用 refresh 自動續期，從標頭帶回新 access token，立即更新
    const maybeNew = res.headers.get('x-new-access-token');
    if (maybeNew) {
        localStorage.setItem('token', maybeNew);
    }

    if (res.status === 401) {
        // 嘗試刷新 access token
        const refreshed = await refreshAccessToken();
        if (!refreshed) return res; // 刷新失敗，保持 401

        // 使用新 token 重試一次
        const newToken = localStorage.getItem('token');
        const retryHeaders = new Headers(init.headers || {});
        if (newToken) retryHeaders.set('Authorization', `Bearer ${newToken}`);
        res = await fetch(input, { ...init, headers: retryHeaders });
        const maybeNew2 = res.headers.get('x-new-access-token');
        if (maybeNew2) {
            localStorage.setItem('token', maybeNew2);
        }
    }
    return res;
}

// 呼叫後端 refresh 端點，並更新 localStorage 的 access token
async function refreshAccessToken() {
    try {
        const res = await fetch('/api/refresh-token', { method: 'POST' });
        if (!res.ok) return false;
        const data = await res.json();
        if (data && data.token) {
            localStorage.setItem('token', data.token);
            return true;
        }
        // 或者後端在任一受保護端點透過 x-new-access-token 回傳
        const newToken = res.headers.get('x-new-access-token');
        if (newToken) {
            localStorage.setItem('token', newToken);
            return true;
        }
        return false;
    } catch (e) {
        console.error('refreshAccessToken error:', e);
        return false;
    }
}

// 檢查是否需要登入
function requireAuth() {
    const publicPages = ['/membership/membership.html', '/membership.html'];
    const currentPath = window.location.pathname;
    
    if (!publicPages.includes(currentPath)) {
        checkAuthStatus().then(isAuthenticated => {
            if (!isAuthenticated) {
                handleLogout();
            }
        });
    }
}

// Token 管理功能
const tokenManager = {
    // 檢查 token 是否過期
    isTokenExpired() {
        const expiresAt = localStorage.getItem('strava_expires_at');
        if (!expiresAt) return true;
        
        // 提前 5 分鐘刷新
        const bufferTime = 5 * 60;
        return Date.now() / 1000 > (parseInt(expiresAt) - bufferTime);
    },

    // 刷新 token
    async refreshToken() {
        const refreshToken = localStorage.getItem('strava_refresh_token');
        if (!refreshToken) {
            console.error('No refresh token available');
            return false;
        }

        try {
            console.log('開始刷新 Strava token...');
            const response = await fetch('/api/strava/refresh-token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                body: JSON.stringify({ refresh_token: refreshToken })
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Token refresh failed with status:', response.status, errorData);
                throw new Error(`HTTP ${response.status}: ${errorData.error || 'Unknown error'}`);
            }

            const newTokenData = await response.json();
            
            if (newTokenData.success) {
                // 保存新的 token 信息到 localStorage
                localStorage.setItem('strava_access_token', newTokenData.access_token);
                localStorage.setItem('strava_refresh_token', newTokenData.refresh_token);
                localStorage.setItem('strava_expires_at', newTokenData.expires_at);
                console.log('Token refreshed successfully, updated localStorage');
                return true;
            } else {
                console.error('Token refresh failed:', newTokenData.error);
                return false;
            }
        } catch (err) {
            console.error('Token refresh error:', err);
            return false;
        }
    },

    // 獲取有效的 access token（不自動刷新）
    async getValidAccessToken() {
        if (this.isTokenExpired()) {
            throw new Error('Token 已過期，需要手動重新授權');
        }
        
        return localStorage.getItem('strava_access_token');
    },

    // 清除所有 token
    clearTokens() {
        localStorage.removeItem('strava_access_token');
        localStorage.removeItem('strava_refresh_token');
        localStorage.removeItem('strava_expires_at');
        console.log('All tokens cleared');
    }
};

// 頁面載入時檢查登入狀態
document.addEventListener('DOMContentLoaded', () => {
    requireAuth();
});

// 導出 token 管理器供其他模塊使用
window.tokenManager = tokenManager;
