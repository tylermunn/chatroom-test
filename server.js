const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Explicitly serve index.html for the root route just in case static routing misses it
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Store active users: socket.id -> username
const activeUsers = new Map();

// Store recent message history
let messageHistory = [];
const MAX_HISTORY = 100; // Store last 100 messages

// Simple pin for admin access
const ADMIN_PIN = '0620';
const adminUsers = new Set(); // store socket.ids of admins
const adminAttempts = new Map(); // tracking failed attempts for kicks

// Initialize Gemini
function getGeminiClient() {
    if (process.env.GEMINI_API_KEY) {
        try {
            return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        } catch (e) {
            console.error("Gemini AI failed to initialize:", e);
            return null;
        }
    }
    return null;
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('join_chat', (username) => {
        // Store user
        activeUsers.set(socket.id, username);

        // Notify everyone that someone joined
        const sysMsg = {
            text: `${username} accessed the library catalog.`,
            timestamp: new Date().toISOString()
        };
        io.emit('system_message', sysMsg);

        // Add to history
        messageHistory.push({ type: 'system', data: sysMsg });
        if (messageHistory.length > MAX_HISTORY) messageHistory.shift();

        // Send updated user list to everyone
        const roster = Array.from(activeUsers.entries()).map(([id, name]) => ({ id, username: name, isAdmin: adminUsers.has(id) }));
        if (getGeminiClient() || process.env.GEMINI_API_KEY) roster.unshift({ id: 'gemini_bot', username: 'Gemini', isBot: true });
        io.emit('update_roster', roster);

        // Send chat history to the newly joined user
        socket.emit('chat_history', messageHistory);
    });

    socket.on('chat_message', (msgData) => {
        const username = activeUsers.get(socket.id);
        if (username) {
            const chatMsg = {
                msgId: Math.random().toString(36).substring(2, 11),
                username: username,
                text: msgData.text,
                timestamp: new Date().toISOString(),
                id: socket.id, // useful to style own messages differently
                isAdmin: adminUsers.has(socket.id),
                reactions: {} // format: { emoji: count }
            };
            io.emit('chat_message', chatMsg);

            // Add to history
            messageHistory.push({ type: 'chat', data: chatMsg });
            if (messageHistory.length > MAX_HISTORY) messageHistory.shift();

            // Check for Gemini Mention
            const aiClient = getGeminiClient();
            if (msgData.text.toLowerCase().includes('@gemini') && aiClient) {
                const promptText = msgData.text.replace(/@gemini/ig, '').trim() || "Say hello!";

                (async () => {
                    try {
                        const systemPrompt = "You are Gemini, an AI participating in a student chatroom that is disguised as a school library index. Keep your answers helpful, concise, and strictly school appropriate. Do not use profanity, violence, or inappropriate topics.";
                        const response = await aiClient.models.generateContent({
                            model: 'gemini-2.5-flash',
                            contents: promptText,
                            config: {
                                systemInstruction: systemPrompt
                            }
                        });

                        const geminiText = response.text;
                        const geminiMsg = {
                            msgId: Math.random().toString(36).substring(2, 11),
                            username: "Gemini",
                            text: geminiText,
                            timestamp: new Date().toISOString(),
                            id: "gemini_bot",
                            isAdmin: false,
                            isBot: true,
                            reactions: {}
                        };
                        io.emit('chat_message', geminiMsg);
                        messageHistory.push({ type: 'chat', data: geminiMsg });
                        if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
                    } catch (err) {
                        console.error("Gemini Error:", err);
                        // Optional: could send an error message from Gemini to chat, but silent failure is safer.
                    }
                })();
            }
        }
    });

    socket.on('message_reaction', (data) => {
        const { msgId, reaction } = data;
        const username = activeUsers.get(socket.id);
        if (username) {
            // Find message in history
            const msgObj = messageHistory.find(m => m.type === 'chat' && m.data.msgId === msgId);
            if (msgObj) {
                if (!msgObj.data.reactions) msgObj.data.reactions = {};
                msgObj.data.reactions[reaction] = (msgObj.data.reactions[reaction] || 0) + 1;
            }
            // Broadcast reaction
            io.emit('message_reaction', { msgId, reaction, username });
        }
    });

    socket.on('private_message', (data) => {
        const { targetId, text } = data;
        const senderName = activeUsers.get(socket.id);
        if (senderName) {
            // Send to target
            io.to(targetId).emit('private_message', {
                senderId: socket.id,
                senderName: senderName,
                text: text,
                timestamp: new Date().toISOString()
            });
            // Send back to sender so they can see it too
            socket.emit('private_message', {
                senderId: socket.id,
                senderName: senderName,
                text: text,
                timestamp: new Date().toISOString(),
                isEcho: true,
                targetId: targetId
            });
        }
    });

    // --- Admin Handlers ---
    socket.on('admin_auth', (pin) => {
        const username = activeUsers.get(socket.id);
        if (!username) return;

        if (pin === ADMIN_PIN) {
            adminUsers.add(socket.id);
            adminAttempts.delete(socket.id); // clear any previous failed attempts
            socket.emit('admin_auth_success');

            // Send a glorious announcement to the chat room
            const announcementMsg = {
                text: `👑 ALL HAIL ADMIN ${username.toUpperCase()} 👑`,
                timestamp: new Date().toISOString()
            };
            io.emit('admin_announcement', announcementMsg);
            messageHistory.push({ type: 'admin_announcement', data: announcementMsg });
            if (messageHistory.length > MAX_HISTORY) messageHistory.shift();

            // Broadcast the updated roster so everyone sees the crown
            const roster = Array.from(activeUsers.entries()).map(([id, name]) => ({ id, username: name, isAdmin: adminUsers.has(id) }));
            if (getGeminiClient() || process.env.GEMINI_API_KEY) roster.unshift({ id: 'gemini_bot', username: 'Gemini', isBot: true });
            io.emit('update_roster', roster);
        } else {
            let attempts = (adminAttempts.get(socket.id) || 0) + 1;
            adminAttempts.set(socket.id, attempts);

            if (attempts >= 3) {
                // Kick them
                adminAttempts.delete(socket.id);
                const sysMsg = {
                    text: `SECURITY ALERT: ${username} was kicked for 3 incorrect administrator code attempts.`,
                    timestamp: new Date().toISOString()
                };
                io.emit('system_message', sysMsg);
                messageHistory.push({ type: 'system', data: sysMsg });
                if (messageHistory.length > MAX_HISTORY) messageHistory.shift();

                socket.emit('kicked_out');
                setTimeout(() => socket.disconnect(), 500);
            } else {
                // Just log to chat
                const sysMsg = {
                    text: `${username} inputted an incorrect administrator code.`,
                    timestamp: new Date().toISOString()
                };
                io.emit('system_message', sysMsg);
                messageHistory.push({ type: 'system', data: sysMsg });
                if (messageHistory.length > MAX_HISTORY) messageHistory.shift();

                socket.emit('admin_auth_fail');
            }
        }
    });

    socket.on('admin_delete_msg', (msgId) => {
        if (adminUsers.has(socket.id)) {
            // Remove from history
            messageHistory = messageHistory.filter(m => !(m.type === 'chat' && m.data.msgId === msgId));
            // Tell everyone to remove it from UI
            io.emit('delete_message', msgId);
        }
    });

    socket.on('admin_kick_user', (targetId) => {
        if (adminUsers.has(socket.id)) {
            // Tell the target to reload/leave
            io.to(targetId).emit('kicked_out');

            // Wait a split second, then force disconnect the socket
            setTimeout(() => {
                const targetSocket = io.sockets.sockets.get(targetId);
                if (targetSocket) targetSocket.disconnect();
            }, 500);
        }
    });

    socket.on('admin_purge_all', () => {
        if (adminUsers.has(socket.id)) {
            messageHistory = [];
            io.emit('purge_all_messages');
        }
    });
    // ----------------------

    socket.on('disconnect', () => {
        const username = activeUsers.get(socket.id);
        if (username) {
            // Notify everyone that someone left
            const sysMsg = {
                text: `${username} disconnected from the catalog.`,
                timestamp: new Date().toISOString()
            };
            io.emit('system_message', sysMsg);

            // Add to history
            messageHistory.push({ type: 'system', data: sysMsg });
            if (messageHistory.length > MAX_HISTORY) messageHistory.shift();

            // Remove from active users
            activeUsers.delete(socket.id);
            adminUsers.delete(socket.id);

            // Send updated user list to everyone
            const roster = Array.from(activeUsers.entries()).map(([id, name]) => ({ id, username: name, isAdmin: adminUsers.has(id) }));
            if (getGeminiClient() || process.env.GEMINI_API_KEY) roster.unshift({ id: 'gemini_bot', username: 'Gemini', isBot: true });
            io.emit('update_roster', roster);
        }
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
