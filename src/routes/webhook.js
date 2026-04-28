const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const { validateTwilioSignature } = require('../middleware/twilioValidator');
const { whatsappSenderLimiter } = require('../middleware/rateLimiter');
const { parseTextReport, parseVoiceReport, calculatePriorityScore } = require('../services/gemini');
const { downloadTwilioAudio, audioBufferToBase64, isVoiceMessage } = require('../services/audioHandler');
const {
  db,
  storeNeed,
  updateJobStatus,
  getPendingJobForWorker,
  getMatchedJobForWorker,
  lockJob,
  saveUserProfile,
  getUserProfile,
  findMatchingWorkers,
  markWorkersNotified,
  saveRating,
  logWebhookEvent,
} = require('../services/firestore');

const MessagingResponse = twilio.twiml.MessagingResponse;

// ── TWILIO CLIENT ─────────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── SESSION STORE ─────────────────────────────────────────────────
const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { step: 'NEW', role: null, tempData: {} });
  }
  return sessions.get(phone);
}

function setSession(phone, updates) {
  const current = getSession(phone);
  sessions.set(phone, { ...current, ...updates });
}

function clearSession(phone) {
  sessions.set(phone, { step: 'NEW', role: null, tempData: {} });
}

// ── SEND OUTBOUND MESSAGE ─────────────────────────────────────────
async function sendMessage(to, body) {
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to,
      body,
    });
    console.log(`Sent to ${to}: "${body.substring(0, 40)}..."`);
  } catch (err) {
    console.error(`Failed to send to ${to}:`, err.message);
  }
}

// ── BROADCAST JOB TO WORKERS ──────────────────────────────────────
async function broadcastJobToWorkers(jobId, skill, city, customerPhone) {
  const workers = await findMatchingWorkers(skill, city);

  if (workers.length === 0) {
    console.log(`No workers found for ${skill} in ${city}`);
    await sendMessage(
      customerPhone,
      `⚠️ Abhi ${city} mein *${skill}* available nahi hai.\n\n` +
      `Hum database expand kar rahe hain.\n` +
      `Job ID #${jobId.slice(-6)} save ho gayi hai — jaise hi worker mile, hum batayenge!`
    );
    return;
  }

  const workerPhones = workers.map(w => w.phone);
  await markWorkersNotified(jobId, workerPhones);

  for (const worker of workers) {
    await sendMessage(
      worker.phone,
      `🚨 *Naya Kaam Available!*\n\n` +
      `🛠️ Kaam: ${skill}\n` +
      `📍 Jagah: ${city}\n` +
      `⏰ Urgency: Abhi\n\n` +
      `Kaam lena hai?\n` +
      `✅ *HAAN* bhejein — Accept karne ke liye\n` +
      `❌ *NAHI* bhejein — Skip karne ke liye\n\n` +
      `⚡ Jaldi reply karein — pehle wale ko milega!\n` +
      `Job ID: #${jobId.slice(-6)}`
    );
    await new Promise(r => setTimeout(r, 600));
  }

  console.log(`Broadcasted job ${jobId} to ${workers.length} workers`);
}

// ── WELCOME MESSAGE ───────────────────────────────────────────────
function getWelcomeMessage() {
  return (
    `🙏 *Namaste! Main RozgarBot hoon.*\n\n` +
    `Ghar ka koi kaam karwana hai?\n` +
    `Ya kaam dhundh rahe hain?\n\n` +
    `Reply karein:\n` +
    `*1️⃣* — Mujhe kaam *karwana* hai (Customer)\n` +
    `*2️⃣* — Mujhe kaam *chahiye* (Worker)\n\n` +
    `_Voice Note 🎤 bhi bhej sakte hain!_`
  );
}

// ── GREETINGS ─────────────────────────────────────────────────────
const GREETINGS = ['hi', 'hello', 'hii', 'helo', 'namaste', 'namaskar',
                   'hey', 'start', 'help', 'menu'];

