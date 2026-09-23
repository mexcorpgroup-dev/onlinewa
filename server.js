const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    maxHttpBufferSize: 50 * 1024 * 1024,
    cors: { origin: "*" }
});

const ADMIN_PASSWORD = "SuperSecretAdminKey123";

let roomConfig = {
    name: "Online WA Official Group",
    avatarUrl: ""
};

let activeTokens = new Set(["vip-pass-1", "vip-pass-2", "meta-vip-1"]);
let bannedIPs = new Set();
let chatHistory = [];
let registeredUsersByPhone = new Map();
let connectedUsers = new Map();
let currentCall = null;

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage, limits: { fileSize: 45 * 1024 * 1024 } });

app.use(express.json());
// Serve static files from 'public' and root directory
app.use(express.static(__dirname));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.use(express.static(__dirname));

// Direct route to guarantee index.html always loads
app.get('*', (req, res) => {
    const publicPath = path.join(__dirname, 'public', 'index.html');
    const rootPath = path.join(__dirname, 'index.html');

    if (fs.existsSync(publicPath)) {
        res.sendFile(publicPath);
    } else if (fs.existsSync(rootPath)) {
        res.sendFile(rootPath);
    } else {
        res.status(404).send("Error: index.html was not found in your repository. Please make sure index.html is uploaded to GitHub.");
    }
});
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Zero-dependency Open Graph Link Preview Generator
async function extractLinkPreview(text) {
    const urlMatch = text.match(/(https?:\/\/[^\s]+)/i);
    if (!urlMatch) return null;
    const targetUrl = urlMatch[0];

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500); // 3.5s timeout
        const res = await fetch(targetUrl, {
            signal: controller.signal,
            headers: { 'User-Agent': 'WhatsApp/2.21.12.21 A' }
        });
        clearTimeout(timeout);
        const html = await res.text();

        const getMeta = (prop) => {
            const regex1 = new RegExp(`<meta\\s+property=["'](?:og:)?${prop}["']\\s+content=["']([^"']+)["']`, 'i');
            const regex2 = new RegExp(`<meta\\s+content=["']([^"']+)["']\\s+property=["'](?:og:)?${prop}["']`, 'i');
            const regex3 = new RegExp(`<meta\\s+name=["'](?:twitter:)?${prop}["']\\s+content=["']([^"']+)["']`, 'i');
            const m = html.match(regex1) || html.match(regex2) || html.match(regex3);
            return m ? m[1] : null;
        };

        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = getMeta('title') || (titleMatch ? titleMatch[1] : null);
        const description = getMeta('description');
        let image = getMeta('image');

        if (image && !image.startsWith('http')) {
            const parsed = new URL(targetUrl);
            image = new URL(image, parsed.origin).href;
        }

        const domain = new URL(targetUrl).hostname.replace('www.', '');

        if (!title && !description && !image) return null;

        return {
            url: targetUrl,
            domain,
            title: title ? title.trim() : domain,
            description: description ? description.trim().substring(0, 140) + '...' : '',
            image: image || null
        };
    } catch (e) {
        return null;
    }
}

app.get('/api/room-info', (req, res) => {
    res.json(roomConfig);
});

app.post('/api/upload', upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    let type = 'image';
    if (req.file.mimetype.startsWith('video/')) type = 'video';
    else if (req.file.mimetype.startsWith('audio/')) type = 'audio';
    res.json({ url: `/uploads/${req.file.filename}`, type });
});

