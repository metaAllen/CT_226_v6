// 統一導航列組件
class NavigationBar {
    constructor() {
        this.currentPage = this.getCurrentPage();
        this.navConfig = {
            home: { href: 'index.html', icon: 'images/home.svg', text: '主頁' },
            stats: { href: 'stats.html', icon: 'images/stats.svg', text: '統計' },
            chat: { href: 'chat/chat_v5_CT226.html', icon: 'images/chat.svg', text: '聊天' },
            calendar: { href: 'clendar/clendar.html', icon: 'images/calendar.svg', text: '日曆' },
            membership: { href: 'membership/membership.html', icon: 'images/user.svg', text: '會員' }
        };
        this.subPageNavConfig = {
            home: { href: '../index.html', icon: '../images/home.svg', text: '主頁' },
            stats: { href: '../stats.html', icon: '../images/stats.svg', text: '統計' },
            chat: { href: '../chat/chat_v5_CT226.html', icon: '../images/chat.svg', text: '聊天' },
            calendar: { href: '../clendar/clendar.html', icon: '../images/calendar.svg', text: '日曆' },
            membership: { href: '../membership/membership.html', icon: '../images/user.svg', text: '會員' }
        };
        this.chatGeminiConfig = {
            home: { href: '../index.html', icon: '../images/home.svg', text: '主頁' },
            stats: { href: '../stats.html', icon: '../images/stats.svg', text: '統計' },
            chat: { href: 'chat_gemini.html', icon: '../images/chat.svg', text: '聊天' },
            calendar: { href: '../clendar/clendar.html', icon: '../images/calendar.svg', text: '日曆' },
            membership: { href: '../membership/membership.html', icon: '../images/user.svg', text: '會員' }
        };
    }

    // 獲取當前頁面
    getCurrentPage() {
        const path = window.location.pathname;
        if (path.includes('index.html') || path === '/' || path.endsWith('/')) return 'home';
        if (path.includes('stats.html')) return 'stats';
        if (path.includes('chat_gemini.html')) return 'chat_gemini';
        if (path.includes('chat_v5_CT226.html')) return 'chat';
        if (path.includes('clendar.html')) return 'calendar';
        if (path.includes('membership.html')) return 'membership';
        return 'home';
    }

    // 獲取對應的導航配置
    getNavConfig() {
        if (this.currentPage === 'chat_gemini') {
            return this.chatGeminiConfig;
        } else if (this.currentPage === 'home' || this.currentPage === 'stats') {
            return this.navConfig;
        } else {
            return this.subPageNavConfig;
        }
    }

    // 生成導航列HTML
    generateNavHTML() {
        const config = this.getNavConfig();
        let html = '<div class="nav-buttons">';
        
        Object.keys(config).forEach(key => {
            const item = config[key];
            const isActive = key === this.currentPage ? ' active' : '';
            html += `
                <a href="${item.href}" class="nav-button${isActive}">
                    <img src="${item.icon}" alt="${item.text}">
                    <span>${item.text}</span>
                </a>
            `;
        });
        
        html += '</div>';
        return html;
    }

    // 設置導航列事件監聽器
    setupEventListeners() {
        // 設置當前頁面的導航按鈕為激活狀態
        document.querySelectorAll('.nav-button').forEach(button => {
            const href = button.getAttribute('href');
            if (!href) return;
            
            let absHref = '';
            try {
                absHref = new URL(href, location.origin + location.pathname).pathname.replace(/\/+/g, '/');
            } catch(e) { 
                absHref = href; 
            }
            
            let currentPath = location.pathname.replace(/\/+/g, '/');
            if (absHref === currentPath || (absHref.endsWith('index.html') && (currentPath === '/' || currentPath.endsWith('index.html')))) {
                button.classList.add('active');
            } else {
                button.classList.remove('active');
            }
        });

        // 日曆按鈕特殊事件處理
        this.setupCalendarButtonEvents();
        
        // 統計按鈕特殊事件處理
        this.setupStatsButtonEvents();
    }

