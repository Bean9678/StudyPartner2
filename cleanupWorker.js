/**
 * cleanupWorker.js — Orphan scavenging and TTL resolution
 * 
 * Runs independently to sweep disconnected users that have outlived their grace period.
 * Continually sweeps the Queue for drift (ZSET inconsistencies).
 */

const { redis, transitionUser, getMatchesForUser } = require('./db');

let isSweepingDisconnected = false;
let isSweepingQueue = false;

// Removes users from the queue who are secretly not in 'searching' state anymore
async function sweepQueueDrift() {
  if (isSweepingQueue) return;
  isSweepingQueue = true;

  try {
    // Audit the 100 oldest users in the Queue
    const queueItems = await redis.zrange('match_queue', 0, 99);
    const toRemove = [];

    for (const elStr of queueItems) {
      const data = JSON.parse(elStr);
      const state = await redis.hget(`user_state:${data.uid}`, 'state');
      
      if (state !== 'searching') {
        toRemove.push(elStr);
        console.log(JSON.stringify({
          type: 'metrics',
          metric: 'drift_eviction',
          uid: data.uid,
          illegalStateFound: state
        }));
      }
    }

    if (toRemove.length > 0) {
      await redis.zrem('match_queue', ...toRemove);
    }
  } catch (err) {
    console.error(JSON.stringify({ error: 'QUEUE_SWEEP_FAILED', obj: err.message }));
  } finally {
    isSweepingQueue = false;
  }
}

async function sweepDisconnected() {
  if (isSweepingDisconnected) return;
  isSweepingDisconnected = true;

  try {
    const now = Date.now();
    // Get all UIDs whose multi-tab 30s TTL grace period has expired
    const uids = await redis.zrangebyscore('cleanup_sweep', '-inf', now);
    
    if (uids.length === 0) return;
    
    for (const uid of uids) {
      // Transition strictly to 'expired' only if they are STILL 'disconnected'
      const success = await transitionUser(uid, 'disconnected', 'expired');
      if (success) {
        console.log(JSON.stringify({
          type: 'metrics',
          metric: 'expired_sweep',
          uid
        }));
        
        // Notify any active partners that the room is dead
        const matches = await getMatchesForUser(uid);
        for (const match of matches) {
           await redis.publish('orphan_sweep_update', JSON.stringify({
             roomId: match.roomId,
             offlineUid: uid
           }));
        }
      }
      
      // Always remove from the ZSET to prevent repeated loops
      await redis.zrem('cleanup_sweep', uid);
    }
  } catch (err) {
    console.error(JSON.stringify({ error: 'DISCONNECT_SWEEP_FAILED', obj: err.message }));
  } finally {
    isSweepingDisconnected = false;
  }
}

function startCleanup() {
  console.log('[Worker] Initializing cleanup sweepers (Orphan & Drift)...');
  setInterval(sweepDisconnected, 10000); // Orphan GC every 10s
  setInterval(sweepQueueDrift, 30000);   // Drift GC every 30s
}

module.exports = { startCleanup };
