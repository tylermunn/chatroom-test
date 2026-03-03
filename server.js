const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-me';

// Setup DB — use DB_PATH env var (set to /data/chat.db on Fly.io persistent volume)
const DB_PATH = process.env.DB_PATH || './chat.db';
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error("Database opening error: ", err);
    else console.log(`Database opened at: ${DB_PATH}`);
});

// Track server start time for uptime calc
const SERVER_START_TIME = Date.now();

// Email transporter — created once at startup if credentials are present
const emailTransporter = (process.env.EMAIL_USER && process.env.EMAIL_PASS)
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    })
    : null;

// Track total messages sent (in-memory, persisted to DB)
let totalMessagesSent = 0;

// In-memory avatar cache for fast lookups
const avatarCache = new Map();

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        reputation_score INTEGER DEFAULT 0,
        last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Add avatar column if it doesn't exist
    db.run(`ALTER TABLE users ADD COLUMN avatar TEXT`, (err) => {
        // Ignore error if column already exists
    });

    db.run(`CREATE TABLE IF NOT EXISTS suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        type TEXT,
        details TEXT,
        status TEXT DEFAULT 'pending',
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS message_counts (
        username TEXT PRIMARY KEY,
        count INTEGER DEFAULT 0
    )`);

    // Preload avatar cache
    db.all('SELECT username, avatar FROM users WHERE avatar IS NOT NULL', [], (err, rows) => {
        if (!err && rows) {
            rows.forEach(r => avatarCache.set(r.username, r.avatar));
            console.log(`Loaded ${rows.length} avatars into cache`);
        }
    });
});

app.use(express.json({ limit: '1mb' }));

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Explicitly serve index.html for the root route just in case static routing misses it
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Source Code Viewer Endpoint (for updates.html)
app.get('/api/source/:file', (req, res) => {
    const requestedFile = req.params.file;
    const allowedFiles = {
        'server.js': path.join(__dirname, 'server.js'),
        'app.js': path.join(__dirname, 'public', 'app.js'),
        'chat.html': path.join(__dirname, 'public', 'chat.html'),
        'index.html': path.join(__dirname, 'public', 'index.html'),
        'updates.html': path.join(__dirname, 'public', 'updates.html'),
        'suggestions.html': path.join(__dirname, 'public', 'suggestions.html'),
        'admin.html': path.join(__dirname, 'public', 'admin.html'),
        'package.json': path.join(__dirname, 'package.json'),
        'fly.toml': path.join(__dirname, 'fly.toml'),
        'Dockerfile': path.join(__dirname, 'Dockerfile'),
    };

    if (allowedFiles[requestedFile]) {
        res.type('text/plain').sendFile(allowedFiles[requestedFile]);
    } else {
        res.status(403).json({ error: 'Access to this file is strictly forbidden by the Network Overlord.' });
    }
});

// GIF Search Proxy (Tenor API)
const TENOR_API_KEY = process.env.TENOR_API_KEY || 'AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ'; // Free public key
app.get('/api/gifs', async (req, res) => {
    try {
        const query = req.query.q || 'trending';
        const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
        const url = query === 'trending'
            ? `https://tenor.googleapis.com/v2/featured?key=${TENOR_API_KEY}&limit=${limit}&media_filter=tinygif,gif&contentfilter=medium`
            : `https://tenor.googleapis.com/v2/search?key=${TENOR_API_KEY}&q=${encodeURIComponent(query)}&limit=${limit}&media_filter=tinygif,gif&contentfilter=medium`;

        const response = await fetch(url);
        const data = await response.json();

        const gifs = (data.results || []).map(g => ({
            id: g.id,
            title: g.title || '',
            preview: g.media_formats?.tinygif?.url || g.media_formats?.gif?.url || '',
            url: g.media_formats?.gif?.url || g.media_formats?.tinygif?.url || '',
            width: g.media_formats?.tinygif?.dims?.[0] || 200,
            height: g.media_formats?.tinygif?.dims?.[1] || 150,
        }));

        res.json({ gifs });
    } catch (e) {
        console.error('Tenor GIF Error:', e);
        res.status(500).json({ error: 'GIF search failed' });
    }
});

