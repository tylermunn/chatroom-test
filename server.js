const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-me';

// Setup DB
const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) console.error("Database opening error: ", err);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        reputation_score INTEGER DEFAULT 0
    )`);
});

app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Explicitly serve index.html for the root route just in case static routing misses it
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Neural Link endpoint
app.post('/api/suggestions', (req, res) => {
    try {
        const { name, type, details } = req.body;
        if (!name || !type || !details) {
            return res.status(400).json({ error: 'Incomplete transmission data.' });
        }

        const suggestion = {
            id: Math.random().toString(36).substring(2, 11),
            name,
            type,
            details,
            timestamp: new Date().toISOString(),
            status: 'pending'
        };

        const filePath = path.join(__dirname, 'suggestions.json');

        let suggestions = [];
        if (fs.existsSync(filePath)) {
            const rawData = fs.readFileSync(filePath, 'utf8');
            try {
                suggestions = JSON.parse(rawData);
            } catch (err) {
                suggestions = [];
            }
        }

        suggestions.push(suggestion);
        fs.writeFileSync(filePath, JSON.stringify(suggestions, null, 2));

        // Alert chat
        const typeLabel = type.toUpperCase();
        const sysMsg = {
            text: `[NEURAL LINK] A new ${typeLabel} transmission has been submitted by ${name}.`,
            timestamp: new Date().toISOString()
        };
        io.emit('system_message', sysMsg);

        // Add to chat history
        messageHistory.push({ type: 'system', data: sysMsg });
        if (messageHistory.length > MAX_HISTORY) messageHistory.shift();

        res.status(201).json({ success: true, id: suggestion.id });
    } catch (e) {
        console.error("Neural Link Error:", e);
        res.status(500).json({ error: 'System failure during transmission logging.' });
    }
});

// Auth endpoints
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

        db.get('SELECT id FROM users WHERE username = ?', [username], async (err, row) => {
            if (row) return res.status(400).json({ error: 'Username exists' });

            const hash = await bcrypt.hash(password, 10);
            db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash], function (err) {
                if (err) return res.status(500).json({ error: 'DB error' });
                res.status(201).json({ success: true });
            });
        });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/login', (req, res) => {
    try {
        const { username, password } = req.body;
        db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
            if (err) return res.status(500).json({ error: 'DB error' });
            if (!user) return res.status(401).json({ error: 'Invalid credentials' });

            const match = await bcrypt.compare(password, user.password_hash);
            if (!match) return res.status(401).json({ error: 'Invalid credentials' });

            const token = jwt.sign({ id: user.id, username: user.username, role: user.role, reputation: user.reputation_score }, JWT_SECRET, { expiresIn: '24h' });
            res.json({ token, user: { username: user.username, role: user.role, reputation: user.reputation_score } });
        });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API endpoint for AI Snow Day Predictor
app.get('/api/snow-prediction', async (req, res) => {
    try {
        // Fetch 7-day weather forecast for Syracuse, NY
        const weatherUrl = 'https://api.open-meteo.com/v1/forecast?latitude=43.0481&longitude=-76.1474&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum,windspeed_10m_max&timezone=America%2FNew_York';
        const weatherResponse = await fetch(weatherUrl);
        const weatherData = await weatherResponse.json();

        // Pass to Gemini
        const ai = getGeminiClient();
        if (!ai) {
            return res.status(500).json({ error: 'AI Kernel offline. Please configure API key.' });
        }

        const prompt = `
You are a highly analytical AI meteorologist assistant for Syracuse Latin School. 
I am going to give you raw weather data for the next 7 days from the Open-Meteo API for Syracuse, NY.
Analyze the expected snowfall, precipitation, temperatures, and wind speeds.
Calculate the "Snow Day Probability" (a percentage from 0% to 100%) for each day.
Only output a rigid JSON array containing objects with the following keys:
- "date": (string) The date, e.g. "Mon, Mar 2"
- "probability": (number) The probability percentage
- "reason": (string) 1 short sentence heavily summarizing the weather and why it will or won't cause a snow day. Keep it very punchy and analytical.

Here is the raw data:
${JSON.stringify(weatherData.daily)}

