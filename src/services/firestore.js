const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './firebase-service-account.json';
const serviceAccount = require(path.resolve(serviceAccountPath));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

const db = admin.firestore();

// ── JOBS ──────────────────────────────────────────────────────────

async function storeNeed(parsedReport, priorityScore, senderNumber, rawInput) {
  const jobData = {
    ...parsedReport,
    profile_score: priorityScore,
    customer_phone: senderNumber,
    raw_input: rawInput,
    status: 'open',
    notified_workers: [],
    accepted_by: null,
    matched_at: null,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };
  const docRef = await db.collection('jobs').add(jobData);
  console.log(`Stored job: ${docRef.id}`);
  return docRef.id;
}

async function updateJobStatus(jobId, status, workerPhone = null) {
  const update = {
    status,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (workerPhone) {
    update.accepted_by = workerPhone;
    update.matched_at = admin.firestore.FieldValue.serverTimestamp();
  }
  await db.collection('jobs').doc(jobId).update(update);
}

async function getJobById(jobId) {
  const doc = await db.collection('jobs').doc(jobId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function getPendingJobForWorker(workerPhone) {
  const snapshot = await db.collection('jobs')
    .where('status', '==', 'open')
    .where('notified_workers', 'array-contains', workerPhone)
    .orderBy('created_at', 'desc')
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function getMatchedJobForWorker(workerPhone) {
  const snapshot = await db.collection('jobs')
    .where('accepted_by', '==', workerPhone)
    .where('status', '==', 'matched')
    .orderBy('matched_at', 'desc')
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function lockJob(jobId, workerPhone) {
  const jobRef = db.collection('jobs').doc(jobId);
  let success = false;

  await db.runTransaction(async (transaction) => {
    const jobDoc = await transaction.get(jobRef);
    if (!jobDoc.exists) throw new Error('Job not found');
    if (jobDoc.data().status !== 'open') {
      success = false;
      return;
    }
    transaction.update(jobRef, {
      status: 'matched',
      accepted_by: workerPhone,
      matched_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    success = true;
  });

  return success;
}

async function markWorkersNotified(jobId, workerPhones) {
  await db.collection('jobs').doc(jobId).update({
    notified_workers: admin.firestore.FieldValue.arrayUnion(...workerPhones),
  });
}

// ── USERS ─────────────────────────────────────────────────────────

async function saveUserProfile(phone, data) {
  await db.collection('users').doc(phone).set({
    ...data,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function getUserProfile(phone) {
  const doc = await db.collection('users').doc(phone).get();
  if (!doc.exists) return null;
  return doc.data();
}

async function findMatchingWorkers(skill, city) {
  const normalizedSkill = skill.toLowerCase().trim();
  const normalizedCity = city.toLowerCase().trim();

  const snapshot = await db.collection('users')
    .where('role', '==', 'worker')
    .where('status', '==', 'available')
    .get();

  if (snapshot.empty) return [];

  const workers = [];
  snapshot.forEach(doc => {
    const data = doc.data();

    // City match
    const workerCity = (data.city || data.location || '').toLowerCase();
    const cityMatch = workerCity.includes(normalizedCity) ||
                      normalizedCity.includes(workerCity.split(',')[0].trim());
    if (!cityMatch) return;

    // Skill match
    const hasSkill = data.skills?.some(s =>
      s.toLowerCase().includes(normalizedSkill) ||
      normalizedSkill.includes(s.toLowerCase())
    );
    if (!hasSkill) return;

    workers.push({ id: doc.id, ...data });
  });

  // Sort by rating desc, then jobs_completed desc
  workers.sort((a, b) => {
    if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
    return (b.jobs_completed || 0) - (a.jobs_completed || 0);
  });

  return workers.slice(0, 5);
}

// ── RATINGS ───────────────────────────────────────────────────────

async function saveRating(jobId, workerPhone, score) {
  await db.collection('ratings').add({
    job_id: jobId,
    worker_phone: workerPhone,
    score,
    created_at: admin.firestore.FieldValue.serverTimestamp(),
  });

  const workerRef = db.collection('users').doc(workerPhone);
  await db.runTransaction(async (transaction) => {
    const workerDoc = await transaction.get(workerRef);
    if (!workerDoc.exists) return;
    const data = workerDoc.data();
    const currentRating = data.rating || 5.0;
    const ratingCount = data.rating_count || 0;
    const newCount = ratingCount + 1;
    const newRating = ((currentRating * ratingCount) + score) / newCount;
    transaction.update(workerRef, {
      rating: Math.round(newRating * 10) / 10,
      rating_count: newCount,
      jobs_completed: admin.firestore.FieldValue.increment(1),
    });
  });
}

// ── LOGGING ───────────────────────────────────────────────────────

async function logWebhookEvent(eventType, senderNumber, rawBody, processingResult) {
  await db.collection('webhook_logs').add({
    event_type: eventType,
    sender: senderNumber,
    raw_body: rawBody,
    result: processingResult,
    logged_at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

module.exports = {
  db,
  storeNeed,
  updateJobStatus,
  getJobById,
  getPendingJobForWorker,
  getMatchedJobForWorker,
  lockJob,
  markWorkersNotified,
  saveUserProfile,
  getUserProfile,
  findMatchingWorkers,
  saveRating,
  logWebhookEvent,
};