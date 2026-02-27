document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const entryModal = document.getElementById('entry-modal');
    const joinForm = document.getElementById('join-form');
    const usernameInput = document.getElementById('username-input');

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

    const dmContainer = document.getElementById('dm-container');

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

    // Track open DMs: targetId -> DOM Element
    const openDMs = new Map();

    // Setup Date/Time Header
    function updateTime() {
        const now = new Date();
        currentDatetime.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) +
            ' ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    updateTime();
    setInterval(updateTime, 60000);

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
            document.title = `(${unreadCount}) Mail - Outlook`;
            document.getElementById('unread-badge').classList.remove('hidden');
        } else {
            document.title = 'Mail - Outlook';
            document.getElementById('unread-badge').classList.add('hidden');
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

    // Join Chat Event
    joinForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const username = usernameInput.value.trim();
        if (username) {
            myUsername = username;

            // Set Avatar Initials
            myAvatar.textContent = username.substring(0, 2).toUpperCase();

            // Initialize Socket Connection
            socket = io();

            socket.on('connect', () => {
                mySessionId = socket.id;
                socket.emit('join_chat', myUsername);

                // Hide modal, show app
                entryModal.classList.add('opacity-0');
                setTimeout(() => {
                    entryModal.classList.add('hidden');
                    entryModal.classList.remove('flex');
                    mainApp.classList.remove('hidden');
                    setTimeout(() => {
                        mainApp.classList.remove('opacity-0');
                        messageInput.focus();
                    }, 10);
                }, 300);
            });

            setupSocketListeners();
        }
    });

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
        // Handle chat history
        socket.on('chat_history', (history) => {
            history.forEach(msg => {
                if (msg.type === 'chat') {
                    const isMe = msg.data.id === mySessionId;
                    renderMessage(msg.data, isMe);
                } else if (msg.type === 'system') {
                    appendSystemMessage(msg.data.text);
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

        // Update active user list
        socket.on('update_roster', (users) => {
            updateActiveUsers(users);
        });

        // Handle Reactions
        socket.on('message_reaction', (data) => {
            const { msgId, reaction, username } = data;
            const reactContainer = document.getElementById(`reactions-${msgId}`);
            if (reactContainer) {
                // simple visual update, just append or increment
                let exists = reactContainer.querySelector(`[data-emoji="${reaction}"]`);
                if (exists) {
                    let countSpan = exists.querySelector('.count');
                    countSpan.textContent = parseInt(countSpan.textContent) + 1;
                } else {
                    reactContainer.innerHTML += `<span class="inline-flex items-center gap-1 bg-[#edebe9] text-xs px-1.5 py-0.5 rounded cursor-help" data-emoji="${reaction}" title="${username} reacted">
                        ${reaction} <span class="count text-[#605e5c]">1</span>
                    </span>`;
                }
            }
        });

        // Handle Private Messages
        socket.on('private_message', (msg) => {
            const companionId = msg.isEcho ? msg.targetId : msg.senderId;
            const companionName = msg.isEcho ? "To: User" : msg.senderName; // simplified 

            openDMWindow(companionId, companionName);
            appendDM(companionId, msg);

            if (!msg.isEcho && !isWindowActive) {
                popSound.play().catch(e => { });
                unreadCount++;
                updateTitle();
            }
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

    // Open DM Window
    function openDMWindow(targetId, targetName) {
        if (openDMs.has(targetId)) return; // already open

        const dmHTML = document.createElement('div');
        dmHTML.className = 'dm-window w-[280px] h-[350px] bg-white flex flex-col rounded-t-lg overflow-hidden pointer-events-auto shadow-xl';
        dmHTML.innerHTML = `
            <div class="outlook-blue text-white px-3 py-2 flex justify-between items-center shrink-0 cursor-pointer">
                <span class="font-medium text-sm truncate pr-2 w-48">${escapeHTML(targetName)}</span>
                <button class="hover:bg-black/20 rounded p-0.5 dm-close">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
            <div class="flex-1 overflow-y-auto p-3 space-y-3 bg-[#f3f2f1] text-sm dm-messages"></div>
            <form class="dm-form border-t border-[#edebe9] p-2 bg-white flex gap-2">
                <input type="text" class="dm-input flex-1 px-2 mb-1 outline-none text-sm placeholder-[#a19f9d]" placeholder="Type a message...">
                <button type="submit" class="text-[#0f6cbd] p-1"><svg class="w-4 h-4 transform rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg></button>
            </form>
        `;

        // Bind events
        const closeBtn = dmHTML.querySelector('.dm-close');
        closeBtn.onclick = () => {
            dmHTML.remove();
            openDMs.delete(targetId);
        };

        const form = dmHTML.querySelector('.dm-form');
        const input = dmHTML.querySelector('.dm-input');

        form.onsubmit = (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (text && socket) {
                socket.emit('private_message', { targetId, text });
                input.value = '';
            }
        };

        dmContainer.appendChild(dmHTML);
        openDMs.set(targetId, { element: dmHTML, messagesContainer: dmHTML.querySelector('.dm-messages') });
    }

    function appendDM(targetId, msg) {
        const dmData = openDMs.get(targetId);
        if (!dmData) return;

        const isMe = msg.isEcho;
        const msgDiv = document.createElement('div');
        msgDiv.className = `flex ${isMe ? 'justify-end' : 'justify-start'}`;
        msgDiv.innerHTML = `
            <div class="max-w-[85%] ${isMe ? 'bg-[#d1e8ff] text-[#242424]' : 'bg-white text-[#242424] border border-[#edebe9]'} rounded px-3 py-1.5 shadow-sm">
                ${escapeHTML(msg.text)}
            </div>
        `;
        dmData.messagesContainer.appendChild(msgDiv);
        dmData.messagesContainer.scrollTop = dmData.messagesContainer.scrollHeight;
    }


    // Global UI Helpers
    function renderMessage(msg, isMe) {
        const timeString = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const initial = msg.username.substring(0, 2).toUpperCase();

        const msgWrapper = document.createElement('div');
        msgWrapper.id = `msg-${msg.msgId}`;
        msgWrapper.className = `group flex gap-3 w-full border-b border-[#f3f2f1] pb-4 ${isMe ? 'flex-row-reverse text-right' : ''}`;

        // Render existing reactions
        let rxHTML = '';
        if (msg.reactions) {
            for (const [emoji, count] of Object.entries(msg.reactions)) {
                rxHTML += `<span class="inline-flex items-center gap-1 bg-[#edebe9] text-xs px-1.5 py-0.5 rounded cursor-help" data-emoji="${emoji}">
                    ${emoji} <span class="count text-[#605e5c]">${count}</span>
                </span>`;
            }
        }

        const innerHTML = `
            <div class="w-10 h-10 shrink-0 rounded-full font-semibold flex items-center justify-center text-sm shadow-sm ${isMe ? 'bg-[#0f6cbd] text-white' : 'bg-[#d1e8ff] text-[#0f6cbd]'} mt-1">
                ${initial}
            </div>
            <div class="flex-1 min-w-0 flex flex-col ${isMe ? 'items-end' : 'items-start'}">
                <div class="flex items-baseline gap-2 mb-1 ${isMe ? 'flex-row-reverse' : ''}">
                    <span class="font-semibold text-[15px] text-[#242424]">${escapeHTML(msg.username)}</span>
                    <span class="text-xs text-[#605e5c]">${timeString}</span>
                </div>
                <div class="text-[15px] text-[#242424] leading-relaxed max-w-[90%] text-left whitespace-pre-wrap ${isMe ? 'bg-[#f3f2f1] px-3 py-2 rounded-lg inline-block' : ''}">
                    ${escapeHTML(msg.text)}
                </div>
                
                <div class="mt-2 flex gap-2 items-center ${isMe ? 'flex-row-reverse' : ''}">
                    <div id="reactions-${msg.msgId}" class="flex gap-1 flex-wrap">${rxHTML}</div>
                    
                    <div class="opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 items-center ${isMe ? 'mr-2' : 'ml-2'}">
                        <button onclick="reactToMessage('${msg.msgId}', '👍')" class="text-lg hover:bg-[#edebe9] rounded px-1 transition-colors">👍</button>
                        <button onclick="reactToMessage('${msg.msgId}', '😂')" class="text-lg hover:bg-[#edebe9] rounded px-1 transition-colors">😂</button>
                        <button onclick="reactToMessage('${msg.msgId}', '❤️')" class="text-lg hover:bg-[#edebe9] rounded px-1 transition-colors">❤️</button>
                        ${isAdmin ? `<button onclick="deleteMessage('${msg.msgId}')" class="text-xs text-red-500 hover:text-red-700 ml-2 border border-red-200 px-2 py-0.5 rounded">Delete</button>` : ''}
                    </div>
                </div>
            </div>
        `;

        msgWrapper.innerHTML = innerHTML;
        messagesContainer.appendChild(msgWrapper);
    }

    // Expose funcs globally
    window.reactToMessage = function (msgId, reaction) {
        if (socket) {
            socket.emit('message_reaction', { msgId, reaction });
        }
    }

    window.deleteMessage = function (msgId) {
        if (socket && confirm("Delete this message?")) {
            socket.emit('admin_delete_msg', msgId);
        }
    }

    window.kickUser = function (targetId) {
        if (socket && confirm("Kick this user from the session?")) {
            socket.emit('admin_kick_user', targetId);
        }
    }

    function appendSystemMessage(text) {
        const msgWrapper = document.createElement('div');
        msgWrapper.className = 'flex justify-center my-2';
        msgWrapper.innerHTML = `
            <div class="text-[#605e5c] text-xs font-medium border-t border-b border-[#edebe9] py-1 px-4 w-full text-center">
                ${escapeHTML(text)}
            </div>
        `;
        messagesContainer.appendChild(msgWrapper);
        scrollToBottom();
    }

    function updateActiveUsers(users) {
        activeCount.textContent = users.length;
        navCount.textContent = users.length;

        activeUsersList.innerHTML = '';
        users.forEach(user => {
            const isMe = user.id === mySessionId;
            const li = document.createElement('li');
            li.className = 'flex items-center justify-between px-4 py-3 hover:bg-[#f3f2f1] transition-colors cursor-pointer group ' + (isMe ? 'bg-[#f3f2f1]' : '');

            const initial = user.username.substring(0, 2).toUpperCase();

            li.innerHTML = `
                <div class="flex items-center gap-3">
                    <div class="relative">
                        <div class="w-10 h-10 rounded-full ${isMe ? 'bg-[#0f6cbd] text-white' : 'bg-[#d1e8ff] text-[#0f6cbd]'} flex items-center justify-center font-semibold text-sm">
                            ${initial}
                        </div>
                        <div class="absolute bottom-0 right-0 w-3 h-3 bg-[#7fba00] border-2 border-white rounded-full"></div>
                    </div>
                    <div class="flex flex-col">
                        <span class="text-[15px] font-medium text-[#242424] group-hover:text-[#0f6cbd] transition-colors">${escapeHTML(user.username)} ${isMe ? '(Me)' : ''}</span>
                        <span class="text-xs text-[#605e5c]">Available - Online</span>
                    </div>
                </div>
                ${!isMe ? `
                <div class="flex items-center">
                    <button class="opacity-0 group-hover:opacity-100 bg-white border border-[#edebe9] px-2 py-1 rounded shadow-sm text-xs font-medium text-[#0f6cbd] hover:bg-[#0f6cbd] hover:text-white transition-all open-dm-btn">
                        Message
                    </button>
                    ${isAdmin ? `<button class="ml-2 bg-white border border-red-200 px-2 py-1 rounded shadow-sm text-xs font-medium text-red-500 hover:bg-red-50 transition-all opacity-0 group-hover:opacity-100 kick-user-btn">Kick</button>` : ''}
                </div>
                ` : ''}
            `;

            if (!isMe) {
                // DM Click Event
                li.querySelector('.open-dm-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    openDMWindow(user.id, user.username);
                });

                if (isAdmin) {
                    li.querySelector('.kick-user-btn').addEventListener('click', (e) => {
                        e.stopPropagation();
                        kickUser(user.id);
                    });
                }

                li.addEventListener('click', () => {
                    openDMWindow(user.id, user.username);
                });
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
