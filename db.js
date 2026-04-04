/**
 * db.js — Production-Grade Data Store with Redis Integration
 *
 * Mongoose: Persistent Data
 * Redis: Ephemeral State, Lua Atomic Scripts, Queue, Presence Tracking
 */

const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const Redis = require('ioredis');

// Connect Mongoose
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/chatApp')
  .then(() => console.log('[DB] MongoDB Connected'))
  .catch(err => console.error('[DB] MongoDB Connection Error:', err));

// Connect Redis — auto-detects TLS for Railway Redis (rediss://)
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const redisOptions = {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 10) {
      console.error('[DB] Redis: too many retries. Giving up.');
      return null; // Stop retrying
    }
    return Math.min(times * 200, 3000); // Exponential backoff capped at 3s
  },
  reconnectOnError(err) {
    // Reconnect on READONLY errors (common during Redis failover)
    return err.message.includes('READONLY');
  },
};

// Railway Redis uses rediss:// (TLS). Append tls: {} so ioredis negotiates SSL.
if (REDIS_URL.startsWith('rediss://')) {
  redisOptions.tls = { rejectUnauthorized: false };
}

const redis = new Redis(REDIS_URL, redisOptions);
redis.on('connect', () => console.log('[DB] Redis Connected:', REDIS_URL.replace(/:[^:@]+@/, ':***@')));
redis.on('error', (err) => console.error('[DB] Redis Error:', err.message));

// ─── LUA SCRIPTS (ATOMIC GUARANTEES) ─────────────────────────────────────────

redis.defineCommand('transitionUserAtomic', {
  numberOfKeys: 1,
  lua: `
    local stateKey = KEYS[1]
    local expectedState = ARGV[1]
    local newState = ARGV[2]
    
    local currentState = redis.call("HGET", stateKey, "state")
    
    if expectedState ~= "" and currentState ~= expectedState then
      return 0
    end
    
    redis.call("HSET", stateKey, "state", newState)
    return 1
  `
});

redis.defineCommand('releaseLockAtomic', {
  numberOfKeys: 1,
  lua: `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `
});

// ─── MONGOOSE SCHEMAS ──────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true },
  username: String,
  grade: String,
  subjects: [String],
  gender: String,
  avatar: String,
  friends: [String],
  blocks: [String],
  friendRequests: [String],
  loginHistory: [{ timestamp: String, device: String, ip: String }]
});
const User = mongoose.model('User', userSchema);

const matchSchema = new mongoose.Schema({
  matchId: { type: String, required: true, unique: true },
  users: [String],
  roomId: { type: String, required: true, unique: true },
  type: { type: String, default: 'private' },
  name: String, 
  deliveredToA: { type: Boolean, default: false },
  deliveredToB: { type: Boolean, default: false },
  createdAt: { type: Number, default: Date.now },
  lastMessage: { text: String, timestamp: String, senderUid: String },
  messages: [{
    id: String,
    senderUid: String,
    senderName: String,
    type: { type: String },
    text: String,
    fileUrl: String,
    mimeType: String,
    fileName: String,
    timestamp: String
  }]
});
const Match = mongoose.model('Match', matchSchema);

// ─── PRESENCE HELPERS (MESSENGER-STYLE) ──────────────────────────────────────

async function setPresenceOnline(uid) {
  const connections = await redis.incr(`presence:${uid}:connections`);
  
  if (connections === 1) { // First tab opened
    await redis.hset(`presence:${uid}`, 'status', 'online', 'lastSeen', Date.now());
    const friends = await getFriends(uid);
    const friendUids = friends.map(f => f.uid);
    
    await redis.publish('presence_update', JSON.stringify({
      uid,
      status: 'online',
      lastSeen: Date.now(),
      deliverTo: friendUids
    }));
  }
}

async function setPresenceOfflineDelayed(uid) {
  const connections = await redis.decr(`presence:${uid}:connections`);
  
  // Safely zero-bound the multi-tab connection tracker
  if (connections < 0) {
    await redis.set(`presence:${uid}:connections`, 0);
  }
  
  if (connections <= 0) { // All tabs closed
    const ts = Date.now();
    await redis.hset(`presence:${uid}`, 'status', 'offline', 'lastSeen', ts);
    const friends = await getFriends(uid);
    const friendUids = friends.map(f => f.uid);
    
    await redis.publish('presence_update', JSON.stringify({
      uid,
      status: 'offline',
      lastSeen: ts,
      deliverTo: friendUids
    }));
    return true; // Formally went offline
  }
  return false; // Still has active tabs
}

async function getPresence(uid) {
  const presence = await redis.hgetall(`presence:${uid}`);
  return {
    status: presence.status || 'offline',
    lastSeen: presence.lastSeen ? parseInt(presence.lastSeen, 10) : null
  };
}

// ─── USER HELPERS (Mongo + Redis State) ──────────────────────────────────────