function isGreeting(msg) {
  return GREETINGS.includes(msg.toLowerCase().trim());
}

// ─────────────────────────────────────────────────────────────────
// MAIN WEBHOOK
// ─────────────────────────────────────────────────────────────────
router.post(
  '/whatsapp',
  validateTwilioSignature,
  whatsappSenderLimiter,
  async (req, res) => {
    const twiml = new MessagingResponse();
    const senderPhone = req.body.From;
    const messageBody = (req.body.Body || '').trim();
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const upperMsg = messageBody.toUpperCase().trim();

    const session = getSession(senderPhone);
    console.log(`[${senderPhone}] Step:${session.step} | "${messageBody.substring(0, 50)}"`);

    try {

      // ── GLOBAL COMMANDS ───────────────────────────────────────
      if (upperMsg === 'RESET' || upperMsg === 'MENU') {
        clearSession(senderPhone);
        twiml.message(getWelcomeMessage());
        return res.type('text/xml').send(twiml.toString());
      }

      if (upperMsg === 'BAND') {
        await saveUserProfile(senderPhone, { status: 'offline' });
        twiml.message(
          `✅ Notifications band kar diye.\n\n` +
          `Wapas shuru karne ke liye *SHURU* bhejein.`
        );
        return res.type('text/xml').send(twiml.toString());
      }

      if (upperMsg === 'SHURU') {
        await saveUserProfile(senderPhone, { status: 'available' });
        twiml.message('✅ Bahut accha! Ab aapko naye kaam ke notifications milenge. 🔔');
        return res.type('text/xml').send(twiml.toString());
      }

      // ── HAAN — Worker accepts job ─────────────────────────────
      if (upperMsg === 'HAAN') {
        const pendingJob = await getPendingJobForWorker(senderPhone);

        if (!pendingJob) {
          twiml.message(
            `Abhi koi pending kaam nahi hai.\n\n` +
            `Jab kaam aayega, hum turant message karenge! 🔔`
          );
          return res.type('text/xml').send(twiml.toString());
        }

        const success = await lockJob(pendingJob.id, senderPhone);

        if (success) {
          const workerProfile = await getUserProfile(senderPhone);
          const workerName = workerProfile?.name || 'Worker';
          const workerSkills = workerProfile?.skills?.join(', ') || 'Skilled worker';
          const workerRating = workerProfile?.rating || 5.0;
          const workerPhoneClean = senderPhone.replace('whatsapp:', '');

          // Notify customer
          await sendMessage(
            pendingJob.customer_phone,
            `🎉 *Kaam Pakka Ho Gaya!*\n\n` +
            `👤 *${workerName}*\n` +
            `🛠️ Skills: ${workerSkills}\n` +
            `📞 Number: ${workerPhoneClean}\n` +
            `⭐ Rating: ${workerRating}/5\n\n` +
            `Approximately 15-20 minute mein pahunch rahe hain.\n` +
            `Direct call karke rasta bata sakte hain. 🗺️`
          );

          const customerPhoneClean = pendingJob.customer_phone.replace('whatsapp:', '');
          twiml.message(
            `✅ *Kaam Confirm Ho Gaya!*\n\n` +
            `📍 Jagah: ${pendingJob.location}\n` +
            `🛠️ Kaam: ${pendingJob.skills?.[0] || pendingJob.job_description || 'Requested work'}\n` +
            `📞 Customer: ${customerPhoneClean}\n\n` +
            `*Abhi call karein aur nikal jaayein!* 🏃\n\n` +
            `Kaam khatam karne ke baad *DONE* likhein ✅`
          );

        } else {
          twiml.message(
            `😔 Yeh kaam kisi aur ko mil gaya.\n\n` +
            `Agle kaam ka intezaar karein — zaroor message karenge! 🔔`
          );
        }
        return res.type('text/xml').send(twiml.toString());
      }

      // ── NAHI — Worker skips job ───────────────────────────────
      if (upperMsg === 'NAHI') {
        twiml.message('Theek hai! Agle kaam ka intezaar karein. 👍');
        return res.type('text/xml').send(twiml.toString());
      }

      // ── DONE — Worker marks job complete ─────────────────────
      if (upperMsg === 'DONE') {
        const workerProfile = await getUserProfile(senderPhone);
        const matchedJob = await getMatchedJobForWorker(senderPhone);

        if (matchedJob) {
          await updateJobStatus(matchedJob.id, 'completed');

          // Ask customer for rating
          await sendMessage(
            matchedJob.customer_phone,
            `🙏 *RozgarBot — Feedback*\n\n` +
            `Kya *${workerProfile?.name || 'Worker'}* ne kaam accha kiya?\n\n` +
            `Rating dein (sirf number bhejein):\n` +
            `1️⃣ — Bahut bura\n` +
            `2️⃣ — Theek nahi\n` +
            `3️⃣ — Theek tha\n` +
            `4️⃣ — Accha tha\n` +
            `5️⃣ — Bahut accha!\n\n` +
            `_Aapka feedback bahut important hai_`
          );
        }

        twiml.message(
          `✅ *Kaam Khatam!*\n\n` +
          `Bahut accha kiya ${workerProfile?.name || 'bhai'}! 💪\n` +
          `Customer ko rating request bhej di gayi hai.\n\n` +
          `Agle kaam ke liye taiyaar rahein! 🔔`
        );
        return res.type('text/xml').send(twiml.toString());
      }

      // ── RATING — Customer gives rating 1-5 ───────────────────
      if (['1', '2', '3', '4', '5'].includes(messageBody.trim())) {
        const user = await getUserProfile(senderPhone);

        if (user?.role === 'customer') {
          const score = parseInt(messageBody);

          // Find most recent completed job for this customer
          try {
            const snapshot = await db.collection('jobs')
              .where('customer_phone', '==', senderPhone)
              .where('status', '==', 'completed')
              .orderBy('updated_at', 'desc')
              .limit(1)
              .get();

            if (!snapshot.empty) {
              const jobDoc = snapshot.docs[0];
              const jobData = jobDoc.data();
              if (jobData.accepted_by) {
                await saveRating(jobDoc.id, jobData.accepted_by, score);
              }
            }
          } catch (e) {
            console.error('Rating save error:', e.message);
          }

          const stars = '⭐'.repeat(score);
          twiml.message(
            `${stars} *${score}/5 — Dhanyawad!*\n\n` +
            `Aapka feedback worker ki madad karega. 🙏\n\n` +
            `_Dobara kaam ke liye "Hi" bhejein_`
          );
          return res.type('text/xml').send(twiml.toString());
        }
      }

      // ── STEP: NEW or GREETING ─────────────────────────────────
      if (session.step === 'NEW' || isGreeting(messageBody)) {
        const existingUser = await getUserProfile(senderPhone);

        if (existingUser?.role === 'worker') {
          setSession(senderPhone, { step: 'WORKER_MENU', role: 'worker' });
          twiml.message(
            `🙏 Wapas aaye *${existingUser.name}* bhai!\n\n` +
            `Aapki profile:\n` +
            `🛠️ Skills: ${existingUser.skills?.join(', ')}\n` +
            `📍 Area: ${existingUser.city || existingUser.location}\n` +
            `⭐ Rating: ${existingUser.rating}/5\n` +
            `✅ Kaam Kiye: ${existingUser.jobs_completed || 0}\n\n` +
            `Status: ${existingUser.status === 'available' ? '🟢 Available' : '🔴 Offline'}\n\n` +
            `_"BAND" — notifications band_\n` +
            `_"SHURU" — notifications shuru_\n` +
            `_"RESET" — menu_`
          );
          return res.type('text/xml').send(twiml.toString());
        }

        if (existingUser?.role === 'customer') {
          setSession(senderPhone, { step: 'CUSTOMER_SKILL', role: 'customer' });
          twiml.message(
            `🙏 Wapas aaye!\n\n` +
            `Konsa kaam karwana hai?\n` +
            `Voice Note 🎤 ya text mein batayein:\n\n` +
            `_"AC theek karna hai" ya "plumber chahiye Shankar Nagar mein"_`
          );
          return res.type('text/xml').send(twiml.toString());
        }

        clearSession(senderPhone);
        setSession(senderPhone, { step: 'CHOOSE_ROLE' });
        twiml.message(getWelcomeMessage());
        return res.type('text/xml').send(twiml.toString());
      }

      // ── STEP: CHOOSE ROLE ─────────────────────────────────────
      if (session.step === 'CHOOSE_ROLE') {
        const msg = messageBody.toLowerCase();

        if (messageBody === '1' || msg.includes('karwana') || msg.includes('customer') || msg.includes('chahiye kaam')) {
          setSession(senderPhone, { step: 'CUSTOMER_SKILL', role: 'customer' });
          twiml.message(
            `👍 Samajh gaye!\n\n` +
            `Konsa kaam karwana hai?\n` +
            `Voice Note 🎤 ya text mein batayein:\n\n` +
            `_"AC theek karna hai Civil Lines mein"_`
          );

        } else if (messageBody === '2' || msg.includes('chahiye') || msg.includes('worker') || msg.includes('kaam do')) {
          setSession(senderPhone, { step: 'WORKER_NAME', role: 'worker' });
          twiml.message(
            `💪 Bahut accha!\n\n` +
            `Pehle aapki profile banate hain.\n` +
            `Aapka *naam* kya hai?`
          );

        } else {
          twiml.message(
            `Kripya *1* ya *2* likhein:\n\n` +
            `*1* — Kaam karwana hai\n` +
            `*2* — Kaam chahiye`
          );
        }
        return res.type('text/xml').send(twiml.toString());
      }

      // ═══════════════════════════════════════════════════════════
      // WORKER REGISTRATION FLOW
      // ═══════════════════════════════════════════════════════════

      if (session.step === 'WORKER_NAME') {
        if (messageBody.length < 2) {
          twiml.message('Kripya apna sahi naam batayein.');
          return res.type('text/xml').send(twiml.toString());
        }
        setSession(senderPhone, {
          step: 'WORKER_SKILLS',
          tempData: { name: messageBody.trim() }
        });
        twiml.message(
          `${messageBody.trim()} bhai, *kya kaam* karte hain?\n\n` +
          `Ek ya zyada likh sakte hain:\n` +
          `_"AC mechanic" ya "Plumber, fridge repair"_\n\n` +
          `Voice Note 🎤 bhi bhej sakte hain`
        );
        return res.type('text/xml').send(twiml.toString());
      }

      if (session.step === 'WORKER_SKILLS') {
        let skillsText = messageBody;

        if (numMedia > 0 && isVoiceMessage(req.body)) {
          const { buffer, contentType } = await downloadTwilioAudio(req.body.MediaUrl0);
          const { base64Data, mimeType } = audioBufferToBase64(buffer, contentType);
          const parsed = await parseVoiceReport(base64Data, mimeType);
          skillsText = parsed.skills?.join(', ') || messageBody;
        }

        const skills = skillsText
          .toLowerCase()
          .split(/[,،\n\/]/)
          .map(s => s.trim())
          .filter(s => s.length > 1);

        if (skills.length === 0) {
          twiml.message('Kripya apna kaam batayein. Jaise: "Plumber" ya "AC mechanic"');
          return res.type('text/xml').send(twiml.toString());
        }

        setSession(senderPhone, {
          step: 'WORKER_LOCATION',
          tempData: { ...session.tempData, skills }
        });
        twiml.message(
          `✅ Skills: *${skills.join(', ')}*\n\n` +
          `📍 Aap *kahan* kaam karte hain?\n` +
          `City aur area batayein:\n\n` +
          `_"Civil Lines, Raipur" ya "Shankar Nagar"_`
        );
        return res.type('text/xml').send(twiml.toString());
      }

      if (session.step === 'WORKER_LOCATION') {
        if (messageBody.length < 3) {
          twiml.message('Kripya sahi location batayein. Jaise: "Civil Lines, Raipur"');
          return res.type('text/xml').send(twiml.toString());
        }

        const location = messageBody.trim();
        const parts = location.toLowerCase().split(',');
        const city = parts.length > 1
          ? parts[parts.length - 1].trim()
          : parts[0].trim();

        setSession(senderPhone, {
          step: 'WORKER_EXPERIENCE',
          tempData: { ...session.tempData, location, city }
        });
        twiml.message(
          `📍 Location: *${location}*\n\n` +
          `⭐ Kitne *saal ka experience* hai?\n` +
          `(Sirf number likhein, jaise: *5*)\n\n` +
          `_Naya hoon toh "0" likhein_`
        );
        return res.type('text/xml').send(twiml.toString());
      }

      if (session.step === 'WORKER_EXPERIENCE') {
        const exp = parseInt(messageBody) || 0;
        const { name, skills, location, city } = session.tempData;

        await saveUserProfile(senderPhone, {
          phone: senderPhone,
          name,
          role: 'worker',
          skills,
          location,
          city,
          experience_years: exp,
          rating: 5.0,
          rating_count: 0,
          jobs_completed: 0,
          status: 'available',
          created_at: new Date().toISOString(),
        });

        clearSession(senderPhone);
        setSession(senderPhone, { step: 'WORKER_MENU', role: 'worker' });

        twiml.message(
          `🎉 *Profile Ban Gayi ${name} bhai!*\n\n` +
          `✅ Naam: ${name}\n` +
          `🛠️ Skills: ${skills.join(', ')}\n` +
          `📍 Area: ${location}\n` +
          `⭐ Experience: ${exp} saal\n\n` +
          `Ab jab bhi aas-paas koi kaam aayega,\n` +
          `hum *turant message* karenge! 🔔\n\n` +
          `_"BAND" likhein notifications band karne ke liye_`
        );
        return res.type('text/xml').send(twiml.toString());
      }

      // ═══════════════════════════════════════════════════════════
      // CUSTOMER JOB POSTING FLOW
      // ═══════════════════════════════════════════════════════════

      if (session.step === 'CUSTOMER_SKILL' || session.role === 'customer') {

        let parsedReport = null;

        if (numMedia > 0 && isVoiceMessage(req.body)) {
          const { buffer, contentType } = await downloadTwilioAudio(req.body.MediaUrl0);
          const { base64Data, mimeType } = audioBufferToBase64(buffer, contentType);
          parsedReport = await parseVoiceReport(base64Data, mimeType);
        } else if (messageBody.length > 3) {
          parsedReport = await parseTextReport(messageBody);
        } else {
          twiml.message(
            `Kripya batayein konsa kaam chahiye?\n\n` +
            `_"AC theek karna hai Civil Lines mein"_`
          );
          return res.type('text/xml').send(twiml.toString());
        }

        if (!parsedReport || parsedReport.error || parsedReport.confidence < 0.5) {
          twiml.message(
            `⚠️ Samajh nahi aaya.\n\n` +
            `Kripya batayein:\n` +
            `• Konsa *kaam* chahiye?\n` +
            `• *Kahan* hai (area/mohalla)?\n\n` +
            `_"Mujhe plumber chahiye Shankar Nagar mein"_`
          );
          return res.type('text/xml').send(twiml.toString());
        }

        if (!parsedReport.location || parsedReport.location === 'null') {
          setSession(senderPhone, {
            step: 'CUSTOMER_LOCATION',
            role: 'customer',
            tempData: { parsedReport }
          });
          const skill = parsedReport.skills?.[0] || parsedReport.job_description || 'kaam';
          twiml.message(
            `✅ *${skill}* — samajh gaye!\n\n` +
            `📍 *Kahan* chahiye?\n` +
            `Apna area ya mohalla batayein:\n\n` +
            `_"Civil Lines" ya "Shankar Nagar, Raipur"_`
          );
          return res.type('text/xml').send(twiml.toString());
        }

        await postJobAndNotify(senderPhone, parsedReport, messageBody, twiml);
        setSession(senderPhone, { step: 'CUSTOMER_WAITING', role: 'customer' });
        return res.type('text/xml').send(twiml.toString());
      }

      if (session.step === 'CUSTOMER_LOCATION') {
        const location = messageBody.trim();
        const { parsedReport } = session.tempData;

        parsedReport.location = location;
        const parts = location.toLowerCase().split(',');
        parsedReport.city = parts.length > 1
          ? parts[parts.length - 1].trim()
          : parts[0].trim();

        await postJobAndNotify(senderPhone, parsedReport, location, twiml);
        setSession(senderPhone, { step: 'CUSTOMER_WAITING', role: 'customer' });
        return res.type('text/xml').send(twiml.toString());
      }

      // ── FALLBACK ──────────────────────────────────────────────
      twiml.message(
        `🤖 Samajh nahi aaya.\n\n` +
        `*MENU* likhein options dekhne ke liye\n` +
        `*RESET* likhein nayi shuruat ke liye`
      );
      return res.type('text/xml').send(twiml.toString());

    } catch (error) {
      console.error('Webhook error:', error);
      await logWebhookEvent('error', senderPhone, req.rawBody, {
        error: error.message,
      }).catch(() => {});

      twiml.message(
        `⚠️ System mein thodi dikkat aayi.\n` +
        `Kripya dobara try karein.\n` +
        `*RESET* likhein nayi shuruat ke liye 🙏`
      );
      return res.type('text/xml').send(twiml.toString());
    }
  }
);