    // 設置日曆按鈕事件
    setupCalendarButtonEvents() {
        const calendarNavButton = document.querySelector('.nav-button[href*="clendar.html"]');
        if (calendarNavButton) {
            calendarNavButton.addEventListener('click', (e) => {
                // 進入日曆時同步雲端資料和 Strava 狀態
                const userId = localStorage.getItem('currentUser');
                const token = localStorage.getItem('token');
                if (userId && token) {
                    // 同步雲端資料
                    if (typeof fetchCloudData === 'function') {
                        fetchCloudData(userId, token);
                    }
                    // 同步 Strava 狀態
                    this.syncStravaStatusToCloud();
                    // 如果是日曆頁面，還需要同步 Strava 狀態從雲端
                    if (this.currentPage === 'calendar') {
                        // 延遲執行，確保頁面已載入
                        setTimeout(() => {
                            if (window.stravaSyncManager && typeof window.stravaSyncManager.syncStatusFromCloud === 'function') {
                                window.stravaSyncManager.syncStatusFromCloud();
                            }
                        }, 100);
                    }
                }
                // 新增：切換到 clendar.html 後自動同步日曆（多裝置/分頁同步）
                setTimeout(() => {
                    if (window.syncCalendarFromNav) window.syncCalendarFromNav();
                }, 300);
            });
        }
    }

    // 設置統計按鈕事件
    setupStatsButtonEvents() {
        const statsNavButton = document.querySelector('.nav-button[href*="stats.html"]');
        if (statsNavButton) {
            statsNavButton.addEventListener('click', (e) => {
                // 進入統計頁時主動同步雲端資料
                const userId = localStorage.getItem('currentUser');
                const token = localStorage.getItem('token');
                if (userId && token && typeof fetchCloudData === 'function') {
                    fetchCloudData(userId, token);
                }
            });
        }
    }

    // 同步 Strava 狀態到雲端
    async syncStravaStatusToCloud() {
        const userId = localStorage.getItem('currentUser');
        const token = localStorage.getItem('token');
        if (userId && token) {
            try {
                await fetch('/api/strava/update-sync-status', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ 
                        stravaSyncEnabled: localStorage.getItem('stravaSyncEnabled') === 'true' 
                    })
                });
                console.log('Strava 同步狀態已更新到雲端');
            } catch (error) {
                console.error('同步 Strava 狀態到雲端失敗:', error);
            }
        }
    }

    // 初始化導航列
    init() {
        // 查找現有的導航列容器
        const existingNav = document.querySelector('.nav-buttons');
        if (existingNav) {
            // 替換現有的導航列
            existingNav.outerHTML = this.generateNavHTML();
        } else {
            // 如果沒有找到導航列，在頁面底部添加
            // 使用 fixed 定位，直接添加到 body
            document.body.insertAdjacentHTML('beforeend', this.generateNavHTML());
        }
        
        // 強制設置導航列樣式
        const navElement = document.querySelector('.nav-buttons');
        if (navElement) {
            navElement.style.position = 'fixed';
            navElement.style.bottom = '0';
            navElement.style.left = '0';
            navElement.style.right = '0';
            navElement.style.display = 'flex';
            navElement.style.flexDirection = 'row';
            navElement.style.justifyContent = 'space-around';
            navElement.style.alignItems = 'center';
            navElement.style.zIndex = '1000';
            navElement.style.width = '100%';
            navElement.style.maxWidth = '420px';
            navElement.style.margin = '0 auto';
            navElement.style.transform = 'none';
            navElement.style.background = '#23272f';
            navElement.style.borderTop = '1px solid #2d3748';
            
            // 在移動端時強制延伸至螢幕兩邊
            if (window.innerWidth <= 500) {
                navElement.style.maxWidth = '100vw';
                navElement.style.width = '100vw';
                navElement.style.left = '0';
                navElement.style.right = '0';
                navElement.style.margin = '0';
            }
        }
        
        // 設置事件監聽器
        this.setupEventListeners();
    }
}

