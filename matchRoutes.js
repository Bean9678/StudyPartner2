/**
 * matchRoutes.js — REST API endpoints
 *
 * Mounted at /api in server.js
 */

const { Router } = require('express');
const db = require('./db');

const router = Router();

// ─── UTILITY LOG ──────────────────────────────────────────────────────────────
function log(event, data) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${event}]`, data);
}

// ─── RATE LIMITER (Redis) ─────────────────────────────────────────────────────
function rateLimit(action, limit, windowMs) {
  return async (req, res, next) => {
    try {
      const key = `ratelimit:${req.ip}_${action}`;
      const current = await db.redis.incr(key);
      if (current === 1) {
        await db.redis.pexpire(key, windowMs);
      }
      if (current > limit) {
        return res.status(429).json({ error: 'Too many requests. Please slow down.' });
      }
      next();
    } catch (err) {
      console.error('Rate limit error:', err);
      // Fail open to avoid blocking legitimate traffic if Redis hiccups
      next();
    }
  };
}

// ─── PERSISTENT OFFLINE MATCHING API ────────────────────────────────────────

router.post('/start-search', async (req, res) => {
  try {
    const { uid, grade, subjects, gender } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid required' });
    
    // Add to background database queue securely
    // In production, we assume the user's socket is currently connected or they are dispatching rest.
    await db.addToQueue({ uid, grade, subjects, gender, socketId: null });
    log('USER_QUEUED_REST', { uid, queueSize: await db.getQueueSize() });
    
    return res.json({ success: true, message: 'Searching in background' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/cancel-search', async (req, res) => {
  try {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid required' });
    
    await db.removeFromQueue(uid);
    log('SEARCH_CANCELED_REST', { uid, queueSize: await db.getQueueSize() });
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.get('/check-match', async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'uid required' });
    
    const matches = await db.getMatchesForUser(uid);
    const match = matches.find(m => {
      if (m.users[0] === uid && m.deliveredToA === false) return true;
      if (m.users[1] === uid && m.deliveredToB === false) return true;
      return false;
    });
    
    if (match) {
      return res.json({ found: true, roomId: match.roomId });
    }
    return res.json({ found: false });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.post('/match-delivered', async (req, res) => {
  try {
    const { uid, roomId } = req.body;
    if (!uid || !roomId) return res.status(400).json({ error: 'uid/roomId required' });
    
    const match = await db.getRoomById(roomId);
    if (!match) return res.status(404).json({ error: 'Room not found' });
    
    if (match.users[0] === uid) match.deliveredToA = true;
    if (match.users[1] === uid) match.deliveredToB = true;
    await match.save();
    
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ─── GET /api/matches/:uid ────────────────────────────────────────────────────
router.get('/matches/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ error: 'uid is required' });

    const rawMatches = await db.getMatchesForUser(uid);

    const chatList = await Promise.all(rawMatches.map(async match => {
      let partnerInfo = null;
      
      if (match.type === 'private') {
        const partnerUid = match.users.find(u => u !== uid);
        const partner = await db.getUser(partnerUid) || { uid: partnerUid, username: 'Unknown' };
        partnerInfo = {
          uid: partner.uid,
          username: partner.username,
          avatar: partner.avatar || null,
          online: partner.online || false,
        };
      }

      return {
        matchId: match.matchId,
        roomId: match.roomId,
        type: match.type || 'private',
        name: match.name || null,
        createdAt: match.createdAt,
        lastMessage: match.lastMessage || null,
        partner: partnerInfo,
        users: match.users,
      };
    }));

    // Sort by lastMessage timestamp descending (most recent first)
    chatList.sort((a, b) => {
      const ta = a.lastMessage?.timestamp || a.createdAt;
      const tb = b.lastMessage?.timestamp || b.createdAt;
      return new Date(tb) - new Date(ta);
    });

    return res.json({ uid, matches: chatList });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

// ─── CHAT MANAGEMENT ────────────────────────────────────────────────────────

router.delete('/chat/:roomId', rateLimit('delete_chat', 5, 60000), async (req, res) => {
  try {
    const { roomId } = req.params;
    const { uid } = req.query;
    if (!uid) return res.status(401).json({ error: 'Unauthorized: missing uid' });
    const room = await db.getRoomById(roomId);
    if (!room || !room.users.includes(uid)) return res.status(403).json({ error: 'Unauthorized: not a member' });

    const success = await db.deleteChat(roomId);
    return res.json({ success });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

router.delete('/message/:messageId', rateLimit('delete_msg', 20, 60000), async (req, res) => {
  try {
    const { roomId, uid } = req.query;
    if (!roomId || !uid) return res.status(401).json({ error: 'roomId and uid query param required' });
    const room = await db.getRoomById(roomId);
    if (!room || !room.users.includes(uid)) return res.status(403).json({ error: 'Unauthorized: not a member' });

    const success = await db.deleteMessage(roomId, req.params.messageId);
    return res.json({ success });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

router.post('/block', async (req, res) => {
  try {
    const { fromUid, targetUid } = req.body;
    if (!fromUid || !targetUid) return res.status(400).json({ error: 'fromUid and targetUid required' });
    await db.blockUser(fromUid, targetUid);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

// ─── GROUPS ─────────────────────────────────────────────────────────────────

router.post('/groups', async (req, res) => {
  try {
    const { name, uid, members } = req.body;
    if (!uid || !members || !Array.isArray(members)) {
      return res.status(400).json({ error: 'uid and members array required' });
    }
    const group = await db.createGroupChat(name, uid, members);
    return res.json(group);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

// ─── MESSAGES & MEDIA ────────────────────────────────────────────────────────

router.get('/messages/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!roomId) return res.status(400).json({ error: 'roomId is required' });
    const history = await db.getMessages(roomId);
    return res.json({ roomId, messages: history });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

router.get('/search-messages', async (req, res) => {
  try {
    const { roomId, query } = req.query;
    if (!roomId || !query) return res.status(400).json({ error: 'roomId and query required' });
    const messages = await db.searchMessages(roomId, query);
    return res.json({ roomId, query, messages });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

router.get('/media/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const media = await db.getMediaForRoom(roomId);
    return res.json({ roomId, media });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

// ─── FRIENDS ──────────────────────────────────────────────────────────────────

router.post('/friend-request', rateLimit('friend_req', 10, 60000), async (req, res) => {
  try {
    const { fromUid, toUid } = req.body;
    if (!fromUid || !toUid) return res.status(400).json({ error: 'fromUid and toUid required' });
    await db.sendFriendRequest(fromUid, toUid);
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

router.post('/friend-accept', async (req, res) => {
  try {
    const { uid, fromUid } = req.body;
    if (!uid || !fromUid) return res.status(400).json({ error: 'uid and fromUid required' });
    const success = await db.acceptFriendRequest(uid, fromUid);
    return res.json({ success });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

router.get('/friends/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const friends = await db.getFriends(uid);
    const requestsRaw = await db.getFriendRequests(uid);
    
    const requests = requestsRaw.map(u => ({
      uid: u.uid, username: u.username, avatar: u.avatar
    }));
    return res.json({ uid, friends, requests });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

// ─── USERS & SEARCH ─────────────────────────────────────────────────────────

router.post('/check-username', async (req, res) => {
  try {
    const { username, uid } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    
    const userStr = username.trim();
    const existingUser = await db.getUserByUsername(userStr);
    const taken = existingUser !== null && existingUser.uid !== uid;
    
    return res.json({ available: !taken });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

router.get('/search', async (req, res) => {
  try {
    const { username, uid } = req.query;
    if (!username) return res.json({ users: [] });
    
    const qStr = username.toLowerCase();
    const allUsers = await db.getAllUsers();
    
    // Partial match on usernames & Filter blocks
    const matchedUsersPromises = allUsers.filter(u => {
      if (!u.username || !u.username.toLowerCase().includes(qStr)) return false;
      return true;
    }).map(async u => {
      if (uid && (u.uid === uid || await db.isBlocked(uid, u.uid))) return null;
      const { ...publicInfo } = u; // Ensure sensitive things like passwords are stripped if they exist
      return publicInfo;
    });

    const matchedUsers = (await Promise.all(matchedUsersPromises)).filter(Boolean);
    
    return res.json({ users: matchedUsers });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

router.post('/upload-avatar', async (req, res) => {
  try {
    const { uid, avatarUrl } = req.body;
    if (!uid || !avatarUrl) return res.status(400).json({ error: 'uid and avatarUrl required' });
    await db.upsertUser(uid, { avatar: avatarUrl });
    return res.json({ success: true, avatar: avatarUrl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

router.get('/user/:uid', async (req, res) => {
  try {
    const user = await db.getUser(req.params.uid);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

// ─── SYSTEM ──────────────────────────────────────────────────────────────────

router.get('/login-history/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ error: 'uid is required' });
    const history = await db.getLoginHistory(uid);
    return res.json({ uid, loginHistory: history });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

router.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

router.get('/debug/queue', async (_req, res) => {
  try {
    const size = await db.getQueueSize();
    res.json({ queueSize: size });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server Error' });
  }
});

module.exports = router;