// Neural Link endpoint
app.post('/api/suggestions', (req, res) => {
    try {
        const { name, type, details } = req.body;
        if (!name || !type || !details) {
            return res.status(400).json({ error: 'Incomplete transmission data.' });
        }

        db.run('INSERT INTO suggestions (name, type, details) VALUES (?, ?, ?)', [name, type, details], async function (err) {
            if (err) {
                console.error("Database error saving suggestion:", err);
                return res.status(500).json({ error: 'System failure during database storage.' });
            }

            // Alert chat
            const typeLabel = type.toUpperCase();
            const sysMsg = {
                text: `[SUGGESTION] A new ${typeLabel} transmission has been submitted by ${name}.`,
                timestamp: new Date().toISOString()
            };
            io.emit('system_message', sysMsg);

            // Add to chat history
            pushHistory('system', sysMsg);

            // Send Email Notification if transporter is configured
            if (emailTransporter) {
                const mailOptions = {
                    from: process.env.EMAIL_USER,
                    to: 'tyjmunn@gmail.com',
                    subject: `New chatroom-test ${typeLabel} from ${name}`,
                    text: `A new feature request/bug report was received on the site.\n\nSender Name: ${name}\nTransmission Type: ${typeLabel}\nDetails: ${details}\n\nTime: ${new Date().toLocaleString()}`
                };

                try {
                    await emailTransporter.sendMail(mailOptions);
                } catch (emailErr) {
                    console.error("Failed to send email notification:", emailErr);
                }
            } else {
                console.log("No EMAIL_USER/EMAIL_PASS provided. Skipping email send.");
            }

            res.status(201).json({ success: true, id: this.lastID });
        });
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

        const lowerUsername = username.toLowerCase();

        db.get('SELECT id FROM users WHERE LOWER(username) = ?', [lowerUsername], async (err, row) => {
            if (err) return res.status(500).json({ error: 'DB error' });
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
        const lowerUsername = username.toLowerCase();
        db.get('SELECT * FROM users WHERE LOWER(username) = ?', [lowerUsername], async (err, user) => {
            if (err) return res.status(500).json({ error: 'DB error' });
            if (!user) return res.status(401).json({ error: 'Invalid credentials' });

            const match = await bcrypt.compare(password, user.password_hash);
            if (!match) return res.status(401).json({ error: 'Invalid credentials' });

            const token = jwt.sign({ id: user.id, username: user.username, role: user.role, reputation: user.reputation_score }, JWT_SECRET, { expiresIn: '24h' });

            // Update last_login
            db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

            res.json({ token, user: { username: user.username, role: user.role, reputation: user.reputation_score } });
        });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/guest', (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'Missing username' });

        // Generate a clean guest name and token
        const finalUsername = username.replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 20);
        if (!finalUsername) return res.status(400).json({ error: 'Invalid username' });
        const token = jwt.sign(
            { id: 'guest_' + Date.now(), username: finalUsername, role: 'user', reputation: 0, isGuest: true },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({ token, user: { username: finalUsername, role: 'user', reputation: 0 } });
    } catch (e) {
        res.status(500).json({ error: 'Server error parsing guest token' });
    }
});

// Avatar Upload endpoint
app.post('/api/avatar', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token' });
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err || !decoded || decoded.isGuest) return res.status(403).json({ error: 'Must be logged in to set avatar' });

        const { avatar } = req.body;
        if (!avatar) return res.status(400).json({ error: 'No avatar data' });

        // Limit to ~150KB base64
        if (avatar.length > 200000) {
            return res.status(400).json({ error: 'Image too large. Max 150KB.' });
        }

        db.run('UPDATE users SET avatar = ? WHERE username = ?', [avatar, decoded.username], function (err) {
            if (err) return res.status(500).json({ error: 'DB error' });
            avatarCache.set(decoded.username, avatar);
            // Broadcast roster update so everyone sees the new avatar
            io.emit('update_roster', buildRoster());
            res.json({ success: true });
        });
    });
});

// Avatar retrieve endpoint
app.get('/api/avatar/:username', (req, res) => {
    const username = req.params.username;
    const cached = avatarCache.get(username);
    if (cached) {
        return res.json({ avatar: cached });
    }
    db.get('SELECT avatar FROM users WHERE username = ?', [username], (err, row) => {
        if (err || !row || !row.avatar) return res.json({ avatar: null });
        avatarCache.set(username, row.avatar);
        res.json({ avatar: row.avatar });
    });
});

app.get('/api/users/status', (req, res) => {
    db.all('SELECT username, last_login FROM users ORDER BY last_login DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'DB error' });

        // Get active usernames
        const activeUsernames = new Set(Array.from(activeUsers.values()).map(u => u.username));

        const mappedRows = rows.map(r => ({
            ...r,
            isActive: activeUsernames.has(r.username)
        }));

        res.json(mappedRows);
    });
});

// Admin PIN Verification endpoint (for non-socket pages)
app.post('/api/admin/verify', (req, res) => {
    const { pin } = req.body;
    if (pin === ADMIN_PIN) {
        const adminToken = jwt.sign({ isAdmin: true, timestamp: Date.now() }, JWT_SECRET, { expiresIn: '4h' });
        res.json({ success: true, adminToken });
    } else {
        res.status(401).json({ error: 'Invalid PIN' });
    }
});