// 導航列樣式
const navStyles = `
<style>
.nav-buttons {
    position: fixed !important;
    bottom: 0 !important;
    left: 0 !important;
    right: 0 !important;
    display: flex !important;
    flex-direction: row !important;
    justify-content: space-around !important;
    align-items: center !important;
    padding: 12px 16px !important;
    background: #23272f !important;
    border-top: 1px solid #2d3748 !important;
    z-index: 1000 !important;
    width: 100% !important;
    max-width: 420px !important;
    margin: 0 auto !important;
    box-sizing: border-box !important;
    transform: none !important;
}

.nav-button {
    display: flex !important;
    flex-direction: column !important;
    align-items: center !important;
    color: #b0bec5 !important;
    text-decoration: none !important;
    font-size: 11px !important;
    padding: 8px 4px !important;
    transition: all 0.3s ease !important;
    flex: 1 !important;
    text-align: center !important;
    position: relative !important;
    border-radius: 8px !important;
    min-height: 50px !important;
    width: auto !important;
    height: auto !important;
}

.nav-button span {
    position: absolute;
    bottom: 6px;
    left: 0;
    right: 0;
    text-align: center;
    color: #b0bec5;
    font-weight: 500;
    transition: color 0.3s ease;
}

.nav-button:hover span,
.nav-button.active span {
    color: #00bcd4;
}

.nav-button img {
    width: 22px;
    height: 22px;
    margin-bottom: 20px;
    transition: transform 0.3s ease;
    filter: brightness(0.8);
}

.nav-button:hover img,
.nav-button.active img {
    transform: scale(1.1);
    filter: brightness(1);
}

.nav-button.active {
    /* 移除淡藍色正方形背景效果 */
}

/* 聊天按鈕特殊樣式 */
.nav-button[href*="chat"] {
    position: relative;
    margin-top: 0;
    min-height: 50px;
}

.nav-button[href*="chat"] img {
    position: absolute;
    top: -8px;
    width: 36px;
    height: 36px;
    background: linear-gradient(135deg, #00bcd4 0%, #2196f3 100%);
    border-radius: 50%;
    padding: 6px;
    box-shadow: 0 4px 12px rgba(0,188,212,0.3);
    transition: transform 0.3s ease, box-shadow 0.3s ease;
    filter: brightness(1);
}

.nav-button[href*="chat"]:hover img {
    transform: scale(1.1);
    box-shadow: 0 6px 16px rgba(0,188,212,0.4);
}

.nav-button[href*="chat"] span {
    font-weight: 600;
    color: #ffffff;
}

.nav-button[href*="chat"]:hover span {
    color: #00bcd4;
}

.nav-button[href*="chat"].active span {
    color: #00bcd4;
}

@media (max-width: 500px) {
    .nav-buttons {
        max-width: 100vw;
        border-radius: 0;
        left: 0;
        right: 0;
        margin: 0;
        padding: 10px 8px;
        width: 100vw;
    }
    
    .nav-button {
        font-size: 10px;
        padding: 6px 2px;
        min-height: 48px;
    }
    
    .nav-button img {
        width: 20px;
        height: 20px;
        margin-bottom: 18px;
    }
    
    .nav-button[href*="chat"] img {
        width: 32px;
        height: 32px;
        top: -6px;
    }
}
</style>
`;

// 自動初始化導航列
document.addEventListener('DOMContentLoaded', () => {
    // 添加樣式
    if (!document.querySelector('#nav-styles')) {
        const styleElement = document.createElement('style');
        styleElement.id = 'nav-styles';
        styleElement.textContent = navStyles;
        document.head.appendChild(styleElement);
    }
    
    // 初始化導航列
    const nav = new NavigationBar();
    nav.init();
});

// 導出供其他腳本使用
window.NavigationBar = NavigationBar;
