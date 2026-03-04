const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
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

// Track total messages sent (in-memory, persisted to DB)
let totalMessagesSent = 0;

// In-memory avatar cache for fast lookups
const avatarCache = new Map();

// ==================== PROFANITY FILTER ====================
// School-appropriate PG-13 content filter (server-side, can't be bypassed)

// Words that must match as standalone (word-boundary checked) to avoid false positives
const PROFANITY_STRICT = [
    'ass', 'damn', 'hell', 'crap', 'dick', 'cock', 'tit', 'cum', 'hoe',
    'fag', 'kys', 'af', 'wtf', 'wth', 'stfu', 'gtfo', 'gay'
];

// Words that match anywhere in the text (substring match)
const PROFANITY_BROAD = [
    'fuck', 'shit', 'bitch', 'pussy', 'penis', 'vagina', 'boob', 'jizz',
    'whore', 'slut', 'bastard', 'piss', 'cunt', 'twat', 'wank', 'dildo',
    'porn', 'xxx', 'nude', 'naked', 'horny', 'orgasm',
    'nigger', 'nigga', 'faggot', 'retard', 'spic', 'chink', 'kike',
    'tranny', 'dyke', 'wetback',
    'cocaine', 'heroin', 'ecstasy', 'xanax',
    'kill yourself', 'shoot up', 'bomb threat',
    'milf', 'thot',
];

// Safe words that contain profanity substrings (whitelist)
const SAFE_WORDS = [
    'class', 'classic', 'pass', 'passing', 'passion', 'assignment', 'assist',
    'glass', 'grass', 'mass', 'bass', 'compass', 'embassy', 'asset',
    'hello', 'shell', 'seashell', 'shellfish', 'othello',
    'title', 'subtitle', 'titillate', 'titan', 'titivate',
    'assess', 'assassin', 'cassette', 'lassie',
    'scunthorpe', 'cockatoo', 'cockpit', 'cocktail', 'peacock', 'hancock',
    'cumulative', 'document', 'circumvent', 'cucumber',
    'therapist', 'manslaughter', 'penisland',
    'shoehorn', 'shoe', 'shoes', 'horseshoe',
    'dickens', 'benedict',
    'methane', 'method', 'something', 'methodist',
    'afar', 'after', 'afternoon', 'affair', 'affect', 'afford',
];

// Leet speak character map for normalization
const LEET_MAP = {
    '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't',
    '8': 'b', '@': 'a', '$': 's',
};

function normalizeLeet(text) {
    return text.split('').map(c => LEET_MAP[c] || c).join('');
}