io.use((socket, next) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (bannedIPs.has(clientIp)) return next(new Error('BANNED_IP'));

    const token = socket.handshake.query.token || "vip-pass-1";
    const adminKey = socket.handshake.query.adminKey;
    const phone = (socket.handshake.query.phone || "").trim();
    const isAdmin = (adminKey === ADMIN_PASSWORD);

    if (!isAdmin && (token && !activeTokens.has(token))) {
        return next(new Error('INVALID_TOKEN'));
    }

    socket.token = token;
    socket.isAdmin = isAdmin;
    socket.clientIp = clientIp;
    socket.phoneNumber = isAdmin ? "Master Admin" : phone;
    socket.userAgent = socket.handshake.headers['user-agent'] || 'Unknown Device';

    let isFirstTime = false;
    if (isAdmin) {
        socket.username = 'Admin';
    } else {
        if (registeredUsersByPhone.has(phone)) {
            socket.username = registeredUsersByPhone.get(phone).username;
        } else {
            isFirstTime = true;
            socket.username = `User_${Math.floor(100000 + Math.random() * 900000)}`;
            registeredUsersByPhone.set(phone, {
                username: socket.username,
                firstJoinedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        }
    }

    socket.isFirstTime = isFirstTime;
    next();
});

io.on('connection', (socket) => {
    connectedUsers.set(socket.id, {
        socketId: socket.id,
        username: socket.username,
        phoneNumber: socket.phoneNumber,
        isAdmin: socket.isAdmin,
        ip: socket.clientIp,
        device: socket.userAgent.includes('Mobile') ? 'Mobile' : 'Desktop',
        joinedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        inCall: false
    });

    socket.emit('init', {
        roomConfig,
        username: socket.username,
        isAdmin: socket.isAdmin,
        history: chatHistory,
        activeCall: currentCall ? { callId: currentCall.callId, participants: Array.from(currentCall.participants) } : null
    });

    if (socket.isFirstTime) {
        const joinMsg = {
            id: Date.now(),
            type: 'system',
            text: `${socket.username} joined using this group's invite link`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        chatHistory.push(joinMsg);
        io.emit('new_message', joinMsg);
    }

    broadcastUserListToAdmins();

    socket.on('update_room_profile', (data) => {
        if (!socket.isAdmin) return;
        if (data.name) roomConfig.name = data.name.trim();
        if (data.avatarUrl !== undefined) roomConfig.avatarUrl = data.avatarUrl;
        
        io.emit('room_profile_updated', roomConfig);

        const notice = {
            id: Date.now(),
            type: 'system',
            text: `Admin changed the group name to "${roomConfig.name}"`,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        chatHistory.push(notice);
        io.emit('new_message', notice);
    });

    socket.on('send_message', async (data) => {
        const text = data.text ? data.text.trim() : "";
        const media = data.media || null;

        const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}\b)/gi;
        if (!socket.isAdmin && text && urlRegex.test(text)) {
            return socket.emit('error_message', 'Only administrators are permitted to send links.');
        }

        if (!text && !media) return;

        // Generate Rich Link Preview for Admin Links
        let linkPreview = null;
        if (socket.isAdmin && text && urlRegex.test(text)) {
            linkPreview = await extractLinkPreview(text);
        }

        const messagePayload = {
            id: Date.now(),
            sender: socket.username,
            isAdmin: socket.isAdmin,
            text,
            media,
            linkPreview,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        chatHistory.push(messagePayload);
        if (chatHistory.length > 150) chatHistory.shift();
        io.emit('new_message', messagePayload);
    });

    socket.on('admin_kick_user', ({ targetSocketId }) => {
        if (!socket.isAdmin) return;
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
            bannedIPs.add(targetSocket.clientIp);
            targetSocket.emit('force_disconnect', { reason: 'You were removed from this room by the administrator.' });
            targetSocket.disconnect(true);
        }
    });

    // Voice Calling Engine
    socket.on('admin_start_call', () => {
        if (!socket.isAdmin) return;
        currentCall = {
            callId: Date.now(),
            startedBy: socket.id,
            participants: new Set([socket.id])
        };

        const u = connectedUsers.get(socket.id);
        if (u) u.inCall = true;

        socket.broadcast.emit('incoming_group_call', { callId: currentCall.callId, caller: 'Admin' });
        socket.emit('call_joined', { callId: currentCall.callId, isInitiator: true, existingParticipants: [] });
        broadcastUserListToAdmins();
    });

    socket.on('join_call', () => {
        if (!currentCall) return socket.emit('error_message', 'No active call.');

        const existingList = Array.from(currentCall.participants);
        currentCall.participants.add(socket.id);

        const u = connectedUsers.get(socket.id);
        if (u) u.inCall = true;

        socket.emit('call_joined', {
            callId: currentCall.callId,
            isInitiator: false,
            existingParticipants: existingList
        });

        socket.broadcast.emit('user_joined_call', { socketId: socket.id, username: socket.username });
        broadcastUserListToAdmins();
    });

    socket.on('leave_call', () => {
        removeSocketFromCall(socket.id);
    });

    socket.on('admin_drop_user_from_call', ({ targetSocketId }) => {
        if (!socket.isAdmin || !currentCall) return;
        if (currentCall.participants.has(targetSocketId)) {
            removeSocketFromCall(targetSocketId, true);
        }
    });

    socket.on('webrtc_signal', ({ target, signal }) => {
        io.to(target).emit('webrtc_signal', { sender: socket.id, signal });
    });

    function removeSocketFromCall(socketId, droppedByAdmin = false) {
        if (!currentCall) return;

        currentCall.participants.delete(socketId);
        const u = connectedUsers.get(socketId);
        if (u) u.inCall = false;

        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket && droppedByAdmin) {
            targetSocket.emit('call_dropped_by_admin', { reason: 'The Admin removed you from the group call.' });
        }

        io.emit('user_left_call', { socketId });

        if (socketId === currentCall.startedBy) {
            io.emit('call_ended');
            for (const pid of currentCall.participants) {
                const user = connectedUsers.get(pid);
                if (user) user.inCall = false;
            }
            currentCall = null;
        }

        broadcastUserListToAdmins();
    }

    socket.on('disconnect', () => {
        removeSocketFromCall(socket.id);
        connectedUsers.delete(socket.id);
        broadcastUserListToAdmins();
    });

    function broadcastUserListToAdmins() {
        const usersArray = Array.from(connectedUsers.values());
        for (const [id, user] of connectedUsers.entries()) {
            if (user.isAdmin) io.to(id).emit('user_list_update', usersArray);
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Online WA running at http://localhost:${PORT}`));