// ── POST JOB + BROADCAST ──────────────────────────────────────────
async function postJobAndNotify(senderPhone, parsedReport, rawInput, twiml) {
  const priorityScore = calculatePriorityScore(parsedReport);
  const jobId = await storeNeed(parsedReport, priorityScore, senderPhone, rawInput);

  const existing = await getUserProfile(senderPhone);
  if (!existing) {
    await saveUserProfile(senderPhone, {
      phone: senderPhone,
      role: 'customer',
      jobs_posted: 1,
      created_at: new Date().toISOString(),
    });
  }

  const skill = parsedReport.skills?.[0] || parsedReport.job_description || 'kaam';
  const location = parsedReport.location || 'Aapke area mein';
  const city = parsedReport.city || location.toLowerCase().split(',').pop().trim();

  twiml.message(
    `✅ *Aapka request darj ho gaya!*\n\n` +
    `🛠️ Kaam: ${skill}\n` +
    `📍 Jagah: ${location}\n` +
    `🆔 Job ID: #${jobId.slice(-6)}\n\n` +
    `Hum aas-paas ke verified workers ko dhoondh rahe hain...\n` +
    `*2-5 minute* mein update milega! ⏳`
  );

  broadcastJobToWorkers(jobId, skill, city, senderPhone)
    .catch(err => console.error('Broadcast error:', err));
}

// ── STATUS WEBHOOK ────────────────────────────────────────────────
router.post('/status', (req, res) => {
  const { MessageSid, MessageStatus, To } = req.body;
  console.log(`[STATUS] ${MessageSid} → ${To}: ${MessageStatus}`);
  res.sendStatus(200);
});

module.exports = router;