Return ONLY JSON. Do not return markdown wrapping or backticks.
`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                temperature: 0.1, // Keep it highly analytical
            }
        });

        let outputText = response.text().trim();
        if (outputText.startsWith('\`\`\`json')) {
            outputText = outputText.replace(/^\`\`\`json\n/, '').replace(/\n\`\`\`$/, '');
        }

        // Send back parsed array
        res.json(JSON.parse(outputText));

    } catch (e) {
        console.error("Snow Predictor Error: ", e);
        res.status(500).json({ error: 'Data correlation failed.' });
    }
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

// Socket Authentication Middleware
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error('Authentication error'));
    }
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error('Authentication error'));
        socket.user = decoded; // { id, username, role, reputation }
        next();
    });
});

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Initial connection successful, user is authenticated
    const username = socket.user.username;

    // Store user data instead of just trusting client string completely
    activeUsers.set(socket.id, { username, role: socket.user.role, id: socket.id, reputation: socket.user.reputation });
    if (socket.user.role === 'mod') {
        adminUsers.add(socket.id);
    }

    // Client explicitly joins
    socket.on('join_chat', () => {
        // User is already authenticated and checked via io.use
        const username = socket.user.username;
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
        const roster = Array.from(activeUsers.values()).map(u => ({ id: u.id, username: u.username, isAdmin: u.role === 'mod' || adminUsers.has(u.id), reputation: u.reputation }));
        if (getGeminiClient() || process.env.GEMINI_API_KEY) roster.unshift({ id: 'gemini_bot', username: 'Gemini', isBot: true });
        io.emit('update_roster', roster);

        // Send chat history to the newly joined user
        socket.emit('chat_history', messageHistory);
    });

    socket.on('chat_message', (msgData) => {
        const userObj = activeUsers.get(socket.id);
        if (userObj) {
            const isMod = adminUsers.has(socket.id);

            // Check for Commands First
            if (msgData.text.startsWith('/')) {
                const parts = msgData.text.split(' ');
                const command = parts[0].toLowerCase();

                if (command === '/roll') {
                    const max = parseInt(parts[1]) || 100;
                    const roll = Math.floor(Math.random() * max) + 1;
                    const sysMsg = {
                        text: `🎲 ${userObj.username} rolled a ${roll} (1-${max}).`,
                        timestamp: new Date().toISOString()
                    };
                    io.emit('system_message', sysMsg);
                    messageHistory.push({ type: 'system', data: sysMsg });
                    return;
                } else if (command === '/leaderboard') {
                    db.all('SELECT username, reputation_score FROM users ORDER BY reputation_score DESC LIMIT 5', [], (err, rows) => {
                        if (err || !rows) return;
                        let text = '🏆 TOP NODES (REP):\n';
                        rows.forEach((r, i) => text += `${i + 1}. ${r.username} [${r.reputation_score}]\n`);
                        const sysMsg = { text, timestamp: new Date().toISOString() };
                        io.emit('system_message', sysMsg);
                        messageHistory.push({ type: 'system', data: sysMsg });
                    });
                    return;
                } else if (isMod) {
                    if (command === '/clear') {
                        messageHistory = [];
                        io.emit('purge_all_messages');
                        return;
                    } else if (command === '/kick' && parts[1]) {
                        const targetName = parts[1];
                        let targetSocketId = null;
                        for (const [id, u] of activeUsers.entries()) {
                            if (u.username.toLowerCase() === targetName.toLowerCase()) {
                                targetSocketId = id; break;
                            }
                        }
                        if (targetSocketId) {
                            io.to(targetSocketId).emit('kicked_out');
                            const adminName = userObj.username;
                            const sysMsg = { text: `SECURITY ALERT: ${targetName} was kicked by ${adminName}.`, timestamp: new Date().toISOString() };
                            io.emit('system_message', sysMsg);
                            messageHistory.push({ type: 'system', data: sysMsg });
                            setTimeout(() => {
                                const targetSocket = io.sockets.sockets.get(targetSocketId);
                                if (targetSocket) targetSocket.disconnect();
                            }, 500);
                        }
                        return;
                    }
                }
            }

            // Normal Message
            const chatMsg = {
                msgId: Math.random().toString(36).substring(2, 11),
                username: userObj.username,
                text: msgData.text,
                timestamp: new Date().toISOString(),
                id: socket.id,
                isAdmin: isMod,
                score: 0,
                upvoters: [],
                downvoters: []
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

    // --- Reputation System ---
    socket.on('vote_message', ({ msgId, voteType }) => {
        // voteType = 1 for upvote, -1 for downvote
        const userObj = activeUsers.get(socket.id);
        if (!userObj) return;

        // Find msg in history
        const msgIndex = messageHistory.findIndex(m => m.type === 'chat' && m.data.msgId === msgId);
        if (msgIndex === -1) return;
        const msg = messageHistory[msgIndex].data;

        // Can't vote on own or bot msg
        if (msg.username === userObj.username || msg.isBot) return;

        // Check if already voted
        const hasUpvoted = msg.upvoters.includes(userObj.username);
        const hasDownvoted = msg.downvoters.includes(userObj.username);

        // Remove previous vote
        if (hasUpvoted) {
            msg.score -= 1;
            msg.upvoters = msg.upvoters.filter(u => u !== userObj.username);
        }
        if (hasDownvoted) {
            msg.score += 1;
            msg.downvoters = msg.downvoters.filter(u => u !== userObj.username);
        }

        // Add new vote if changing
        if (voteType === 1 && !hasUpvoted) {
            msg.score += 1;
            msg.upvoters.push(userObj.username);
        } else if (voteType === -1 && !hasDownvoted) {
            msg.score -= 1;
            msg.downvoters.push(userObj.username);
        }

        // Update DB for message author's total reputation
        db.run('UPDATE users SET reputation_score = reputation_score + ? WHERE username = ?', [voteType, msg.username], function (err) {
            if (!err) {
                // Broadcast update
                io.emit('message_voted', { msgId, score: msg.score });

                // Fetch new total reputation to broadcast via ticker
                db.get('SELECT reputation_score FROM users WHERE username = ?', [msg.username], (err, row) => {
                    if (row) {
                        io.emit('reputation_update', { username: msg.username, reputation: row.reputation_score });
                    }
                });
            }
        });
    });

    // --- Admin Handlers (Legacy Pin vs Role) ---
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
            const roster = Array.from(activeUsers.values()).map(u => ({ id: u.id, username: u.username, isAdmin: u.role === 'mod' || adminUsers.has(u.id), reputation: u.reputation }));
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
        const userObj = activeUsers.get(socket.id);
        if (userObj) {
            const username = userObj.username;
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
