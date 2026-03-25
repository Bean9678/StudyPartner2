const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
// Frontend will be on Firebase Hosting, so we don't serve static files here.

const server = http.createServer(app);

// Enable CORS for all origins to allow connection from Firebase Hosting
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let waitingQueue = []; // Stores objects: { socket, filters, username, avatar }

io.on('connection', (socket) => {
    console.log(`[⚡ CONNECT] New connection: ${socket.id}`);

    // Join search queue
    socket.on('find_partner', (userData) => {
        console.log(`[🔍 SEARCH] User ${userData.username} (${socket.id}) is looking for a partner in Grade ${userData.filters.grade}`);

        // Avoid duplicates in queue
        waitingQueue = waitingQueue.filter(u => u.socket.id !== socket.id);

        // Matching Logic: Find someone with the SAME Grade
        const partnerIdx = waitingQueue.findIndex(waiter => {
            return waiter.filters.grade === userData.filters.grade;
        });

        if (partnerIdx !== -1) {
            const partner = waitingQueue.splice(partnerIdx, 1)[0];
            const roomId = `room_${socket.id}_${partner.socket.id}`;
            
            console.log(`[🤝 MATCH SUCCESS] Creating room ${roomId} for ${userData.username} and ${partner.username}`);

            socket.join(roomId);
            partner.socket.join(roomId);

            socket.roomId = roomId;
            partner.socket.roomId = roomId;

            // Notify both users with partner info
            socket.emit('matched', { 
                roomId, 
                partner: { username: partner.username, avatar: partner.avatar, filters: partner.filters } 
            });
            partner.socket.emit('matched', { 
                roomId, 
                partner: { username: userData.username, avatar: userData.avatar, filters: userData.filters } 
            });

        } else {
            console.log(`[⏳ QUEUED] ${userData.username} added to waiting list.`);
            waitingQueue.push({ 
                socket, 
                filters: userData.filters, 
                username: userData.username,
                avatar: userData.avatar
            });
        }
    });

    // Handle messages
    socket.on('send_message', (data) => {
        if (socket.roomId) {
            console.log(`[💬 MESSAGE] ${data.senderName} in ${socket.roomId}: ${data.text}`);
            socket.to(socket.roomId).emit('receive_message', {
                text: data.text,
                senderId: socket.id,
                senderName: data.senderName
            });
        }
    });

    // Handle typing status
    socket.on('typing', (isTyping) => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_typing', isTyping);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[❌ DISCONNECT] User ${socket.id} left.`);
        waitingQueue = waitingQueue.filter(u => u.socket.id !== socket.id);

        if (socket.roomId) {
            console.log(`[🚪 ROOM CLOSED] Notifying partner in ${socket.roomId}`);
            socket.to(socket.roomId).emit('partner_left');
            socket.leave(socket.roomId);
        }
    });
});

const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => res.status(200).send('OK'));

server.listen(PORT, () => {
    console.log(`[🚀 SERVER] Production-ready engine running on port ${PORT}`);
});
