document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const entryModal = document.getElementById('entry-modal');
    const authForm = document.getElementById('auth-form');
    const usernameInput = document.getElementById('username-input');
    const passwordInput = document.getElementById('password-input');
    const confirmPasswordContainer = document.getElementById('confirm-password-container');
    const confirmPasswordInput = document.getElementById('confirm-password-input');
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const tabGuest = document.getElementById('tab-guest');
    const passwordContainer = document.getElementById('password-container');
    const authError = document.getElementById('auth-error');
    const authSubmitBtn = document.getElementById('auth-submit-btn');

    let authMode = 'login'; // 'login' or 'register'
    const mainApp = document.getElementById('main-app');
    const chatForm = document.getElementById('chat-form');
    const messageInput = document.getElementById('message-input');
    const messagesContainer = document.getElementById('messages-container');

    const activeUsersList = document.getElementById('active-users-list');
    const activeCount = document.getElementById('active-count');
    const navCount = document.getElementById('nav-count');

    const currentDatetime = document.getElementById('current-datetime');
    const myAvatar = document.getElementById('my-avatar');

    // Admin DOM Elements
    const adminTrigger = document.getElementById('admin-trigger');
    const adminPanel = document.getElementById('admin-panel');
    const purgeBtn = document.getElementById('purge-btn');

    // Snow AI DOM Elements
    const openSnowBtn = document.getElementById('open-snow-btn');
    const closeSnowBtn = document.getElementById('close-snow-btn');
    const snowModal = document.getElementById('snow-modal');
    const snowContent = document.getElementById('snow-content');
    const currentWeather = document.getElementById('current-weather');

    // Audio for notification
    const popSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3');
    popSound.volume = 0.5;

    // State
    let socket = null;
    let myUsername = '';
    let mySessionId = '';
    let isWindowActive = true;
    let unreadCount = 0;
    let isAdmin = false;
    let isGuest = false;
    let myAvatarData = null; // base64 avatar

    // Hidden file input for avatar upload
    const avatarFileInput = document.createElement('input');
    avatarFileInput.type = 'file';
    avatarFileInput.accept = 'image/*';
    avatarFileInput.style.display = 'none';
    document.body.appendChild(avatarFileInput);

    // Click avatar to upload (registered users only)
    if (myAvatar) {
        myAvatar.addEventListener('click', () => {
            if (isGuest) {
                alert('Guest users cannot set a profile picture. Register an account first!');
                return;
            }
            if (!myUsername) return;
            avatarFileInput.click();
        });
        myAvatar.title = 'Click to set profile picture';
        myAvatar.style.cursor = 'pointer';
    }

    avatarFileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const base64 = await resizeAndCompress(file, 100, 0.7);
            const token = localStorage.getItem('chat_token');
            const res = await fetch('/api/avatar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ avatar: base64 })
            });
            const data = await res.json();
            if (res.ok) {
                myAvatarData = base64;
                myAvatar.innerHTML = `<img src="${base64}" class="w-full h-full rounded-full object-cover" />`;
            } else {
                alert(data.error || 'Failed to upload avatar');
            }
        } catch (err) {
            alert('Failed to process image');
        }
        avatarFileInput.value = '';
    });

    // Paste image from clipboard
    document.addEventListener('paste', async (e) => {
        if (isGuest || !myUsername) return;
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (!file) return;
                if (!confirm('Set this image as your profile picture?')) return;
                try {
                    const base64 = await resizeAndCompress(file, 100, 0.7);
                    const token = localStorage.getItem('chat_token');
                    const res = await fetch('/api/avatar', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                        body: JSON.stringify({ avatar: base64 })
                    });
                    const data = await res.json();
                    if (res.ok) {
                        myAvatarData = base64;
                        myAvatar.innerHTML = `<img src="${base64}" class="w-full h-full rounded-full object-cover" />`;
                    } else {
                        alert(data.error || 'Failed to upload avatar');
                    }
                } catch (err) {
                    alert('Failed to process image');
                }
                break;
            }
        }
    });

    function resizeAndCompress(file, maxSize, quality) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    let w = img.width, h = img.height;
                    if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
                    else { w = Math.round(w * maxSize / h); h = maxSize; }
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                };
                img.onerror = reject;
                img.src = e.target.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    // Setup Date/Time Header and Current Weather
    function updateTime() {
        const now = new Date();
        currentDatetime.textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) +
            ' ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    updateTime();
    setInterval(updateTime, 60000);

    // Dynamic MunnyCoin Ticker Hook
    let currentMunnTickerInfo = "";
    async function fetchMunnCoinTicker() {
        try {
            const res = await fetch('/api/munn-coin');
            const data = await res.json();

            const txtColor = parseFloat(data.change24h) >= 0 ? "text-emerald-400" : "text-red-400";
            const sign = parseFloat(data.change24h) >= 0 ? "+" : "";

            const liveTickerText = document.getElementById('live-ticker-text');
            if (liveTickerText) {
                // If it doesn't already have MUNN, attach it
                if (!liveTickerText.innerHTML.includes('id="munn-ticker-span"')) {
                    liveTickerText.innerHTML = `<span id="munn-ticker-span" class="font-bold"></span> *** ` + liveTickerText.innerHTML;
                }
                const mTicker = document.getElementById('munn-ticker-span');
                if (mTicker) {
                    mTicker.innerHTML = `$MUNN [ <span class="text-zinc-100">$${data.price}</span> | <span class="${txtColor}">${sign}${data.change24h}%</span> ]`;
                }
            }
        } catch (e) { }
    }
    fetchMunnCoinTicker();
    setInterval(fetchMunnCoinTicker, 8000);

    // Initial weather fetch widget for top Nav
    async function updateCurrentWeather() {
        try {
            if (!currentWeather) return;
            const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=43.0481&longitude=-76.1474&current_weather=true&temperature_unit=fahrenheit');
            const data = await res.json();
            currentWeather.textContent = `${Math.round(data.current_weather.temperature)}°F`;
        } catch (e) {
            console.error("Weather offline", e);
        }
    }
    updateCurrentWeather();

    // Track Window Focus
    window.addEventListener('focus', () => {
        isWindowActive = true;
        unreadCount = 0;
        updateTitle();
    });
    window.addEventListener('blur', () => {
        isWindowActive = false;
    });

    function updateTitle() {
        if (unreadCount > 0) {
            document.title = `(${unreadCount}) munn.fun - Chat`;
        } else {
            document.title = 'munn.fun - Chat';
        }
    }

    // Admin Actions
    if (adminTrigger) {
        adminTrigger.addEventListener('click', async () => {
            if (!isAdmin) {
                const pin = prompt("Enter Settings PIN:");
                if (pin) {
                    socket.emit('admin_auth', pin);
                    // Also verify via HTTP for dashboard access
                    try {
                        const res = await fetch('/api/admin/verify', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ pin })
                        });
                        const data = await res.json();
                        if (res.ok) {
                            sessionStorage.setItem('admin_token', data.adminToken);
                        }
                    } catch (e) { }
                }
            } else {
                if (confirm("Open Admin Dashboard?")) {
                    window.location.href = '/admin.html';
                }
            }
        });
    }

    if (purgeBtn) {
        purgeBtn.addEventListener('click', () => {
            if (isAdmin && confirm("Are you sure you want to purge all messages?")) {
                socket.emit('admin_purge_all');
            }
        });
    }

    // Snow Predictor Integration
    if (openSnowBtn) {
        openSnowBtn.addEventListener('click', async () => {
            snowModal.classList.remove('hidden');
            setTimeout(() => snowModal.classList.remove('opacity-0'), 10);

            // Re-render empty skeleton every time it opens
            snowContent.innerHTML = `
                <div class="flex flex-col items-center justify-center py-10 text-zinc-400 gap-4">
                    <div class="w-10 h-10 rounded-full border-t-2 border-l-2 border-sky-500 animate-spin"></div>
                    <p class="text-sm font-mono animate-pulse">Querying weather APIs & Gemini Kernel...</p>
                </div>
            `;

            try {
                const req = await fetch('/api/snow-prediction');
                const predictions = await req.json();

                if (predictions.error) {
                    snowContent.innerHTML = `<div class="text-red-400 p-4 border border-red-500/20 bg-red-500/10 rounded-lg text-sm text-center">${escapeHTML(predictions.error)}</div>`;
                    return;
                }

                // Render Calendar/Predictor grid
                let html = '<div class="space-y-4 pb-4">';
                predictions.forEach(p => {
                    const probClass = p.probability >= 50 ? 'text-sky-400 font-bold drop-shadow-[0_0_8px_rgba(56,189,248,0.8)]' : p.probability >= 25 ? 'text-zinc-200' : 'text-zinc-500';
                    const bgClass = p.probability >= 50 ? 'bg-sky-500/10 border-sky-500/40 shadow-lg' : 'bg-zinc-800/60 border-zinc-700/50';

                    html += `
                        <div class="p-4 ${bgClass} border rounded-lg transition-all hover:bg-zinc-800/80">
                            <div class="flex justify-between items-center mb-2">
                                <h3 class="font-bold text-zinc-100 uppercase tracking-widest text-sm">${escapeHTML(p.date)}</h3>
                                <div class="text-xl ${probClass}">${p.probability}% <span class="text-[10px] text-zinc-500 tracking-normal uppercase ml-1">Chance</span></div>
                            </div>
                            <div class="text-sm text-zinc-400 leading-relaxed">${escapeHTML(p.reason)}</div>
                            <div class="w-full bg-zinc-900 rounded-full h-1.5 mt-4 overflow-hidden border border-zinc-900">
                                <div class="${p.probability >= 50 ? 'bg-sky-400' : 'bg-zinc-600'} h-1.5 rounded-full" style="width: ${p.probability}%"></div>
                            </div>
                        </div>
                    `;
                });
                html += '</div>';

                snowContent.innerHTML = html;

            } catch (e) {
                snowContent.innerHTML = `<div class="text-red-400 p-4 text-center text-sm border border-red-500/20 bg-red-400/10 rounded-lg">Failed to establish datalink with Syracuse API endpoints.</div>`;
            }
        });
    }

    if (closeSnowBtn) {
        closeSnowBtn.addEventListener('click', () => {
            snowModal.classList.add('opacity-0');
            setTimeout(() => snowModal.classList.add('hidden'), 300);
        });
    }

    // Auth Tabs Logic
    const tabs = { 'login': tabLogin, 'register': tabRegister, 'guest': tabGuest };
    function switchTab(mode) {
        authMode = mode;
        Object.keys(tabs).forEach(m => {
            if (m === mode) {
                tabs[m].classList.replace('border-transparent', 'border-indigo-500');
                tabs[m].classList.replace('text-zinc-500', 'text-indigo-400');
            } else {
                tabs[m].classList.replace('border-indigo-500', 'border-transparent');
                tabs[m].classList.replace('text-indigo-400', 'text-zinc-500');
            }
        });

        authError.classList.add('hidden');
        if (mode === 'guest') {
            confirmPasswordContainer.classList.add('hidden');
            passwordContainer.classList.add('hidden');
            passwordInput.removeAttribute('required');
            usernameInput.placeholder = "Guest Name";
            authSubmitBtn.textContent = 'Enter as Guest';
        } else {
            passwordContainer.classList.remove('hidden');
            passwordInput.setAttribute('required', 'true');
            usernameInput.placeholder = "Alias / Callsign";

            if (mode === 'register') {
                confirmPasswordContainer.classList.remove('hidden');
                authSubmitBtn.textContent = 'Register Account';
            } else {
                confirmPasswordContainer.classList.add('hidden');
                authSubmitBtn.textContent = 'Authenticate';
            }
        }
    }

    tabLogin.addEventListener('click', (e) => { e.preventDefault(); switchTab('login'); });
    tabRegister.addEventListener('click', (e) => { e.preventDefault(); switchTab('register'); });
    tabGuest.addEventListener('click', (e) => { e.preventDefault(); switchTab('guest'); });

    // Handle Auth Submit
    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = usernameInput.value.trim();
        const password = passwordInput.value;
        const confirmPassword = confirmPasswordInput.value;

        if (!username || (authMode !== 'guest' && !password)) return;
        if (authMode === 'register' && password !== confirmPassword) {
            return showAuthError("Passwords do not match");
        }

        try {
            const res = await fetch(`/api/${authMode}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(authMode === 'guest' ? { username } : { username, password })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Authentication failed');

            if (authMode === 'register') {
                switchTab('login');
                passwordInput.value = '';
                return showAuthError("Registration successful. Please login.", true);
            }

            myUsername = data.user.username;
            isAdmin = data.user.role === 'mod';
            localStorage.setItem('chat_token', data.token);
            connectSocket(data.token);
        } catch (err) {
            showAuthError(err.message);
        }
    });

    function showAuthError(msg, isSuccess = false) {
        authError.textContent = msg;
        authError.classList.remove('hidden', 'bg-red-500/10', 'border-red-500/20', 'text-red-500', 'bg-emerald-500/10', 'border-emerald-500/20', 'text-emerald-500');
        if (isSuccess) {
            authError.classList.add('bg-emerald-500/10', 'border-emerald-500/20', 'text-emerald-500');
        } else {
            authError.classList.add('bg-red-500/10', 'border-red-500/20', 'text-red-500');
        }
    }

    async function fetchPreviousUsersStatus() {
        try {
            const res = await fetch('/api/users/status');
            const data = await res.json();
            if (!res.ok) return;

            // Render on the login UI
            let listHtml = '<div class="mt-6 border-t border-zinc-800 pt-4"><h3 class="text-xs uppercase tracking-widest text-zinc-500 font-bold mb-3 text-center">Recent Activity</h3><div class="space-y-2 max-h-40 overflow-y-auto chat-scroll pr-1">';
            data.forEach(u => {
                let relTime = "";
                let statusDot = "";

                if (u.isActive) {
                    relTime = "Active now";
                    statusDot = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse mr-2"></span>`;
                } else {
                    const date = new Date(u.last_login);
                    const today = new Date();
                    const diffTime = Math.abs(today - date);
                    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
                    const diffHours = Math.floor(diffTime / (1000 * 60 * 60));

                    if (diffDays > 0) relTime = `logged in ${diffDays} days ago`;
                    else if (diffHours > 0) relTime = `logged in ${diffHours} hours ago`;
                    else {
                        const diffMins = Math.floor(diffTime / (1000 * 60));
                        relTime = diffMins < 2 ? 'just logged off' : `logged in ${diffMins} mins ago`;
                    }
                    statusDot = `<span class="w-2 h-2 rounded-full bg-zinc-600 mr-2"></span>`;
                }

                listHtml += `
                    <div class="flex justify-between items-center bg-zinc-900/40 p-2 rounded text-sm px-3 border border-zinc-800/50">
                        <div class="flex items-center">
                            ${statusDot}
                            <span class="font-bold text-zinc-300">${escapeHTML(u.username)}</span>
                        </div>
                        <span class="text-[11px] ${u.isActive ? 'text-emerald-400 font-bold' : 'text-zinc-500'} font-mono">${relTime}</span>
                    </div>
                `;
            });
            listHtml += '</div></div>';

            // Append to auth modal form securely
            const form = document.getElementById('auth-form');
            const existingList = document.getElementById('recent-activity-list');
            if (existingList) existingList.remove();

            const div = document.createElement('div');
            div.id = 'recent-activity-list';
            div.innerHTML = listHtml;
            form.parentNode.appendChild(div);

        } catch (e) { console.error(e); }
    }

    function connectSocket(token) {
        myAvatar.textContent = myUsername.substring(0, 2).toUpperCase();

        // Parse guest status from token
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            isGuest = !!payload.isGuest;
        } catch (e) { }

        // Load existing avatar for avatar bubble
        if (!isGuest) {
            fetch(`/api/avatar/${myUsername}`).then(r => r.json()).then(data => {
                if (data.avatar) {
                    myAvatarData = data.avatar;
                    myAvatar.innerHTML = `<img src="${data.avatar}" class="w-full h-full rounded-full object-cover" />`;
                }
            }).catch(() => { });
        }

        if (!socket) {
            socket = io({
                auth: { token }
            });

            socket.on('connect', () => {
                mySessionId = socket.id;
                socket.emit('join_chat'); // Handled securely via token now!

                // Make sure we have the username
                if (!myUsername) {
                    // Quick ping to check my user role and username
                    // Server parses from token! We can parse it here.
                    try {
                        const payload = JSON.parse(atob(token.split('.')[1]));
                        myUsername = payload.username;
                        isAdmin = payload.role === 'mod';
                        myAvatar.textContent = myUsername.substring(0, 2).toUpperCase();
                    } catch (e) { }
                }

                entryModal.classList.add('opacity-0');
                setTimeout(() => {
                    entryModal.classList.add('hidden');
                    entryModal.classList.remove('flex');
                    mainApp.classList.remove('hidden');
                    if (isAdmin && adminPanel) adminPanel.classList.remove('hidden');
                    setTimeout(() => {
                        mainApp.classList.remove('opacity-0');
                        messageInput.focus();
                    }, 10);
                }, 300);
            });

            socket.on('connect_error', (err) => {
                showAuthError("Session expired or invalid login. " + err.message);
                socket.disconnect();
                socket = null;
                localStorage.removeItem('chat_token');

                // Show modal since auto-login failed
                entryModal.classList.remove('hidden', 'opacity-0');
                entryModal.classList.add('flex');

                fetchPreviousUsersStatus();
            });

            setupSocketListeners();
        }
    }

    // Chat Form Submit (Global Inbox)
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = messageInput.value.trim();
        if (text && socket) {
            socket.emit('chat_message', { text });
            socket.emit('stop_typing');
            messageInput.value = '';
            messageInput.style.height = 'auto';
            if (charCount) charCount.textContent = '';
            messageInput.focus();
        }
    });

    // Auto-grow textarea + Enter/Shift+Enter handling
    const charCount = document.getElementById('char-count');
    if (messageInput) {
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                chatForm.dispatchEvent(new Event('submit'));
            }
        });

        messageInput.addEventListener('input', () => {
            // Auto-grow
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
            if (messageInput.scrollHeight > 120) {
                messageInput.style.overflowY = 'auto';
            } else {
                messageInput.style.overflowY = 'hidden';
            }
            // Character count
            const len = messageInput.value.length;
            if (charCount) {
                charCount.textContent = len > 0 ? `${len}` : '';
            }
            // Typing indicator
            if (socket && messageInput.value.trim().length > 0) {
                socket.emit('typing');
            } else if (socket) {
                socket.emit('stop_typing');
            }
        });
    }

    // Setup Socket Listeners
    function setupSocketListeners() {
        if (!socket) return;

        // Prevent duplicate listeners
        socket.off('chat_history');
        socket.off('chat_message');
        socket.off('system_message');
        socket.off('admin_announcement');
        socket.off('update_roster');
        socket.off('admin_auth_success');
        socket.off('admin_auth_fail');
        socket.off('delete_message');
        socket.off('purge_all_messages');
        socket.off('kicked_out');
        socket.off('message_voted');
        socket.off('reputation_update');

        // Reputation logic
        socket.on('message_voted', (data) => {
            const el = document.getElementById(`score-${data.msgId}`);
            if (el) {
                el.textContent = `REP: ${data.score}`;
                el.className = `text-[10px] whitespace-nowrap font-bold ${data.score > 0 ? 'text-emerald-500' : data.score < 0 ? 'text-red-500' : 'text-zinc-500'}`;
            }
        });

        const liveTickerText = document.getElementById('live-ticker-text');
        socket.on('reputation_update', (data) => {
            if (liveTickerText) {
                const updateStr = `[ REPUTATION UPDATE ] *** [ USER: ${data.username.toUpperCase()} ] *** [ NEW SCORE: ${data.reputation} ] *** `;
                liveTickerText.textContent = updateStr + liveTickerText.textContent;
            }
        });

        // Handle chat history
        socket.on('chat_history', (history) => {
            history.forEach(msg => {
                if (msg.type === 'chat') {
                    const isMe = msg.data.id === mySessionId;
                    renderMessage(msg.data, isMe);
                } else if (msg.type === 'admin_announcement') {
                    renderAdminAnnouncement(msg.data.text);
                }
            });
            scrollToBottom();
        });

        // Handle incoming chat messages
        socket.on('chat_message', (msg) => {
            const isMe = msg.id === mySessionId;
            renderMessage(msg, isMe);
            scrollToBottom();

            if (!isMe) {
                if (!isWindowActive) {
                    unreadCount++;
                    updateTitle();
                }
                popSound.play().catch(e => console.log("Audio play prevented", e));
            }
        });

        // Handle system messages
        socket.on('system_message', (msg) => {
            appendSystemMessage(msg.text);
        });

        // Handle Admin Announcement
        socket.on('admin_announcement', (msg) => {
            renderAdminAnnouncement(msg.text);
        });

        // Update active user list
        socket.on('update_roster', (users) => {
            updateActiveUsers(users);
        });

        // Admin Auth & Events
        socket.on('admin_auth_success', () => {
            isAdmin = true;
            if (adminPanel) adminPanel.classList.remove('hidden');
            alert("Admin privileges granted. (New UI tools will appear on new messages)");
        });

        socket.on('admin_auth_fail', () => {
            alert("Incorrect PIN.");
        });

        socket.on('delete_message', (msgId) => {
            const el = document.getElementById(`msg-${msgId}`);
            if (el) el.remove();
        });

        socket.on('purge_all_messages', () => {
            messagesContainer.innerHTML = '';
        });

        socket.on('kicked_out', () => {
            alert("You have been kicked by an administrator.");
            window.location.reload();
        });

        // Typing indicator
        const typingIndicator = document.getElementById('typing-indicator');
        const typingText = document.getElementById('typing-text');
        const typingUsers = new Set();
        let typingTimeout = null;

        socket.on('user_typing', (data) => {
            if (data.username === myUsername) return;
            typingUsers.add(data.username);
            updateTypingUI();
        });

        socket.on('user_stop_typing', (data) => {
            typingUsers.delete(data.username);
            updateTypingUI();
        });

        function updateTypingUI() {
            if (!typingIndicator || !typingText) return;
            if (typingUsers.size === 0) {
                typingIndicator.classList.add('hidden');
            } else {
                typingIndicator.classList.remove('hidden');
                const names = Array.from(typingUsers);
                if (names.length === 1) {
                    typingText.textContent = `${names[0]} is typing...`;
                } else if (names.length === 2) {
                    typingText.textContent = `${names[0]} and ${names[1]} are typing...`;
                } else {
                    typingText.textContent = `${names.length} people are typing...`;
                }
            }
        }
    }

    // Global UI Helpers
    function renderMessage(msg, isMe) {
        const timeString = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const initial = msg.isBot ? '✨' : msg.username.substring(0, 2).toUpperCase();

        const msgWrapper = document.createElement('div');
        msgWrapper.id = `msg-${msg.msgId}`;
        msgWrapper.className = `group flex gap-3 w-full msg-enter ${isMe ? 'flex-row-reverse text-right' : ''}`;

        // Determine Name Colors based on roles
        let nameColorStr = 'text-zinc-300';
        let badgeHTML = '';
        if (msg.isAdmin) {
            nameColorStr = 'text-yellow-500';
            badgeHTML = `<svg class="w-3.5 h-3.5 text-yellow-500 drop-shadow-[0_0_8px_rgba(234,179,8,0.8)]" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"></path></svg>`;
        } else if (msg.isBot) {
            nameColorStr = 'text-indigo-400';
        } else if (msg.isVerified) {
            badgeHTML = `<svg class="w-3.5 h-3.5 text-sky-500" viewBox="0 0 22 22" fill="currentColor"><path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.855-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.607-.274 1.264-.144 1.897.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681.132-.637.075-1.299-.165-1.903.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"/></svg>`;
        }

        const avatarContent = msg.avatar
            ? `<img src="${msg.avatar}" class="w-full h-full rounded-full object-cover" />`
            : (msg.isBot ? `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C12 7.5 16.5 12 22 12C16.5 12 12 16.5 12 22C12 16.5 7.5 12 2 12C7.5 12 12 7.5 12 2Z"/></svg>` : initial);

        const innerHTML = `
                <div class="w-8 h-8 shrink-0 rounded-full font-bold flex items-center justify-center text-xs shadow-md border border-white/5 ${isMe ? 'bg-indigo-600 text-white' : msg.isAdmin ? 'bg-yellow-500 text-zinc-900 border-yellow-400 shadow-[0_0_15px_rgba(234,179,8,0.4)]' : msg.isBot ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30 text-base' : 'bg-zinc-800 text-zinc-300'} mt-0.5 relative overflow-hidden">
                    ${avatarContent}
                </div>
                <div class="flex-1 min-w-0 flex flex-col ${isMe ? 'items-end' : 'items-start'}">
                    <div class="flex items-center gap-1.5 mb-0.5 ${isMe ? 'flex-row-reverse' : ''}">
                        <span class="font-semibold text-[12px] tracking-wide uppercase ${nameColorStr} flex items-center gap-1">
                            ${escapeHTML(msg.username)} 
                            ${badgeHTML}
                        </span>
                        <span class="text-[10px] font-mono text-zinc-600">${timeString}</span>
                        ${msg.score !== undefined && !msg.isBot ? `<span id="score-${msg.msgId}" class="text-[9px] whitespace-nowrap font-bold ${msg.score > 0 ? 'text-emerald-500' : msg.score < 0 ? 'text-red-500' : 'text-zinc-600'}">REP: ${msg.score}</span>` : ''}
                    </div>
                    <div class="inline-block text-[13.5px] leading-snug text-left whitespace-pre-wrap rounded-2xl ${isMe ? 'bg-indigo-600 px-3.5 py-2 text-white rounded-tr-sm shadow-sm' : msg.isAdmin ? 'bg-zinc-800/90 px-3.5 py-2 text-zinc-100 rounded-tl-sm shadow-sm border-l-2 border-yellow-500' : msg.isBot ? 'bg-indigo-500/5 px-3.5 py-2.5 border border-indigo-500/20 text-indigo-100 rounded-tl-sm shadow-sm max-w-[90%]' : 'bg-zinc-800/70 border border-zinc-700/40 px-3.5 py-2 text-zinc-100 rounded-tl-sm shadow-sm'} font-normal" style="max-width: min(85%, 520px); word-break: break-word;">
                        ${escapeHTML(msg.text)}
                    </div>
                    
                    <div class="mt-0.5 flex gap-1.5 items-center h-5 opacity-0 group-hover:opacity-100 transition-opacity ${isMe ? 'flex-row-reverse mr-1' : 'ml-1'}">
                        ${!isMe && !msg.isBot ? `
                        <button onclick="voteMessage('${msg.msgId}', 1)" class="text-[10px] uppercase tracking-wider font-bold text-emerald-500/70 hover:text-emerald-400 hover:bg-emerald-500/10 px-1.5 py-0.5 rounded transition-colors flex items-center gap-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"></path></svg>UP</button>
                        <button onclick="voteMessage('${msg.msgId}', -1)" class="text-[10px] uppercase tracking-wider font-bold text-red-500/70 hover:text-red-400 hover:bg-red-500/10 px-1.5 py-0.5 rounded transition-colors flex items-center gap-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>DN</button>
                        ` : ''}
                        ${isAdmin ? `<button onclick="deleteMessage('${msg.msgId}')" class="text-[10px] uppercase tracking-wider font-bold text-red-500/70 hover:text-red-400 hover:bg-red-500/10 px-1.5 py-0.5 rounded transition-colors">DEL</button>` : ''}
                    </div>
                </div>
            `;

        msgWrapper.innerHTML = innerHTML;
        messagesContainer.appendChild(msgWrapper);
    }

    window.voteMessage = function (msgId, voteType) {
        if (socket) socket.emit('vote_message', { msgId, voteType });
    }

    window.deleteMessage = function (msgId) {
        if (socket && confirm("DESTRUCT: Remove this node permanently?")) {
            socket.emit('admin_delete_msg', msgId);
        }
    }

    window.kickUser = function (targetId) {
        if (socket && confirm("TERMINATE: Disconnect user from network?")) {
            socket.emit('admin_kick_user', targetId);
        }
    }

    function appendSystemMessage(text) {
        const msgWrapper = document.createElement('div');
        msgWrapper.className = 'flex justify-center my-3';
        msgWrapper.innerHTML = `
                <div class="text-zinc-500 text-[11px] font-mono uppercase tracking-wider border-y border-zinc-800/50 py-1.5 px-6 w-full text-center">
                    // SYS: ${escapeHTML(text)}
                </div>
            `;
        messagesContainer.appendChild(msgWrapper);
        scrollToBottom();
    }

    function renderAdminAnnouncement(text) {
        const msgWrapper = document.createElement('div');
        msgWrapper.className = 'flex justify-center my-6';
        msgWrapper.innerHTML = `
                <div class="bg-gradient-to-r from-yellow-100 via-yellow-50 to-yellow-100 text-yellow-800 border-2 border-yellow-300 font-bold uppercase tracking-widest py-3 px-8 rounded-full shadow-lg transform scale-105 animate-pulse text-center w-3/4">
                    ${escapeHTML(text)}
                </div>
            `;
        messagesContainer.appendChild(msgWrapper);
        scrollToBottom();
    }

    function updateActiveUsers(users) {
        if (activeCount) activeCount.textContent = users.length;
        if (navCount) navCount.textContent = users.length;

        activeUsersList.innerHTML = '';
        users.forEach(user => {
            const isMe = user.id === mySessionId;
            const li = document.createElement('li');
            li.className = 'flex items-center justify-center md:justify-between px-3 md:px-5 py-2 md:py-3 hover:bg-zinc-800/50 transition-colors cursor-pointer group flex-shrink-0 min-w-[72px] md:min-w-0 md:w-full ' + (isMe ? 'bg-zinc-800/50' : '');

            const initial = user.isBot ? '✨' : user.username.substring(0, 2).toUpperCase();
            const statusText = user.isBot ? 'Listening - AI Kernel' : 'Established - Online';

            let nameColorStr = 'text-zinc-200';
            let badgeHTML = '';
            let avatarClass = 'bg-zinc-800 border border-zinc-700 text-zinc-300';
            if (user.isAdmin) {
                nameColorStr = 'text-yellow-500';
                badgeHTML = `<svg class="w-4 h-4 text-yellow-500 drop-shadow-[0_0_8px_rgba(234,179,8,0.8)]" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"></path></svg>`;
                avatarClass = 'bg-yellow-500 text-zinc-900 border-2 border-yellow-400 shadow-[0_0_15px_rgba(234,179,8,0.4)]';
            } else if (user.isBot) {
                nameColorStr = 'text-indigo-400';
                avatarClass = 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/30';
            } else if (user.isVerified) {
                badgeHTML = `<svg class="w-4 h-4 text-sky-500" viewBox="0 0 22 22" fill="currentColor"><path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.855-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.607-.274 1.264-.144 1.897.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681.132-.637.075-1.299-.165-1.903.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z"/></svg>`;
            } else if (isMe) {
                avatarClass = 'bg-indigo-600 text-white border-2 border-indigo-500';
            }

            li.innerHTML = `
                    <div class="flex flex-col md:flex-row items-center gap-1.5 md:gap-3 w-full">
                        <div class="relative shrink-0 flex items-center justify-center">
                            <div class="w-12 h-12 md:w-10 md:h-10 rounded-full ${avatarClass} flex items-center justify-center font-bold text-sm shadow-md overflow-hidden">
                                ${user.avatar ? `<img src="${user.avatar}" class="w-full h-full object-cover" />` : (user.isBot ? `<svg class="w-6 h-6 text-indigo-500" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C12 7.5 16.5 12 22 12C16.5 12 12 16.5 12 22C12 16.5 7.5 12 2 12C7.5 12 12 7.5 12 2Z"/></svg>` : initial)}
                            </div>
                            <div class="absolute bottom-0 right-0 md:bottom-0 md:right-0 w-3 h-3 md:w-3 md:h-3 ${user.isBot ? 'bg-indigo-500' : 'bg-emerald-500'} border-2 border-[#18181b] rounded-full"></div>
                        </div>
                        <div class="flex flex-col items-center md:items-start w-full overflow-hidden">
                            <span class="text-[10px] md:text-[14px] font-bold uppercase tracking-wide truncate w-full text-center md:text-left ${nameColorStr} group-hover:text-indigo-400 transition-colors flex items-center justify-center md:justify-start gap-1">
                                ${escapeHTML(user.username.split(' ')[0])} 
                                <span class="hidden md:inline-flex">${badgeHTML}</span>
                            </span>
                            <span class="hidden md:block text-[11px] font-mono text-zinc-500 truncate w-full text-left">${statusText}</span>
                        </div>
                    </div>
                    ${!isMe && !user.isBot ? `
                    <div class="hidden md:flex items-center shrink-0">
                        ${isAdmin ? `<button class="opacity-0 group-hover:opacity-100 bg-red-500/10 border border-red-500/20 px-3 py-1 rounded shadow-sm text-[11px] font-bold uppercase tracking-wider text-red-500 hover:bg-red-500/20 transition-all kick-user-btn">Drop</button>` : ''}
                    </div>
                    ` : ''}
                `;

            if (user.isBot) {
                // Clicking AI writes @gemini
                li.addEventListener('click', () => {
                    const input = document.getElementById('message-input');
                    input.value = `@gemini ` + input.value;
                    input.focus();
                });
            } else if (!isMe) {
                if (isAdmin) {
                    li.querySelector('.kick-user-btn').addEventListener('click', (e) => {
                        e.stopPropagation();
                        kickUser(user.id);
                    });
                }
            }

            activeUsersList.appendChild(li);
        });
    }

    function scrollToBottom() {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g, tag => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[tag] || tag));
    }

    // Auto-Login Check
    const savedToken = localStorage.getItem('chat_token');
    if (savedToken) {
        // Assume valid for a moment, hide modal visually to prevent flicker
        entryModal.classList.add('opacity-0', 'hidden');
        entryModal.classList.remove('flex');
        connectSocket(savedToken);
    } else {
        // No token, ensure we fetch previous statuses
        fetchPreviousUsersStatus();
    }
});
