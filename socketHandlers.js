/**
 * socketHandlers.js — Socket.io handlers + Redis Pub/Sub Fallbacks
 * 
 * Ensures idempotency and safe recovery for real-time operations.
 */

const db = require('./db');
const Redis = require('ioredis');

// Secondary Redis client for Subscriptions
const subClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

function logMetric(metric, data) {
  console.log(JSON.stringify({ type: 'metrics', metric, ...data, timestamp: new Date().toISOString() }));
}

// Global Idempotency Tracker
async function isEventDelivered(eventId) {
  if (!eventId) return false;
  // Atomically check and reserve the eventId delivery slot for 24 hours
  const result = await db.redis.set(`delivered:${eventId}`, 1, 'NX', 'EX', 86400);
  return result !== 'OK'; // return true if it WAS delivered already
}

function attachHandlers(io) {

  // ─── REDIS PUB/SUB ───────────────────────────────────────────────────────────
  subClient.subscribe('match_created', 'presence_update', 'orphan_sweep_update');
  
  subClient.on('message', async (channel, message) => {
    try {
      const data = JSON.parse(message);
      
      if (channel === 'match_created') {
        const { eventId, uids, roomId } = data;
        
        // Ensure we don't spam multiple pods with the exact same event
        if (await isEventDelivered(eventId)) {
          logMetric('duplicate_event_suppressed', { eventId, channel: 'pubsub' });
          return;
        }

        for (const uid of uids) {
          const userState = await db.getUser(uid);
          if (userState && userState.socketId) {
            io.to(userState.socketId).emit('partner_found', { roomId });
            logMetric('REALTIME_DELIVERED', { eventId, uid, roomId });
          }
        }
      } 
      else if (channel === 'presence_update') {
        if (data.deliverTo && data.deliverTo.length > 0) {
          for (const friendUid of data.deliverTo) {
            const friendState = await db.getUser(friendUid);
            if (friendState && friendState.socketId) {
              io.to(friendState.socketId).emit('friend_presence_changed', {
                uid: data.uid,
                status: data.status,
                lastSeen: data.lastSeen
              });
            }
          }
        }
      }
      else if (channel === 'orphan_sweep_update') {
        io.to(data.roomId).emit('partner_offline_final', { uid: data.offlineUid });
        logMetric('ORPHAN_SWEEP_EMITTED', data);
      }
    } catch (e) {
      console.error(JSON.stringify({ error: 'PUBSUB_FAILED', obj: e.message }));
    }
  });

  // ─── SOCKET CONNECTION ───────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    logMetric('USER_CONNECTED', { socketId: socket.id, ip: socket.handshake.address });

    // ── register & reconnect ─────────────────────────────────────────────────
    socket.on('register', async (data) => {
      try {
        if (!data?.uid) return;
        const { uid, username, avatar, device } = data;

        // 1. Establish precise presence securely in Redis
        await db.upsertUser(uid, { uid, username, avatar, socketId: socket.id, online: true });
        socket.data.uid = uid; 
        
        await db.recordLogin(uid, { device: device || 'unknown', ip: socket.handshake.address });
        logMetric('USER_REGISTERED', { uid, socketId: socket.id });

        // 2. Safe Event Replay (Idempotency deduplicated FIFO buffer)
        const pendingEvents = await db.redis.lrange(`pending_events:${uid}`, 0, -1);
        if (pendingEvents && pendingEvents.length > 0) {
          for (const evStr of pendingEvents) {
            const ev = JSON.parse(evStr);
            if (await isEventDelivered(ev.eventId)) {
              logMetric('duplicate_event_suppressed', { eventId: ev.eventId, channel: 'pending_replay' });
              continue;
            }
            // Replay legitimately missed events
            socket.emit('partner_found', { roomId: ev.roomId, fallback: true });
            logMetric('REPLAYED_CACHED_EVENT', { uid, eventId: ev.eventId, roomId: ev.roomId });
          }
          await db.redis.del(`pending_events:${uid}`); // Clear the queue after safe iteration
        }

        // 3. Failsafe Match Recovery Hook
        // Handles extreme edge cases where user transitions to 'matched' but DB crashes
        await db.recoverFailsafe(uid);

      } catch (e) {
        console.error(JSON.stringify({ error: 'REGISTER_FAILED', obj: e.message }));
      }
    });

    socket.on('cancel_search', async () => {
      try {
        const user = await db.getUserBySocketId(socket.id);
        const uid = user ? user.uid : socket.data?.uid;
        if (!uid) return;
        
        await db.removeFromQueue(uid);
        logMetric('SEARCH_CANCELED', { uid });
      } catch (e) {}
    });

    socket.on('join_room', async ({ roomId, uid } = {}) => {
      try {
        if (!roomId || !uid) return;
        socket.join(roomId);
        logMetric('JOIN_ROOM', { socketId: socket.id, uid, roomId });

        const history = await db.getMessages(roomId);
        socket.emit('message_history', { roomId, messages: history });
      } catch (e) {}
    });

    socket.on('send_message', async (data = {}) => {
      try {
        const { roomId, senderUid, senderName, text } = data;
        if (!roomId || !senderUid || !text?.trim()) return;

        const msg = await db.saveMessage(roomId, {
          senderUid, senderName, type: 'text', text: text.trim(),
        });

        io.in(roomId).emit('receive_message', msg);
      } catch (e) {}
    });

    socket.on('send_file', async (data = {}) => {
      try {
        const { roomId, senderUid, senderName, fileUrl, mimeType, fileName } = data;
        if (!roomId || !senderUid || !fileUrl) return;

        let type = 'file';
        if (mimeType?.startsWith('image/')) type = 'image';
        else if (mimeType?.startsWith('video/')) type = 'video';

        const msg = await db.saveMessage(roomId, {
          senderUid, senderName, type, fileUrl, mimeType, fileName,
        });

        io.in(roomId).emit('receive_message', msg);
      } catch (e) {}
    });

    socket.on('typing', ({ roomId, uid, isTyping } = {}) => {
      if (!roomId || !uid) return;
      socket.to(roomId).emit('partner_typing', { uid, isTyping });
    });

    // ─────────────────────── WebRTC Signaling ───────────────────────────────

    socket.on('call_user', async (data = {}) => {
      try {
        const { callerUid, targetUid, roomId, callerName, callerAvatar } = data;
        if (!targetUid || !callerUid) return;

        const target = await db.getUser(targetUid);
        if (target?.socketId && target?.presence?.status === 'online') {
          io.to(target.socketId).emit('incoming_call', {
            callerUid, callerName, callerAvatar, roomId, callerSocketId: socket.id,
          });
          logMetric('CALL_INITIATED', { callerUid, targetUid, roomId });
        } else {
          socket.emit('call_failed', { reason: 'User is offline' });
        }
      } catch (e) {}
    });

    socket.on('accept_call', ({ callerSocketId, accepterUid } = {}) => {
      if (!callerSocketId) return;
      io.to(callerSocketId).emit('call_accepted', { accepterUid, accepterSocketId: socket.id });
    });

    socket.on('reject_call', ({ callerSocketId, reason } = {}) => {
      if (!callerSocketId) return;
      io.to(callerSocketId).emit('call_rejected', { reason: reason || 'User declined' });
    });

    socket.on('end_call', ({ targetSocketId } = {}) => {
      if (!targetSocketId) return;
      io.to(targetSocketId).emit('call_ended');
    });

    socket.on('offer', ({ targetSocketId, sdp } = {}) => {
      if (!targetSocketId || !sdp) return;
      io.to(targetSocketId).emit('offer', { sdp, fromSocketId: socket.id });
    });

    socket.on('answer', ({ targetSocketId, sdp } = {}) => {
      if (!targetSocketId || !sdp) return;
      io.to(targetSocketId).emit('answer', { sdp, fromSocketId: socket.id });
    });

    socket.on('ice-candidate', ({ targetSocketId, candidate } = {}) => {
      if (!targetSocketId || !candidate) return;
      io.to(targetSocketId).emit('ice-candidate', { candidate, fromSocketId: socket.id });
    });

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', async (reason) => {
      try {
        // Triggers multi-tab presence rules
        const uidTracker = await db.setOffline(socket.id);
        const uid = uidTracker ? uidTracker.uid : socket.data?.uid;
        
        logMetric('USER_DISCONNECTED', { socketId: socket.id, uid, reason });
        if (!uid) return;

        const userMatches = await db.getMatchesForUser(uid);
        for (const match of userMatches) {
          socket.to(match.roomId).emit('partner_offline_temporary', { uid });
        }
      } catch (e) {}
    });
  });
}

module.exports = { attachHandlers };
