const https = require('https');

// The URL of your Render application
const URL = 'https://munnfun.com'; 
const INTERVAL = 14 * 60 * 1000; // Ping every 14 minutes (Render sleeps at 15 mins)

function pingServer() {
    https.get(URL, (res) => {
        console.log(`[KeepAlive] Pinged ${URL}. Status: ${res.statusCode}`);
    }).on('error', (err) => {
        console.error(`[KeepAlive] Error pinging server: ${err.message}`);
    });
}

// Start pinging
console.log(`[KeepAlive] Started. Pinging every ${INTERVAL / 60000} minutes.`);
pingServer(); // Initial ping
setInterval(pingServer, INTERVAL);
