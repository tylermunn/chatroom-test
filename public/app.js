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

    // Setup Date/Time Header and Current Weather
    function updateTime() {
        const now = new Date();
        currentDatetime.textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) +
            ' ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    updateTime();
    setInterval(updateTime, 60000);

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
            document.title = `(${unreadCount}) Relay_Net`;
        } else {
            document.title = 'Secure Relay - Global Connect';
        }
    }

    // Admin Actions
    if (adminTrigger) {
        adminTrigger.addEventListener('click', () => {
            if (!isAdmin) {
                const pin = prompt("Enter Settings PIN:");
                if (pin) {
                    socket.emit('admin_auth', pin);
                }
            } else {
                alert("Already authenticated as Admin.");
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

    // Auth Tabs
    tabLogin.addEventListener('click', (e) => {
        e.preventDefault();
        authMode = 'login';
        tabLogin.classList.replace('border-transparent', 'border-indigo-500');
        tabLogin.classList.replace('text-zinc-500', 'text-indigo-400');
        tabRegister.classList.replace('border-indigo-500', 'border-transparent');
        tabRegister.classList.replace('text-indigo-400', 'text-zinc-500');
        confirmPasswordContainer.classList.add('hidden');
        authSubmitBtn.textContent = 'Authenticate';
        authError.classList.add('hidden');
    });

    tabRegister.addEventListener('click', (e) => {
        e.preventDefault();
        authMode = 'register';
        tabRegister.classList.replace('border-transparent', 'border-indigo-500');
        tabRegister.classList.replace('text-zinc-500', 'text-indigo-400');
        tabLogin.classList.replace('border-indigo-500', 'border-transparent');
        tabLogin.classList.replace('text-indigo-400', 'text-zinc-500');
        confirmPasswordContainer.classList.remove('hidden');
        authSubmitBtn.textContent = 'Register Account';
        authError.classList.add('hidden');
    });

    // Handle Auth Submit
    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = usernameInput.value.trim();
        const password = passwordInput.value;
        const confirmPassword = confirmPasswordInput.value;

        if (!username || !password) return;

        if (authMode === 'register') {
            if (password !== confirmPassword) {
                showAuthError("Passwords do not match");
                return;
            }
            try {
                const res = await fetch('/api/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Registration failed');

                // Switch to login gently
                authMode = 'login';
                tabLogin.click();
                passwordInput.value = '';
                showAuthError("Registration successful. Please login.", true);
            } catch (err) {
                showAuthError(err.message);
            }
        } else {
            // Login
            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Login failed');

                myUsername = data.user.username;
                isAdmin = data.user.role === 'mod';
                localStorage.setItem('chat_token', data.token);

                connectSocket(data.token);

            } catch (err) {
                showAuthError(err.message);
            }
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

    function connectSocket(token) {
        myAvatar.textContent = myUsername.substring(0, 2).toUpperCase();

        if (!socket) {
            socket = io({
                auth: { token }
            });

            socket.on('connect', () => {
                mySessionId = socket.id;
                socket.emit('join_chat'); // Handled securely via token now!

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
                showAuthError(err.message);
                socket.disconnect();
                socket = null;
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
            messageInput.value = '';
            messageInput.focus();
        }
    });

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
    }

    // Global UI Helpers
    function renderMessage(msg, isMe) {
        const timeString = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const initial = msg.isBot ? '✨' : msg.username.substring(0, 2).toUpperCase();

        const msgWrapper = document.createElement('div');
        msgWrapper.id = `msg-${msg.msgId}`;
        msgWrapper.className = `group flex gap-4 w-full ${isMe ? 'flex-row-reverse text-right' : ''}`;

        // Determine Name Colors based on roles
        let nameColorStr = 'text-zinc-300';
        let badgeHTML = '';
        if (msg.isAdmin) {
            nameColorStr = 'text-yellow-500';
            badgeHTML = `<svg class="w-4 h-4 text-yellow-500 drop-shadow-[0_0_8px_rgba(234,179,8,0.8)]" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"></path></svg>`;
        } else if (msg.isBot) {
            nameColorStr = 'text-indigo-400';
        }

        const innerHTML = `
                <div class="w-10 h-10 shrink-0 rounded-full font-bold flex items-center justify-center text-sm shadow-md border border-white/5 ${isMe ? 'bg-indigo-600 text-white' : msg.isAdmin ? 'bg-yellow-500 text-zinc-900 border-yellow-400 shadow-[0_0_15px_rgba(234,179,8,0.4)]' : msg.isBot ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30 text-lg' : 'bg-zinc-800 text-zinc-300'} mt-1 relative">
                    ${msg.isBot ? `<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C12 7.5 16.5 12 22 12C16.5 12 12 16.5 12 22C12 16.5 7.5 12 2 12C7.5 12 12 7.5 12 2Z"/></svg>` : initial}
                </div>
                <div class="flex-1 min-w-0 flex flex-col ${isMe ? 'items-end' : 'items-start'}">
                    <div class="flex items-baseline gap-2 mb-1.5 ${isMe ? 'flex-row-reverse' : ''}">
                        <span class="font-bold text-[14px] tracking-wide uppercase ${nameColorStr} flex items-center gap-1.5">
                            ${escapeHTML(msg.username)} 
                            ${badgeHTML}
                        </span>
                        <span class="text-[11px] font-mono text-zinc-600">${timeString}</span>
                        ${msg.score !== undefined && !msg.isBot ? `<span id="score-${msg.msgId}" class="text-[10px] whitespace-nowrap font-bold ${msg.score > 0 ? 'text-emerald-500' : msg.score < 0 ? 'text-red-500' : 'text-zinc-500'}">REP: ${msg.score}</span>` : ''}
                    </div>
                    <div class="text-[14.5px] leading-relaxed max-w-[85%] text-left whitespace-pre-wrap rounded-2xl ${isMe ? 'bg-indigo-600 px-4 py-2.5 text-white rounded-tr-sm shadow-md' : msg.isAdmin ? 'bg-zinc-800/90 px-4 py-2.5 text-zinc-100 rounded-tl-sm shadow-md border-l-4 border-yellow-500' : msg.isBot ? 'bg-indigo-500/5 px-4 py-3 border border-indigo-500/20 text-indigo-100 rounded-tl-sm shadow-lg' : 'bg-zinc-800/80 border border-zinc-700/50 px-4 py-2.5 text-zinc-100 rounded-tl-sm shadow-md'} font-medium">
                        ${escapeHTML(msg.text)}
                    </div>
                    
                    <div class="mt-1 flex gap-2 items-center h-6 opacity-0 group-hover:opacity-100 transition-opacity ${isMe ? 'flex-row-reverse mr-1' : 'ml-1'}">
                        ${!isMe && !msg.isBot ? `
                        <button onclick="voteMessage('${msg.msgId}', 1)" class="text-[11px] uppercase tracking-wider font-bold text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10 px-2 py-0.5 border border-transparent hover:border-emerald-500/20 rounded transition-colors flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"></path></svg> UP</button>
                        <button onclick="voteMessage('${msg.msgId}', -1)" class="text-[11px] uppercase tracking-wider font-bold text-red-500 hover:text-red-400 hover:bg-red-500/10 px-2 py-0.5 border border-transparent hover:border-red-500/20 rounded transition-colors flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg> DOWN</button>
                        ` : ''}
                        ${isAdmin ? `<button onclick="deleteMessage('${msg.msgId}')" class="text-[11px] uppercase tracking-wider font-bold text-red-500 hover:text-red-400 hover:bg-red-500/10 px-2 py-0.5 border border-transparent hover:border-red-500/20 rounded transition-colors">Terminate</button>` : ''}
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
            } else if (isMe) {
                avatarClass = 'bg-indigo-600 text-white border-2 border-indigo-500';
            }

            li.innerHTML = `
                    <div class="flex flex-col md:flex-row items-center gap-1.5 md:gap-3 w-full">
                        <div class="relative shrink-0 flex items-center justify-center">
                            <div class="w-12 h-12 md:w-10 md:h-10 rounded-full ${avatarClass} flex items-center justify-center font-bold text-sm shadow-md">
                                ${user.isBot ? `<svg class="w-6 h-6 text-indigo-500" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C12 7.5 16.5 12 22 12C16.5 12 12 16.5 12 22C12 16.5 7.5 12 2 12C7.5 12 12 7.5 12 2Z"/></svg>` : initial}
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
});