// Admin auth middleware for dashboard routes
function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No admin token' });
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err || !decoded.isAdmin) return res.status(403).json({ error: 'Invalid admin token' });
        next();
    });
}

// Admin Dashboard Stats Endpoint
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const uptimeMs = Date.now() - SERVER_START_TIME;
    const activeUsersList = Array.from(activeUsers.values()).map(u => ({
        username: u.username,
        role: u.role,
        isGuest: u.isGuest,
        reputation: u.reputation
    }));

    // Get all users from DB
    db.all('SELECT id, username, role, reputation_score, last_login FROM users ORDER BY last_login DESC', [], (err, users) => {
        if (err) return res.status(500).json({ error: 'DB error' });

        // Get message counts per user
        db.all('SELECT username, count FROM message_counts ORDER BY count DESC', [], (err2, msgCounts) => {
            if (err2) return res.status(500).json({ error: 'DB error' });

            // Get suggestions count
            db.get('SELECT COUNT(*) as count FROM suggestions', [], (err3, sugRow) => {
                const suggestionsCount = sugRow ? sugRow.count : 0;

                // Get active usernames set
                const activeUsernames = new Set(activeUsersList.map(u => u.username));

                const enrichedUsers = users.map(u => ({
                    ...u,
                    isActive: activeUsernames.has(u.username),
                    messageCount: (msgCounts.find(m => m.username === u.username) || {}).count || 0
                }));

                res.json({
                    uptime: uptimeMs,
                    totalRegisteredUsers: users.length,
                    totalActiveUsers: activeUsersList.length,
                    totalMessagesSent,
                    totalSuggestions: suggestionsCount,
                    activeUsers: activeUsersList,
                    users: enrichedUsers,
                    messageCounts: msgCounts || [],
                    memoryUsage: process.memoryUsage(),
                    serverTime: new Date().toISOString()
                });
            });
        });
    });
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
You are a highly analytical AI meteorologist assistant. 
I am going to give you raw weather data for the next 7 days from the Open-Meteo API.
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

// MunnyCoin Status
let munnPrice = 0.042;
setInterval(() => {
    const volatility = (Math.random() - 0.48) * 0.005;
    munnPrice = Math.max(0.001, munnPrice + volatility);
}, 15000);

app.get('/api/munn-coin', (req, res) => {
    const change = (Math.random() - 0.45) * 5; // Fake 24h % change
    res.json({ price: munnPrice.toFixed(4), change24h: change.toFixed(2) });
});

// Store active users: socket.id -> username
const activeUsers = new Map();

// Store recent message history
let messageHistory = [];
const MAX_HISTORY = 100;
function pushHistory(type, data) {
    messageHistory.push({ type, data });
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift();
}

// Simple pin for admin access — override via ADMIN_PIN env var
const ADMIN_PIN = process.env.ADMIN_PIN || '0620';
const adminUsers = new Set(); // store socket.ids of admins
const adminAttempts = new Map(); // tracking failed attempts for kicks

// Build user roster for broadcasting
function buildRoster() {
    const roster = Array.from(activeUsers.values()).map(u => ({
        id: u.id,
        username: u.username,
        isAdmin: u.role === 'mod' || adminUsers.has(u.id),
        reputation: u.reputation,
        isVerified: !u.isGuest,
        avatar: avatarCache.get(u.username) || null
    }));
    if (getGeminiClient() || process.env.GEMINI_API_KEY) roster.unshift({ id: 'gemini_bot', username: 'Gemini', isBot: true });
    return roster;
}

