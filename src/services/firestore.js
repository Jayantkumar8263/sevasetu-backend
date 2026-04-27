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

async function storeNeed(parsedReport, priorityScore, senderNumber, rawInput) {
  const needData = {
    ...parsedReport,
    priority_score: priorityScore,
    sender_number: senderNumber,
    raw_input: rawInput,
    status: 'open',
    reported_at: admin.firestore.FieldValue.serverTimestamp(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
    assigned_volunteer_id: null,
    assigned_at: null,
  };

  const docRef = await db.collection('needs').add(needData);
  console.log(`Stored need: ${docRef.id}, priority: ${priorityScore}`);
  return docRef.id;
}

async function logWebhookEvent(eventType, senderNumber, rawBody, processingResult) {
  await db.collection('webhook_logs').add({
    event_type: eventType,
    sender: senderNumber,
    raw_body: rawBody,
    result: processingResult,
    logged_at: admin.firestore.FieldValue.serverTimestamp(),
  });
}

module.exports = { storeNeed, logWebhookEvent };