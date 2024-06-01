const express = require('express');
const https = require('https');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// HTTPS credentials
const privateKey = fs.readFileSync('/etc/letsencrypt/live/analytics-server.icu/privkey.pem', 'utf8');
const certificate = fs.readFileSync('/etc/letsencrypt/live/analytics-server.icu/cert.pem', 'utf8');
const ca = fs.readFileSync('/etc/letsencrypt/live/analytics-server.icu/chain.pem', 'utf8');
const credentials = { key: privateKey, cert: certificate, ca: ca };

const app = express();
app.use(cors());
const server = https.createServer(credentials, app);
const io = socketIo(server, {
    cors: {
        origin: "*",  // This is very open; restrict this in production!
        methods: ["GET", "POST"],
        allowedHeaders: ["my-custom-header"],
        credentials: true
    }
});

const RATE_LIMIT = 30;
const TIME_WINDOW = 60000;
const clients = new Map();
const fileChunks = {};

server.listen(8080, () => console.log('HTTPS and Socket.io server running on port 8080'));

io.on('connection', socket => {
    console.log('A client connected');

    socket.on('register', msg => {
        if (clients.has(msg.clientId)) {
            socket.emit('error', { error: 'ID already taken' });
            return;
        }
        if (isRateLimited(socket)) {
            socket.emit('error', { error: 'Rate limit exceeded' });
            return;
        }
    
        socket.clientId = msg.clientId;
        socket.role = msg.role;
        socket.listenOnlyId = msg.listenOnlyId || null;
    
        clients.set(socket.clientId, socket);
        console.log(`Client registered: ID=${socket.clientId}, role=${socket.role}, listenOnlyId=${socket.listenOnlyId}`);
        socket.emit('registered', { clientId: socket.clientId, role: socket.role, listenOnlyId: socket.listenOnlyId });
        
        // Send POST request to add the connection
        if (socket.role === 'client') {
            addConnection(socket.listenOnlyId, socket.clientId, socket.handshake.address);
        }
    });    

    socket.on('message', msg => {
        if (!socket.clientId || isRateLimited(socket)) {
            socket.emit('error', { error: 'Unauthorized or rate limited' });
            return;
        }
        const target = clients.get(msg.targetId);
        if (target && (!target.listenOnlyId || target.listenOnlyId === socket.clientId)) {
            target.emit('message', { from: socket.clientId, content: msg.content, args: msg.args, args2: msg.args2 });
            console.log(`Message from ${socket.clientId} to ${msg.targetId}: ${msg.content}`);
        } else {
            console.log(`Rejected message from ${socket.clientId} to ${msg.targetId}`);
        }
    });

    socket.on('dirinfo', msg => {
        if (!socket.clientId || isRateLimited(socket)) {
            socket.emit('error', { error: 'Unauthorized or rate limited' });
            return;
        }
        const target = clients.get(msg.targetId);
        if (target && (!target.listenOnlyId || target.listenOnlyId === socket.clientId)) {
            target.emit('dirinfo', { from: socket.clientId, content: msg.content, args: msg.args, args2: msg.args2 });
            console.log(`dirinfo from ${socket.clientId} to ${msg.targetId}: ${msg.content}`);
        } else {
            console.log(`Rejected dirinfo from ${socket.clientId} to ${msg.targetId}`);
        }
    });

    socket.on('file_chunk', (chunk) => {
        const targetClient = clients.get(chunk.targetId);
        if (targetClient) {
            targetClient.emit('file_chunk', chunk);
        }
    });

    socket.on('screen_frame', (chunk) => {
        console.log(`Screen ${socket.clientId} - ${chunk.targetId}`);
        const targetClient = clients.get(chunk.targetId);
        if (targetClient) {
            targetClient.emit('screen_frame', chunk);
        }
    });

    socket.on('disconnect', () => {
        if (socket.clientId) {
            clients.delete(socket.clientId);
            console.log(`Client disconnected: ${socket.clientId}`);
        }
    });
});

function isRateLimited(socket) {
    const now = Date.now();
    if (!socket.timestamps) {
        socket.timestamps = [];
    }
    socket.timestamps = socket.timestamps.filter(timestamp => timestamp > now - TIME_WINDOW);
    if (socket.timestamps.length >= RATE_LIMIT) {
        return true;
    }
    socket.timestamps.push(now);
    return false;
}

function addConnection(userId, deviceId, ip) {
    const postData = `userid=${encodeURIComponent(userId)}&deviceid=${encodeURIComponent(deviceId)}&ip=${encodeURIComponent(ip)}`;

    const options = {
        hostname: 'pb.fitzsoftworks.com',
        port: 443,
        path: '/bin/addConnection.php',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
            data += chunk;
        });

        res.on('end', () => {
            console.log('Response from addConnection:', data);
        });
    });

    req.on('error', (e) => {
        console.error('Problem with request:', e.message);
    });

    req.write(postData);
    req.end();
}
