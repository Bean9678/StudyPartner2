/**
 * queueWorker.js — Decoupled Atomic Background Matcher
 * 
 * Runs independently to evaluate the queue.
 * Guarantees atomicity via Redis MULTI/EXEC transactions.
 * Prevents queue drift and includes idempotency keys.
 */

const { redis, createMatch, getUser } = require('./db');
const { v4: uuidv4 } = require('uuid');

let isMatching = false;
async function runBackgroundMatcher() {
  if (isMatching) return;
  isMatching = true;

  const workerId = uuidv4();
  const startTime = Date.now();
  let matchesCreated = 0;

  try {
    // 1. Acquire Distributed Lock (Auto-expires in 5s)
    const lock = await redis.set('matcher_lock', workerId, 'NX', 'PX', 5000);
    if (!lock) return;

    // Get up to 50 oldest users from ZSET
    const queueItems = await redis.zrange('match_queue', 0, 49);
    if (queueItems.length < 2) {
      await releaseLock(workerId);
      return;
    }

    const matchedUids = new Set();
    const toCreate = [];
    const driftRemovals = [];

    // Evaluate pairs
    for (let i = 0; i < queueItems.length; i++) {
      const elA = queueItems[i];
      const userA = JSON.parse(elA);
      
      if (matchedUids.has(userA.uid)) continue;
      
      // DRIFT FIX: Instant evaluation. If they aren't marked 'searching', expel from Queue memory
      const stateA = await redis.hget(`user_state:${userA.uid}`, 'state');
      if (stateA !== 'searching') {
        driftRemovals.push(elA);
        continue;
      }
      
      const userARecord = await getUser(userA.uid);
      if (!userARecord) continue;

      let bestMatch = null;
      let bestMatchEl = null;
      let highestScore = -1;

      for (let j = i + 1; j < queueItems.length; j++) {
        const elB = queueItems[j];
        const candidate = JSON.parse(elB);
        if (matchedUids.has(candidate.uid)) continue;

        if (!userA.subjects || !candidate.subjects) continue;

        const sharedSubjects = candidate.subjects.filter(s => userA.subjects.includes(s));
        if (sharedSubjects.length === 0) continue;

        let score = 0;
        
        const isOppositeGender = 
          (userA.gender === 'Nam' && candidate.gender === 'Nữ') || 
          (userA.gender === 'Nữ' && candidate.gender === 'Nam') ||
          (userA.gender === 'male' && candidate.gender === 'female') ||
          (userA.gender === 'female' && candidate.gender === 'male');
          
        if (isOppositeGender) score += 100;
        else score += 50; 
        
        if (userA.grade && candidate.grade === userA.grade) score += 20;
        score += sharedSubjects.length;

        const candidateRecord = await getUser(candidate.uid);
        if (candidateRecord?.blocks?.includes(userA.uid) || userARecord?.blocks?.includes(candidate.uid)) continue;

        if (score > highestScore) {
          highestScore = score;
          bestMatch = candidate;
          bestMatchEl = elB;
        }
      }

      if (bestMatch) {
        matchedUids.add(userA.uid);
        matchedUids.add(bestMatch.uid);
        toCreate.push({ uidA: userA.uid, uidB: bestMatch.uid, elA, elB: bestMatchEl });
      }
    }

    // Attempt Atomic Match Commits
    for (const matchSet of toCreate) {
      const { uidA, uidB, elA, elB } = matchSet;
      
      const keyA = `user_state:${uidA}`;
      const keyB = `user_state:${uidB}`;
      
      // WATCH the keys to prevent race conditions during transaction checking
      await redis.watch(keyA, keyB, 'match_queue');
      
      const stateA = await redis.hget(keyA, 'state');
      const stateB = await redis.hget(keyB, 'state');

      // Verify BOTH users are strictly still 'searching'
      if (stateA === 'searching' && stateB === 'searching') {
        
        // MULTI block guarantees ATOMIC execution
        const transactionResult = await redis.multi()
          .hset(keyA, 'state', 'matched')
          .hset(keyB, 'state', 'matched')
          .zrem('match_queue', elA, elB)
          .exec();
          
        // result is null if a watched key was modified elsewhere
        if (transactionResult) {
          const match = await createMatch(uidA, uidB);
          matchesCreated++;
          
          // IDEMPOTENCY FIX: Assign an eventId to deduplicate replays on UI
          const payload = JSON.stringify({
            eventId: uuidv4(),
            roomId: match.roomId,
            uids: [uidA, uidB]
          });
          
          // Pub/Sub standard emit
          await redis.publish('match_created', payload);
          
          // Pending Backup Fallback (RPUSH for FIFO chronological safety)
          const pA = redis.pipeline().rpush(`pending_events:${uidA}`, payload).ltrim(`pending_events:${uidA}`, -10, -1).expire(`pending_events:${uidA}`, 300).exec();
          const pB = redis.pipeline().rpush(`pending_events:${uidB}`, payload).ltrim(`pending_events:${uidB}`, -10, -1).expire(`pending_events:${uidB}`, 300).exec();
          await Promise.all([pA, pB]);
          
        } else {
          console.log(JSON.stringify({ event: 'MATCH_ABORTED_WATCH', uidA, uidB }));
        }
      } else {
        // Condition failed, unwatch
        await redis.unwatch();
      }
    }
    
    // Process identified queue drifters silently to self-heal the queue
    if (driftRemovals.length > 0) {
      await redis.zrem('match_queue', ...driftRemovals);
    }
    
    await releaseLock(workerId);
    
    // Structured JSON Observability
    if (matchesCreated > 0 || driftRemovals.length > 0) {
      console.log(JSON.stringify({
        metrics: 'queue_worker_cycle',
        durationMs: Date.now() - startTime,
        matchesCreated,
        driftersEvicted: driftRemovals.length
      }));
    }

  } catch (err) {
    console.error(JSON.stringify({ error: 'WORKER_FATAL', message: err.message }));
  } finally {
    isMatching = false;
  }
}

async function releaseLock(workerId) {
  try {
    await redis.releaseLockAtomic(1, 'matcher_lock', workerId);
  } catch (e) {
    console.error('[Worker] Failed releasing lock', e);
  }
}

function startWorker() {
  console.log('[Worker] Initializing ATOMIC queue matching worker...');
  setInterval(runBackgroundMatcher, 3000);
}

module.exports = { startWorker };
