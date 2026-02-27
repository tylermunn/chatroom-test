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
    const mobileActiveCount = document.getElementById('mobile-active-count');

    const mobileRosterBtn = document.getElementById('mobile-roster-btn');
    const closeRosterBtn = document.getElementById('close-roster-btn');
    const rosterSidebar = document.getElementById('roster-sidebar');
    const rosterBackdrop = document.getElementById('roster-backdrop');

    // State
    let socket = null;
    let myUsername = '';
    let mySessionId = '';

    // Join Chat Event
    joinForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const username = usernameInput.value.trim();
        if (username) {
            myUsername = username;

            // Initialize Socket Connection
            socket = io();

            socket.on('connect', () => {
                mySessionId = socket.id;
                socket.emit('join_chat', myUsername);

                // Hide modal, show app with transition
                entryModal.classList.add('opacity-0');
                setTimeout(() => {
                    entryModal.classList.add('hidden');
                    entryModal.classList.remove('flex');

                    mainApp.classList.remove('hidden');
                    // Add a tiny delay before toggling opacity to trigger transition
                    setTimeout(() => {
                        mainApp.classList.remove('opacity-0');
                        messageInput.focus();
                    }, 10);
                }, 300);
            });

            setupSocketListeners();
        }
    });

    // Chat Form Submit
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = messageInput.value.trim();
        if (text && socket) {
            socket.emit('chat_message', { text });
            messageInput.value = '';

            // Keep focus after sending for desktop
            if (window.innerWidth > 768) {
                messageInput.focus();
            }
        }
    });

    // Setup Socket Listeners
    function setupSocketListeners() {
        // Handle chat history
        socket.on('chat_history', (history) => {
            history.forEach(msg => {
                if (msg.type === 'chat') {
                    const isMe = msg.data.id === mySessionId;
                    appendMessage(msg.data.username, msg.data.text, msg.data.timestamp, isMe);
                } else if (msg.type === 'system') {
                    // Only append system messages with history if you want, 
                    // optional: maybe skip "XYZ joined the chat" for past users to reduce spam?
                    // But we'll include it for complete context
                    appendSystemMessage(msg.data.text);
                }
            });
        });

        // Handle incoming chat messages
        socket.on('chat_message', (msg) => {
            const isMe = msg.id === mySessionId;
            appendMessage(msg.username, msg.text, msg.timestamp, isMe);
        });

        // Handle system messages (join/leave)
        socket.on('system_message', (msg) => {
            appendSystemMessage(msg.text);
        });

        // Update active user list
        socket.on('update_roster', (users) => {
            updateActiveUsers(users);
        });
    }

    // UI Helpers
    function appendMessage(username, text, timestamp, isMe) {
        const timeString = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const msgWrapper = document.createElement('div');
        msgWrapper.className = `flex w-full ${isMe ? 'justify-end' : 'justify-start'}`;

        const innerHTML = isMe ? `
            <div class="max-w-[85%] sm:max-w-[75%] flex flex-col items-end">
                <span class="text-[10px] text-slate-400 mb-1 px-1 font-medium select-none uppercase tracking-wider">You • ${timeString}</span>
                <div class="bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 sm:px-5 sm:py-3 shadow-sm break-words w-full text-sm sm:text-base leading-relaxed border border-blue-600">
                    ${escapeHTML(text)}
                </div>
            </div>
        ` : `
            <div class="max-w-[85%] sm:max-w-[75%] flex flex-col items-start">
                <span class="text-[10px] text-slate-400 mb-1 px-1 font-medium select-none uppercase tracking-wider">${escapeHTML(username)} • ${timeString}</span>
                <div class="bg-white border border-slate-200/60 text-slate-700 rounded-2xl rounded-tl-sm px-4 py-2.5 sm:px-5 sm:py-3 shadow-sm break-words w-full text-sm sm:text-base leading-relaxed">
                    ${escapeHTML(text)}
                </div>
            </div>
        `;

        msgWrapper.innerHTML = innerHTML;
        messagesContainer.appendChild(msgWrapper);
        scrollToBottom();
    }

    function appendSystemMessage(text) {
        const msgWrapper = document.createElement('div');
        msgWrapper.className = 'flex justify-center my-4';
        msgWrapper.innerHTML = `
            <div class="bg-slate-100 text-slate-500 border border-slate-200 rounded-full px-5 py-1.5 text-xs font-medium select-none shadow-sm">
                ${escapeHTML(text)}
            </div>
        `;
        messagesContainer.appendChild(msgWrapper);
        scrollToBottom();
    }

    function updateActiveUsers(users) {
        // Update counts
        activeCount.textContent = users.length;
        mobileActiveCount.textContent = users.length;

        // Update list
        activeUsersList.innerHTML = '';
        users.forEach(user => {
            const isMe = user === myUsername;
            const li = document.createElement('li');
            li.className = 'flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ' +
                (isMe ? 'bg-blue-50/60 border border-blue-100/50' : 'hover:bg-slate-50 border border-transparent');

            // Simple avatar using first letter
            const initial = user.charAt(0).toUpperCase();

            li.innerHTML = `
                <div class="w-9 h-9 shrink-0 rounded-full ${isMe ? 'bg-gradient-to-tr from-blue-600 to-blue-500' : 'bg-slate-200'} flex items-center justify-center text-sm font-bold shadow-sm ${isMe ? 'text-white' : 'text-slate-600'}">
                    ${initial}
                </div>
                <div class="flex-1 min-w-0">
                    <p class="font-medium text-sm truncate ${isMe ? 'text-blue-700' : 'text-slate-700'}">
                        ${escapeHTML(user)} ${isMe ? '<span class="text-xs font-normal opacity-70">(You)</span>' : ''}
                    </p>
                </div>
                <div class="w-2 h-2 shrink-0 rounded-full bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.5)]"></div>
            `;
            activeUsersList.appendChild(li);
        });
    }

    function scrollToBottom() {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // Utility: prevent XSS
    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g,
            tag => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                "'": '&#39;',
                '"': '&quot;'
            }[tag] || tag)
        );
    }

    // Mobile Sidebar Toggle Logic
    let isSidebarOpen = false;

    function toggleMobileSidebar() {
        if (!isSidebarOpen) {
            // Open sidebar
            isSidebarOpen = true;
            rosterSidebar.classList.remove('hidden');
            rosterBackdrop.classList.remove('hidden');

            // Small delay to allow display:block to apply before animating transform
            setTimeout(() => {
                rosterSidebar.classList.remove('translate-x-full');
                rosterBackdrop.classList.remove('opacity-0');
            }, 10);
        } else {
            // Close sidebar
            isSidebarOpen = false;
            rosterSidebar.classList.add('translate-x-full');
            rosterBackdrop.classList.add('opacity-0');

            setTimeout(() => {
                rosterSidebar.classList.add('hidden');
                rosterBackdrop.classList.add('hidden');
            }, 300); // Wait for transition duration
        }
    }

    mobileRosterBtn.addEventListener('click', toggleMobileSidebar);
    closeRosterBtn.addEventListener('click', toggleMobileSidebar);
    rosterBackdrop.addEventListener('click', toggleMobileSidebar);
});
