const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Store active users: socket.id -> username
const activeUsers = new Map();

// Store recent message history
const messageHistory = [];
const MAX_HISTORY = 100; // Store last 100 messages

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('join_chat', (username) => {
        // Store user
        activeUsers.set(socket.id, username);

        // Notify everyone that someone joined
        const sysMsg = {
            text: `${username} joined the chat.`,
            timestamp: new Date().toISOString()
        };
        io.emit('system_message', sysMsg);

        // Add to history
        messageHistory.push({ type: 'system', data: sysMsg });
        if (messageHistory.length > MAX_HISTORY) messageHistory.shift();

        // Send updated user list to everyone
        io.emit('update_roster', Array.from(activeUsers.values()));

        // Send chat history to the newly joined user
        socket.emit('chat_history', messageHistory);
    });

    socket.on('chat_message', (msgData) => {
        const username = activeUsers.get(socket.id);
        if (username) {
            const chatMsg = {
                username: username,
                text: msgData.text,
                timestamp: new Date().toISOString(),
                id: socket.id // useful to style own messages differently
            };
            io.emit('chat_message', chatMsg);

            // Add to history
            messageHistory.push({ type: 'chat', data: chatMsg });
            if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
        }
    });

    socket.on('disconnect', () => {
        const username = activeUsers.get(socket.id);
        if (username) {
            // Notify everyone that someone left
            const sysMsg = {
                text: `${username} left the chat.`,
                timestamp: new Date().toISOString()
            };
            io.emit('system_message', sysMsg);

            // Add to history
            messageHistory.push({ type: 'system', data: sysMsg });
            if (messageHistory.length > MAX_HISTORY) messageHistory.shift();

            // Remove from active users
            activeUsers.delete(socket.id);

            // Send updated user list to everyone
            io.emit('update_roster', Array.from(activeUsers.values()));
        }
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