// Initialize Gemini — memoized so the client is created only once
let _geminiClient = undefined;
function getGeminiClient() {
    if (_geminiClient !== undefined) return _geminiClient;
    if (process.env.GEMINI_API_KEY) {
        try {
            _geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        } catch (e) {
            console.error("Gemini AI failed to initialize:", e);
            _geminiClient = null;
        }
    } else {
        _geminiClient = null;
    }
    return _geminiClient;
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
    const isGuest = !!socket.user.isGuest;
    activeUsers.set(socket.id, { username, role: socket.user.role, id: socket.id, reputation: socket.user.reputation, isGuest });
    if (socket.user.role === 'mod') {
        adminUsers.add(socket.id);
    }

    // Client explicitly joins
    socket.on('join_chat', () => {
        // User is already authenticated and checked via io.use
        const username = socket.user.username;

        // Notify everyone that someone joined
        const sysMsg = {
            text: `${username} joined the chat.`,
            timestamp: new Date().toISOString()
        };
        io.emit('system_message', sysMsg);

        // Add to history
        pushHistory('system', sysMsg);

        // Send updated user list to everyone
        io.emit('update_roster', buildRoster());

        // Send chat history to the newly joined user
        socket.emit('chat_history', messageHistory);
    });

    socket.on('chat_message', (msgData) => {
        const userObj = activeUsers.get(socket.id);
        if (userObj) {
            // Validate message
            if (!msgData.text || typeof msgData.text !== 'string') return;
            if (msgData.text.length > 2000) return;

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
                    pushHistory('system', sysMsg);
                    return;
                } else if (command === '/leaderboard') {
                    db.all('SELECT username, reputation_score FROM users ORDER BY reputation_score DESC LIMIT 5', [], (err, rows) => {
                        if (err || !rows) return;
                        let text = '🏆 TOP NODES (REP):\n';
                        rows.forEach((r, i) => text += `${i + 1}. ${r.username} [${r.reputation_score}]\n`);
                        const sysMsg = { text, timestamp: new Date().toISOString() };
                        io.emit('system_message', sysMsg);
                        pushHistory('system', sysMsg);
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
                            pushHistory('system', sysMsg);
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
                isVerified: !userObj.isGuest,
                avatar: avatarCache.get(userObj.username) || null,
                score: 0,
                upvoters: [],
                downvoters: []
            };
            io.emit('chat_message', chatMsg);

            // Track message count
            totalMessagesSent++;
            db.run('INSERT INTO message_counts (username, count) VALUES (?, 1) ON CONFLICT(username) DO UPDATE SET count = count + 1', [userObj.username]);

            // Add to history
            pushHistory('chat', chatMsg);

            // Check for Gemini Mention
            const aiClient = getGeminiClient();
            if (msgData.text.toLowerCase().includes('@gemini') && aiClient) {
                const promptText = msgData.text.replace(/@gemini/ig, '').trim() || "Say hello!";

                (async () => {
                    try {
                        const systemPrompt = "You are Gemini, an AI participating in a chatroom. Keep your answers helpful and concise.";
                        const response = await aiClient.models.generateContent({
                            model: 'gemini-2.5-flash',
                            contents: promptText,
                            config: {
                                systemInstruction: systemPrompt
                            }
                        });

                        const geminiText = `@${userObj.username} ` + response.text;
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
                        pushHistory('chat', geminiMsg);
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

        // Track old vote value to compute net reputation change
        const oldVote = hasUpvoted ? 1 : hasDownvoted ? -1 : 0;

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
        let newVote = 0;
        if (voteType === 1 && !hasUpvoted) {
            msg.score += 1;
            msg.upvoters.push(userObj.username);
            newVote = 1;
        } else if (voteType === -1 && !hasDownvoted) {
            msg.score -= 1;
            msg.downvoters.push(userObj.username);
            newVote = -1;
        }

        // Net reputation delta: accounts for removing old vote and adding new one
        const repDelta = newVote - oldVote;
        if (repDelta === 0) return; // no actual change, skip DB update

        // Update DB for message author's total reputation
        db.run('UPDATE users SET reputation_score = reputation_score + ? WHERE username = ?', [repDelta, msg.username], function (err) {
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
        const userObj = activeUsers.get(socket.id);
        if (!userObj) return;
        const username = userObj.username;

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
            pushHistory('admin_announcement', announcementMsg);

            // Broadcast the updated roster so everyone sees the crown
            io.emit('update_roster', buildRoster());
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
                pushHistory('system', sysMsg);

                socket.emit('kicked_out');
                setTimeout(() => socket.disconnect(), 500);
            } else {
                // Just log to chat
                const sysMsg = {
                    text: `${username} inputted an incorrect administrator code.`,
                    timestamp: new Date().toISOString()
                };
                io.emit('system_message', sysMsg);
                pushHistory('system', sysMsg);

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

    // Typing indicator events
    socket.on('typing', () => {
        const userObj = activeUsers.get(socket.id);
        if (userObj) {
            socket.broadcast.emit('user_typing', { username: userObj.username });
        }
    });

    socket.on('stop_typing', () => {
        const userObj = activeUsers.get(socket.id);
        if (userObj) {
            socket.broadcast.emit('user_stop_typing', { username: userObj.username });
        }
    });

    socket.on('disconnect', () => {
        const userObj = activeUsers.get(socket.id);
        if (userObj) {
            const username = userObj.username;
            // Notify everyone that someone left
            const sysMsg = {
                text: `${username} left the chat.`,
                timestamp: new Date().toISOString()
            };
            io.emit('system_message', sysMsg);

            // Add to history
            pushHistory('system', sysMsg);

            // Remove from active users
            activeUsers.delete(socket.id);
            adminUsers.delete(socket.id);

            // Send updated user list to everyone
            io.emit('update_roster', buildRoster());
        }
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
