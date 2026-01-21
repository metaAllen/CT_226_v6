// 通用登錄檢查函數
// 在所有頁面載入時檢查登錄狀態，如果未登錄則跳轉到會員頁面

(function() {
    'use strict';

    // 檢查是否為會員頁面本身，避免無限跳轉
    function isMembershipPage() {
        return window.location.pathname.includes('membership/membership.html') ||
               window.location.pathname.includes('membership.html') ||
               window.location.pathname.includes('oauth-callback.html') ||
               window.location.pathname.includes('login.html');
    }

    // 檢查是否為測試頁面，測試頁面不需要登錄檢查
    function isTestPage() {
        return window.location.pathname.includes('test_') ||
               window.location.pathname.includes('debug_') ||
               window.location.pathname.includes('quick_test') ||
               window.location.pathname.includes('force_fix_');
    }

    // 檢查登錄狀態
    function checkLoginStatus() {
        const token = localStorage.getItem('token');
        const currentUser = localStorage.getItem('currentUser');
        
        // 如果沒有 token 或 currentUser，則未登錄
        if (!token || !currentUser) {
            return false;
        }
        
        return true;
    }

    // 跳轉到會員頁面
    function redirectToMembership() {
        // 保存當前頁面路徑，登錄後可以返回
        const currentPath = window.location.pathname + window.location.search;
        if (currentPath && currentPath !== '/membership/membership.html') {
            sessionStorage.setItem('redirectAfterLogin', currentPath);
        }
        
        // 跳轉到會員頁面
        window.location.href = '/membership/membership.html';
    }

    // 主要檢查函數
    function performLoginCheck() {
        // 如果是會員頁面或測試頁面，不進行檢查
        if (isMembershipPage() || isTestPage()) {
            return;
        }

        // 檢查登錄狀態
        if (!checkLoginStatus()) {
            console.log('用戶未登錄，跳轉到會員頁面');
            redirectToMembership();
            return;
        }

        // 可選：驗證 token 有效性
        validateToken();
    }

    // 驗證 token 有效性（可選功能）
    async function validateToken() {
        const token = localStorage.getItem('token');
        if (!token) return;

        try {
            const response = await fetch('/api/verify-token', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                console.log('Token 無效，清除本地數據並跳轉到會員頁面');
                // 清除無效的登錄數據
                localStorage.removeItem('token');
                localStorage.removeItem('currentUser');
                localStorage.removeItem('username');
                
                // 跳轉到會員頁面
                redirectToMembership();
            }
        } catch (error) {
            console.error('Token 驗證失敗:', error);
            // 網絡錯誤時不跳轉，讓用戶繼續使用
        }
    }

    // 頁面載入時執行檢查
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', performLoginCheck);
    } else {
        // 如果 DOM 已經載入完成，直接執行
        performLoginCheck();
    }

    // 頁面可見性變化時也檢查（用戶從其他標籤頁回來時）
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) {
            // 延遲檢查，避免頻繁檢查
            setTimeout(performLoginCheck, 1000);
        }
    });

    // 導出函數供其他腳本使用
    window.LoginCheck = {
        checkLoginStatus,
        redirectToMembership,
        performLoginCheck,
        validateToken
    };

})();