async function upsertUser(uid, data) {
  let user = await User.findOne({ uid });
  const avatar = data.avatar || user?.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(data.username || 'Unknown')}&background=random`;
  
  const updateData = { ...data, uid, avatar };
  if (data.socketId) {
    await transitionUser(uid, '', 'connected');
    await redis.hset(`user_state:${uid}`, 'socketId', data.socketId);
    await redis.persist(`user_state:${uid}`); // Memory opt: Clear 24h disconnected expiry
    await redis.set(`socket_mapping:${data.socketId}`, uid, 'EX', 86400); 
    await redis.zrem('cleanup_sweep', uid);
    await setPresenceOnline(uid);
  }

  user = await User.findOneAndUpdate(
    { uid },
    { $set: updateData },
    { upsert: true, new: true }
  );
  return user;
}

async function getUser(uid) {
  const user = await User.findOne({ uid }).lean();
  if (!user) return null;
  const stateData = await redis.hgetall(`user_state:${uid}`);
  const presence = await getPresence(uid);
  
  return { 
    ...user, 
    ...stateData,
    presence
  };
}

async function getUserByUsername(username) {
  if (!username) return null;
  return await User.findOne({ username: new RegExp('^' + username + '$', 'i') }).lean();
}

async function setSocketId(uid, socketId) {
  await transitionUser(uid, '', 'connected');
  await redis.hset(`user_state:${uid}`, 'socketId', socketId);
  await redis.persist(`user_state:${uid}`);
  await redis.set(`socket_mapping:${socketId}`, uid, 'EX', 86400);
  await redis.zrem('cleanup_sweep', uid);
  await setPresenceOnline(uid);
}

async function setOffline(socketId) {
  const uid = await redis.get(`socket_mapping:${socketId}`);
  if (uid) {
    const formallyOffline = await setPresenceOfflineDelayed(uid);
    
    if (formallyOffline) {
      await transitionUser(uid, '', 'disconnected');
      await redis.hdel(`user_state:${uid}`, 'socketId');
      await redis.zadd('cleanup_sweep', Date.now() + 30000, uid);
      // Redis Memory Limit Constraint (expire stale user_state chunks after 24h logic)
      await redis.expire(`user_state:${uid}`, 86400); 
    }
    await redis.del(`socket_mapping:${socketId}`);
    return { uid };
  }
  return null;
}

async function getUserBySocketId(socketId) {
  const uid = await redis.get(`socket_mapping:${socketId}`);
  if (!uid) return null;
  return await getUser(uid);
}

async function getAllUsers() {
  return await User.find({}).lean();
}

async function recordLogin(uid, data) {
  await User.updateOne(
    { uid }, 
    { $push: { loginHistory: { timestamp: new Date().toISOString(), ...data } } }
  );
}

async function getLoginHistory(uid) {
  const u = await User.findOne({ uid }).lean();
  return u?.loginHistory || [];
}

// ─── STATE MACHINE ────────────────────────────────────────────────────────────

async function transitionUser(uid, expectedState, newState) {
  const result = await redis.transitionUserAtomic(
    1,
    `user_state:${uid}`,
    expectedState || "", 
    newState
  );
  return result === 1;
}

// Recovers a user stuck formally as "matched" but with no actively bound socket room
async function recoverFailsafe(uid) {
  const state = await redis.hget(`user_state:${uid}`, 'state');
  if (state === 'matched') {
    const matches = await getMatchesForUser(uid);
    const activeRoom = matches.find(m => {
       if (m.users[0] === uid && m.deliveredToA === false) return true;
       if (m.users[1] === uid && m.deliveredToB === false) return true;
       return false;
    });
    
    if (!activeRoom) {
      console.log(JSON.stringify({ event: 'STATE_RECOVERY', uid, description: 'Resetting bugged matched user to connected' }));
      await redis.hset(`user_state:${uid}`, 'state', 'connected');
      return true;
    }
  }
  return false;
}

// ─── QUEUE MATCHING (Redis) ───────────────────────────────────────────────────

async function addToQueue(queueData) {
  const success = await transitionUser(queueData.uid, '', 'searching');
  if (!success) return false;
  
  const payload = JSON.stringify(queueData);
  await redis.zadd('match_queue', Date.now(), payload);
  return true;
}

async function removeFromQueue(uid) {
  const success = await transitionUser(uid, 'searching', 'connected');
  if (!success) return; 

  const elements = await redis.zrange('match_queue', 0, -1);
  for (const el of elements) {
    const data = JSON.parse(el);
    if (data.uid === uid) {
      await redis.zrem('match_queue', el);
      break;
    }
  }
}

async function getQueueSize() {
  return await redis.zcard('match_queue');
}

// ─── MATCHES & GROUPS & ROOMS (MongoDB) ───────────────────────────────────────

async function createMatch(uidA, uidB) {
  const matchId = uuidv4();
  const roomId = `room_${uuidv4()}`;
  
  const record = new Match({
    matchId,
    roomId,
    type: 'private',
    users: [uidA, uidB],
    messages: []
  });
  await record.save();
  return record;
}

async function createGroupChat(name, creatorUid, memberUids) {
  const groupId = uuidv4();
  const roomId = `group_${groupId}`;
  const allMembers = Array.from(new Set([creatorUid, ...memberUids]));
  
  const record = new Match({
    matchId: groupId,
    roomId,
    type: 'group',
    name: name || 'Group Chat',
    users: allMembers,
    messages: []
  });
  await record.save();
  return record;
}

async function getMatchByPair(uidA, uidB) {
  return await Match.findOne({ users: { $all: [uidA, uidB], $size: 2 }, type: 'private' });
}

async function getRoomById(roomId) {
  return await Match.findOne({ roomId });
}

async function getMatchesForUser(uid) {
  return await Match.find({ users: uid }).sort({ 'lastMessage.timestamp': -1, createdAt: -1 });
}

async function deleteChat(roomId) {
  const res = await Match.deleteOne({ roomId });
  return res.deletedCount > 0;
}

// ─── MESSAGES & MEDIA (MongoDB Sync) ─────────────────────────────────────────

async function saveMessage(roomId, payload) {
  const msg = {
    id: uuidv4(),
    senderUid: payload.senderUid,
    senderName: payload.senderName,
    type: payload.type || 'text',
    text: payload.text || null,
    fileUrl: payload.fileUrl || null,
    mimeType: payload.mimeType || null,
    fileName: payload.fileName || null,
    timestamp: new Date().toISOString(),
  };

  const txtPreview = msg.type === 'text' ? msg.text : `[${msg.type}]`;
  
  await Match.updateOne({ roomId }, {
    $push: { messages: msg },
    $set: {
      lastMessage: {
        text: txtPreview,
        timestamp: msg.timestamp,
        senderUid: msg.senderUid
      }
    }
  });

  return { ...msg, roomId };
}

async function getMessages(roomId) {
  const match = await Match.findOne({ roomId }, { messages: 1 }).lean();
  return match?.messages || [];
}

async function searchMessages(roomId, query) {
  const match = await Match.findOne({ roomId }, { messages: 1 }).lean();
  if (!match) return [];
  const qStr = query.toLowerCase();
  return match.messages.filter(m => m.text && m.text.toLowerCase().includes(qStr));
}

async function deleteMessage(roomId, messageId) {
  const res = await Match.updateOne(
    { roomId },
    { $pull: { messages: { id: messageId } } }
  );
  return res.modifiedCount > 0;
}

async function getMediaForRoom(roomId) {
  const match = await Match.findOne({ roomId }, { messages: 1 }).lean();
  if (!match) return [];
  return match.messages.filter(m => m.fileUrl != null);
}

// ─── FRIENDS & BLOCKS (MongoDB) ───────────────────────────────────────────────

async function sendFriendRequest(fromUid, toUid) {
  await User.updateOne({ uid: toUid }, { $addToSet: { friendRequests: fromUid } });
}

async function acceptFriendRequest(uid, requestFromUid) {
  const res = await User.updateOne(
    { uid, friendRequests: requestFromUid },
    { 
      $pull: { friendRequests: requestFromUid },
      $addToSet: { friends: requestFromUid }
    }
  );
  if (res.modifiedCount > 0) {
    await User.updateOne({ uid: requestFromUid }, { $addToSet: { friends: uid } });
    return true;
  }
  return false;
}

async function getFriends(uid) {
  const u = await User.findOne({ uid }).lean();
  if (!u || !u.friends) return [];
  return await User.find({ uid: { $in: u.friends } }).lean();
}

async function blockUser(fromUid, targetUid) {
  await User.updateOne({ uid: fromUid }, { 
    $addToSet: { blocks: targetUid },
    $pull: { friends: targetUid }
  });
  await User.updateOne({ uid: targetUid }, { $pull: { friends: fromUid } });
}

async function isBlocked(uidA, uidB) {
  const a = await User.findOne({ uid: uidA }, { blocks: 1 }).lean();
  const b = await User.findOne({ uid: uidB }, { blocks: 1 }).lean();
  return (a?.blocks?.includes(uidB)) || (b?.blocks?.includes(uidA));
}

async function getFriendRequests(uid) {
  const u = await User.findOne({ uid }).lean();
  if (!u || !u.friendRequests) return [];
  return await User.find({ uid: { $in: u.friendRequests } }).lean();
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  redis,
  upsertUser, getUser, getUserByUsername, setSocketId, setOffline, getUserBySocketId, getAllUsers, getLoginHistory, recordLogin,
  getPresence, setPresenceOnline, setPresenceOfflineDelayed,
  transitionUser, recoverFailsafe, addToQueue, removeFromQueue, getQueueSize,
  createMatch, createGroupChat, getMatchByPair, getRoomById, getMatchesForUser, deleteChat,
  saveMessage, getMessages, searchMessages, deleteMessage, getMediaForRoom,
  sendFriendRequest, acceptFriendRequest, getFriends, getFriendRequests, blockUser, isBlocked,
};