function containsProfanity(text) {
    if (!text || text.length === 0) return false;

    const lower = text.toLowerCase();

    // Check if the entire message is just a safe word
    const words = lower.split(/\s+/);
    const safeCheck = words.filter(w => !SAFE_WORDS.includes(w.replace(/[^a-z]/g, '')));

    const normalized = normalizeLeet(lower);
    // Remove spaces/special chars between letters (catches "f u c k", "f.u.c.k")
    const stripped = normalized.replace(/[\s._\-*#@!$%^&()+=~`|\\/<>,;:'"?\[\]{}]/g, '');
    // Remove excessive repeated chars (catches "fuuuuck")
    const deduped = stripped.replace(/(.)\1{2,}/g, '$1$1');

    const variants = [lower, normalized, stripped, deduped];

    for (const variant of variants) {
        // Check broad matches (substring)
        for (const word of PROFANITY_BROAD) {
            if (variant.includes(word)) {
                // Check if this is actually a safe word
                const cleanVariant = variant.replace(/[^a-z]/g, '');
                let isSafe = false;
                for (const safe of SAFE_WORDS) {
                    if (cleanVariant.includes(safe) && safe.includes(word)) {
                        isSafe = true;
                        break;
                    }
                }
                if (!isSafe) return true;
            }
        }

        // Check strict matches (word boundary)
        for (const word of PROFANITY_STRICT) {
            const regex = new RegExp('(?:^|\\s|[^a-z])' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|\\s|[^a-z])', 'i');
            if (regex.test(' ' + variant + ' ')) {
                // Double-check it's not part of a safe word
                let isSafe = false;
                for (const w of words) {
                    const clean = w.replace(/[^a-z]/g, '');
                    if (SAFE_WORDS.includes(clean)) { isSafe = true; break; }
                }
                if (!isSafe) return true;
            }
        }
    }
    return false;
}


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

    // Persistent global chat messages
    db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        msg_id TEXT UNIQUE,
        username TEXT NOT NULL,
        text TEXT NOT NULL,
        is_bot INTEGER DEFAULT 0,
        is_admin INTEGER DEFAULT 0,
        is_verified INTEGER DEFAULT 0,
        avatar TEXT,
        score INTEGER DEFAULT 0,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Direct messages
    db.run(`CREATE TABLE IF NOT EXISTS direct_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        msg_id TEXT UNIQUE,
        conversation_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Conversations (DM threads)
    db.run(`CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        participant1 TEXT NOT NULL,
        participant2 TEXT NOT NULL,
        last_message TEXT,
        last_timestamp TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // DB index on LOWER(username) for fast case-insensitive lookups
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username))`, (err) => {
        if (err) console.error('Could not create username index:', err.message);
    });

    // Preload avatar cache
    db.all('SELECT username, avatar FROM users WHERE avatar IS NOT NULL', [], (err, rows) => {
        if (!err && rows) {
            rows.forEach(r => avatarCache.set(r.username, r.avatar));
            console.log(`Loaded ${rows.length} avatars into cache`);
        }
    });
});

// Security headers via helmet (CSP disabled for CDN scripts)
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({ limit: '1mb' }));

// Rate limiter for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});

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
const TENOR_API_KEY = process.env.TENOR_API_KEY;
app.get('/api/gifs', async (req, res) => {
    try {
        if (!TENOR_API_KEY) return res.status(503).json({ error: 'GIF service not configured' });
        const query = req.query.q || 'trending';
        const limit = req.query.limit || 20;
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

            // Send Email Notification if env vars exist
            if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
                const transporter = nodemailer.createTransport({
                    service: 'gmail', // Standard gmail setup
                    auth: {
                        user: process.env.EMAIL_USER,
                        pass: process.env.EMAIL_PASS
                    }
                });

                const mailOptions = {
                    from: process.env.EMAIL_USER,
                    to: 'tyjmunn@gmail.com',
                    subject: `New chatroom-test ${typeLabel} from ${name}`,
                    text: `A new feature request/bug report was received on the site.\n\nSender Name: ${name}\nTransmission Type: ${typeLabel}\nDetails: ${details}\n\nTime: ${new Date().toLocaleString()}`
                };

                try {
                    await transporter.sendMail(mailOptions);
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
app.post('/api/register', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
        if (containsProfanity(username)) return res.status(400).json({ error: 'Username contains inappropriate content' });

        const lowerUsername = username.toLowerCase();

        db.get('SELECT id FROM users WHERE LOWER(username) = ?', [lowerUsername], async (err, row) => {
            if (row) return res.status(400).json({ error: 'Username exists' });

            const hash = await bcrypt.hash(password, 10);

            // Auto-grant mod to tmunn
            const role = lowerUsername === 'tmunn' ? 'mod' : 'user';

            db.run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, role], function (err) {
                if (err) return res.status(500).json({ error: 'DB error' });
                res.status(201).json({ success: true });
            });
        });
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/login', authLimiter, (req, res) => {
    try {
        const { username, password } = req.body;
        const lowerUsername = (username || '').toLowerCase();

        // Exclusively allow tmunn
        if (lowerUsername !== 'tmunn' || password !== 'hockey26') {
            return res.status(401).json({ error: 'Invalid credentials. Site access restricted.' });
        }

        // DB bypass. Since registrations are closed and DB is fresh, manually authenticate the master account
        const finalRole = 'mod';
        const userObj = { id: 1, username: 'tmunn', role: finalRole, reputation: 9999 };
        const token = jwt.sign(userObj, JWT_SECRET, { expiresIn: '24h' });

        // Ensure tmunn is established in DB just in case future features rely on FKs
        db.get('SELECT id FROM users WHERE LOWER(username) = ?', ['tmunn'], async (err, user) => {
            if (!user) {
                const hash = await bcrypt.hash('hockey26', 10);
                db.run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', ['tmunn', hash, finalRole]);
            } else {
                db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
            }
        });

        res.json({ token, user: userObj });

    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/guest', (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'Missing username' });
        if (containsProfanity(username)) return res.status(400).json({ error: 'Username contains inappropriate content' });

        // Generate a clean guest name and token
        const finalUsername = username.replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 20);
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
        const activeSet = new Set(Array.from(activeUsers.values()).map(u => u.username));

        const mappedRows = rows.map(r => ({
            ...r,
            isActive: activeSet.has(r.username)
        }));

        res.json(mappedRows);
    });
});

// Admin PIN Verification endpoint (for non-socket pages)
app.post('/api/admin/verify', authLimiter, (req, res) => {
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
const messageIndex = new Map(); // msgId → index in messageHistory (O(1) vote lookup)
const MAX_HISTORY = 100;
function pushHistory(type, data) {
    if (messageHistory.length >= MAX_HISTORY) {
        const removed = messageHistory.shift();
        if (removed?.data?.msgId) messageIndex.delete(removed.data.msgId);
        // Re-index remaining items after shift
        messageIndex.clear();
        messageHistory.forEach((m, i) => { if (m.data?.msgId) messageIndex.set(m.data.msgId, i); });
    }
    messageHistory.push({ type, data });
    if (data?.msgId) messageIndex.set(data.msgId, messageHistory.length - 1);
}

// Simple pin for admin access (loaded from environment)
const ADMIN_PIN = process.env.ADMIN_PIN;
const adminUsers = new Set(); // store socket.ids of admins
const adminAttempts = new Map(); // tracking failed attempts for kicks
let isChatPaused = false; // Admin setting to pause all non-admin chatting

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
    const isGuest = !!socket.user.isGuest;
    activeUsers.set(socket.id, { username, role: socket.user.role, id: socket.id, reputation: socket.user.reputation, isGuest });
    if (socket.user.role === 'mod') {
        adminUsers.add(socket.id);
    }

    // Emit initial pause status
    socket.emit('chat_paused_status', isChatPaused);

    // Client explicitly joins
    socket.on('join_chat', () => {
        const username = socket.user.username;

        // Notify everyone that someone joined
        const sysMsg = { text: `${username} joined the chat.`, timestamp: new Date().toISOString() };
        io.emit('system_message', sysMsg);
        pushHistory('system', sysMsg);

        // Send updated user list to everyone
        io.emit('update_roster', buildRoster());

        // Load persistent chat history from SQLite (last 200 messages)
        db.all('SELECT * FROM chat_messages ORDER BY id DESC LIMIT 200', [], (err, rows) => {
            if (err || !rows) {
                socket.emit('chat_history', messageHistory);
                return;
            }
            const dbHistory = rows.reverse().map(r => ({
                type: 'chat',
                data: {
                    msgId: r.msg_id,
                    username: r.username,
                    text: r.text,
                    timestamp: r.timestamp,
                    id: r.is_bot ? 'gemini_bot' : r.username,
                    isAdmin: !!r.is_admin,
                    isBot: !!r.is_bot,
                    isVerified: !!r.is_verified,
                    avatar: r.avatar || avatarCache.get(r.username) || null,
                    score: r.score || 0,
                }
            }));
            // Merge with any in-memory system messages
            const merged = [...dbHistory, ...messageHistory.filter(m => m.type === 'system')];
            socket.emit('chat_history', merged);
        });

        // Gemini welcome message
        setTimeout(() => {
            const welcomeMsg = {
                msgId: Math.random().toString(36).substring(2, 11),
                username: 'Gemini',
                text: `👋 Welcome, ${username}! Chat with everyone, send DMs by clicking a user, or mention @gemini to ask me anything. Have fun! ⚡`,
                timestamp: new Date().toISOString(),
                id: 'gemini_bot',
                isAdmin: false,
                isBot: true,
            };
            socket.emit('chat_message', welcomeMsg);
        }, 1500);
    });

    // ========== DIRECT MESSAGE SYSTEM ==========

    // Get user's conversations list
    socket.on('get_conversations', () => {
        const userObj = activeUsers.get(socket.id);
        if (!userObj) return;
        const username = userObj.username;

        db.all(
            `SELECT * FROM conversations 
             WHERE LOWER(participant1) = LOWER(?) OR LOWER(participant2) = LOWER(?)
             ORDER BY last_timestamp DESC`,
            [username, username],
            (err, rows) => {
                if (err) { socket.emit('conversations_list', []); return; }
                const convos = (rows || []).map(r => ({
                    id: r.id,
                    otherUser: r.participant1.toLowerCase() === username.toLowerCase() ? r.participant2 : r.participant1,
                    lastMessage: r.last_message,
                    lastTimestamp: r.last_timestamp,
                }));
                socket.emit('conversations_list', convos);
            }
        );
    });

    // Load DM history for a conversation
    socket.on('load_dm_history', (data) => {
        const userObj = activeUsers.get(socket.id);
        if (!userObj) return;
        const convoId = data.conversationId;

        db.all(
            'SELECT * FROM direct_messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 500',
            [convoId],
            (err, rows) => {
                if (err) { socket.emit('dm_history', { conversationId: convoId, messages: [] }); return; }
                const messages = (rows || []).map(r => ({
                    msgId: r.msg_id,
                    sender: r.sender,
                    text: r.text,
                    timestamp: r.timestamp,
                }));
                socket.emit('dm_history', { conversationId: convoId, messages });
            }
        );
    });

    // Send a DM
    socket.on('send_dm', (data) => {
        const userObj = activeUsers.get(socket.id);
        if (!userObj || !data.to || !data.text) return;
        const sender = userObj.username;
        const receiver = data.to;
        const text = data.text.trim();
        if (!text) return;

        const isMod = adminUsers.has(socket.id);

        if (isChatPaused && !isMod) {
            const warnMsg = { msgId: Math.random().toString(36).substring(2, 11), conversationId: '', sender: 'Gemini', text: '⚠️ Network traffic is currently paused by the administrator.', timestamp: new Date().toISOString() };
            socket.emit('receive_dm', warnMsg);
            return;
        }

        // Profanity filter for DMs
        if (containsProfanity(text)) {
            const warnMsg = { msgId: Math.random().toString(36).substring(2, 11), conversationId: '', sender: 'System', text: '⚠️ Message blocked by content filter. Keep it school-appropriate.', timestamp: new Date().toISOString() };
            socket.emit('receive_dm', warnMsg);
            return;
        }

        // Create conversation ID (alphabetical order for consistency)
        const participants = [sender.toLowerCase(), receiver.toLowerCase()].sort();
        const convoId = `dm_${participants[0]}_${participants[1]}`;

        const msgId = Math.random().toString(36).substring(2, 11);
        const timestamp = new Date().toISOString();

        // Save to direct_messages table
        db.run(
            'INSERT INTO direct_messages (msg_id, conversation_id, sender, text, timestamp) VALUES (?, ?, ?, ?, ?)',
            [msgId, convoId, sender, text, timestamp]
        );

        // Upsert conversation
        db.run(
            `INSERT INTO conversations (id, participant1, participant2, last_message, last_timestamp)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET last_message = ?, last_timestamp = ?`,
            [convoId, sender, receiver, text, timestamp, text, timestamp]
        );

        const dmMsg = { msgId, conversationId: convoId, sender, text, timestamp };

        // Send to sender
        socket.emit('receive_dm', dmMsg);

        // Send to receiver if online
        for (const [id, u] of activeUsers.entries()) {
            if (u.username.toLowerCase() === receiver.toLowerCase() && id !== socket.id) {
                io.to(id).emit('receive_dm', dmMsg);
                // Also notify them of updated conversations
                io.to(id).emit('dm_notification', { from: sender, conversationId: convoId, text, timestamp });
                break;
            }
        }
    });

    socket.on('chat_message', (msgData) => {
        const userObj = activeUsers.get(socket.id);
        if (userObj) {
            const isMod = adminUsers.has(socket.id);
            const text = msgData.text.trim();

            if (isChatPaused && !isMod) {
                const warnMsg = {
                    msgId: Math.random().toString(36).substring(2, 11),
                    username: 'Gemini',
                    text: '⚠️ Network traffic is currently paused by the administrator.',
                    timestamp: new Date().toISOString(),
                    id: 'gemini_bot',
                    isAdmin: false,
                    isBot: true,
                };
                socket.emit('chat_message', warnMsg);
                return;
            }

            // ========== PROFANITY FILTER ==========
            if (containsProfanity(text)) {
                const warnMsg = {
                    msgId: Math.random().toString(36).substring(2, 11),
                    username: 'Gemini',
                    text: '⚠️ Your message was blocked by the content filter. Please keep it school-appropriate. Repeated violations may result in action by admins.',
                    timestamp: new Date().toISOString(),
                    id: 'gemini_bot',
                    isAdmin: false,
                    isBot: true,
                };
                socket.emit('chat_message', warnMsg);
                console.log(`[FILTER] Blocked message from ${userObj.username}: "${text.substring(0, 50)}..."`);
                return;
            }

            // ========== COMMAND SYSTEM (!commands and /commands) ==========
            if (text.startsWith('!') || text.startsWith('/')) {
                const parts = text.split(' ');
                const command = parts[0].toLowerCase().replace(/^[!/]/, '');

                // Helper to send a bot response only to the sender
                function sendBotReply(replyText) {
                    const botMsg = {
                        msgId: Math.random().toString(36).substring(2, 11),
                        username: 'Gemini',
                        text: replyText,
                        timestamp: new Date().toISOString(),
                        id: 'gemini_bot',
                        isAdmin: false,
                        isBot: true,
                    };
                    socket.emit('chat_message', botMsg);
                }

                // Helper to send a system message to everyone
                function sendSystem(sysText) {
                    const sysMsg = { text: sysText, timestamp: new Date().toISOString() };
                    io.emit('system_message', sysMsg);
                    pushHistory('system', sysMsg);
                }

                switch (command) {
                    case 'help':
                    case 'commands':
                        sendBotReply(
                            `👋 Hey ${userObj.username}! Here are the available commands:\n\n` +
                            `📋 GENERAL:\n` +
                            `  !help — Show this command list\n` +
                            `  !about — Learn about munn.fun\n` +
                            `  !rules — View the chat rules\n` +
                            `  !stats — See your personal stats\n` +
                            `  !leaderboard — Top liked users\n\n` +
                            `🎮 FUN:\n` +
                            `  !roll [max] — Roll a die (default 1-100)\n` +
                            `  !flip — Flip a coin\n` +
                            `  !8ball [question] — Ask the magic 8-ball\n\n` +
                            `🤖 AI:\n` +
                            `  @gemini [question] — Ask the AI anything\n\n` +
                            `💡 TIP: Visit munn.fun/updates.html to explore the source code!`
                        );
                        return;

                    case 'about':
                        sendBotReply(
                            `⚡ MUNN.FUN — Real-Time Chat Platform\n\n` +
                            `Built by Mr. Munn as a learning project for his students at Syracuse Latin.\n\n` +
                            `🧱 Tech Stack: Node.js, Express, Socket.io, SQLite3, Google Gemini AI\n` +
                            `☁️ Hosted on Fly.io (Secaucus, NJ) with persistent storage\n` +
                            `🌐 Domain: munn.fun via Namecheap\n\n` +
                            `📋 Visit munn.fun/updates.html for the full changelog, source code browser, and tech stack breakdown!`
                        );
                        return;

                    case 'rules':
                        sendBotReply(
                            `📜 CHAT RULES:\n\n` +
                            `1. Be respectful to everyone\n` +
                            `2. No spam or message flooding\n` +
                            `3. No inappropriate content\n` +
                            `4. No impersonation or fake accounts\n` +
                            `5. Keep it school-appropriate\n` +
                            `6. Have fun and be cool 😎\n\n` +
                            `⚠️ Violations may result in a kick or account action by admins.`
                        );
                        return;

                    case 'stats':
                        db.get('SELECT reputation_score FROM users WHERE LOWER(username) = LOWER(?)', [userObj.username], (err, row) => {
                            db.get('SELECT count FROM message_counts WHERE username = ?', [userObj.username], (err2, countRow) => {
                                const rep = row ? row.reputation_score : 0;
                                const msgs = countRow ? countRow.count : 0;
                                sendBotReply(
                                    `📊 Stats for ${userObj.username}:\n\n` +
                                    `❤️ Likes received: ${rep}\n` +
                                    `💬 Messages sent: ${msgs}\n` +
                                    `🔐 Account type: ${userObj.isGuest ? 'Guest' : 'Registered'}\n` +
                                    `${isMod ? '⭐ Role: Admin\n' : ''}` +
                                    `🟢 Status: Online`
                                );
                            });
                        });
                        return;

                    case 'leaderboard':
                    case 'top':
                        db.all('SELECT username, reputation_score FROM users ORDER BY reputation_score DESC LIMIT 10', [], (err, rows) => {
                            if (err || !rows || rows.length === 0) {
                                sendBotReply('No leaderboard data yet. Start liking messages!');
                                return;
                            }
                            const medals = ['🥇', '🥈', '🥉'];
                            let text = '🏆 MOST LIKED USERS:\n\n';
                            rows.forEach((r, i) => {
                                const medal = medals[i] || `${i + 1}.`;
                                text += `${medal} ${r.username} — ❤️ ${r.reputation_score}\n`;
                            });
                            sendBotReply(text);
                        });
                        return;

                    case 'roll':
                        const max = parseInt(parts[1]) || 100;
                        const roll = Math.floor(Math.random() * max) + 1;
                        sendSystem(`🎲 ${userObj.username} rolled a ${roll} (1-${max})`);
                        return;

                    case 'flip':
                    case 'coin':
                        const coin = Math.random() < 0.5 ? 'HEADS 🪙' : 'TAILS 🪙';
                        sendSystem(`🪙 ${userObj.username} flipped a coin: ${coin}`);
                        return;

                    case '8ball':
                        const responses = [
                            '🎱 It is certain.', '🎱 Without a doubt.', '🎱 Yes, definitely.',
                            '🎱 You may rely on it.', '🎱 As I see it, yes.', '🎱 Most likely.',
                            '🎱 Outlook good.', '🎱 Yes.', '🎱 Signs point to yes.',
                            '🎱 Reply hazy, try again.', '🎱 Ask again later.', '🎱 Better not tell you now.',
                            '🎱 Cannot predict now.', '🎱 Concentrate and ask again.',
                            '🎱 Don\'t count on it.', '🎱 My reply is no.', '🎱 My sources say no.',
                            '🎱 Outlook not so good.', '🎱 Very doubtful.'
                        ];
                        const answer = responses[Math.floor(Math.random() * responses.length)];
                        sendSystem(`${userObj.username} asked the 8-ball: "${parts.slice(1).join(' ') || '...'}" → ${answer}`);
                        return;

                    // Admin-only commands
                    case 'clear':
                        if (isMod) {
                            messageHistory = [];
                            io.emit('purge_all_messages');
                        }
                        return;

                    case 'kick':
                        if (isMod && parts[1]) {
                            const targetName = parts[1];
                            let targetSocketId = null;
                            for (const [id, u] of activeUsers.entries()) {
                                if (u.username.toLowerCase() === targetName.toLowerCase()) {
                                    targetSocketId = id; break;
                                }
                            }
                            if (targetSocketId) {
                                io.to(targetSocketId).emit('kicked_out');
                                sendSystem(`⚠️ ${targetName} was kicked by ${userObj.username}.`);
                                setTimeout(() => {
                                    const targetSocket = io.sockets.sockets.get(targetSocketId);
                                    if (targetSocket) targetSocket.disconnect();
                                }, 500);
                            }
                        }
                        return;

                    case 'announce':
                        if (isMod && parts.slice(1).join(' ')) {
                            io.emit('admin_announcement', parts.slice(1).join(' '));
                        }
                        return;

                    default:
                        sendBotReply(`❓ Unknown command: !${command}\nType !help to see available commands.`);
                        return;
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

            // Persist to SQLite
            db.run(
                'INSERT INTO chat_messages (msg_id, username, text, is_bot, is_admin, is_verified, avatar, score, timestamp) VALUES (?, ?, ?, 0, ?, ?, ?, 0, ?)',
                [chatMsg.msgId, chatMsg.username, chatMsg.text, isMod ? 1 : 0, chatMsg.isVerified ? 1 : 0, chatMsg.avatar, chatMsg.timestamp]
            );

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

                        // Persist Gemini message
                        db.run(
                            'INSERT INTO chat_messages (msg_id, username, text, is_bot, is_admin, is_verified, avatar, score, timestamp) VALUES (?, ?, ?, 1, 0, 0, NULL, 0, ?)',
                            [geminiMsg.msgId, geminiMsg.username, geminiMsg.text, geminiMsg.timestamp]
                        );
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

        // Find msg in history via O(1) index map
        const idx = messageIndex.get(msgId);
        if (idx === undefined) return;
        const histEntry = messageHistory[idx];
        if (!histEntry || histEntry.type !== 'chat') return;
        const msg = histEntry.data;

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
            db.run('DELETE FROM chat_messages');
            messageHistory = [];
            io.emit('purge_all_messages');
            io.emit('admin_announcement', { text: `⚠️ SYSTEM PURGE initiated by an Admin`, timestamp: new Date().toISOString() });
        }
    });

    socket.on('admin_toggle_pause', () => {
        if (adminUsers.has(socket.id)) {
            isChatPaused = !isChatPaused;
            io.emit('chat_paused_status', isChatPaused);
            const actionText = isChatPaused ? 'PAUSED' : 'UNPAUSED';
            io.emit('admin_announcement', { text: `⚠️ CHAT NETWORK ${actionText} by Admin`, timestamp: new Date().toISOString() });
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
