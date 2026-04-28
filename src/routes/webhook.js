const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const { validateTwilioSignature } = require('../middleware/twilioValidator');
const { whatsappSenderLimiter } = require('../middleware/rateLimiter');
const { parseTextReport, parseVoiceReport, calculatePriorityScore } = require('../services/gemini');
const { downloadTwilioAudio, audioBufferToBase64, isVoiceMessage } = require('../services/audioHandler');
const { storeNeed, logWebhookEvent } = require('../services/firestore');

const MessagingResponse = twilio.twiml.MessagingResponse;

// Track first-time users in memory (resets on server restart — fine for hackathon)
const seenUsers = new Set();

// Greetings that trigger onboarding
const GREETING_TRIGGERS = ['hi', 'hello', 'hii', 'helo', 'namaste', 'namaskar', 'hey', 'start', 'help'];

router.post(
  '/whatsapp',
  validateTwilioSignature,
  whatsappSenderLimiter,
  async (req, res) => {
    const twiml = new MessagingResponse();
    const senderNumber = req.body.From;
    const messageBody = (req.body.Body || '').trim();
    const numMedia = parseInt(req.body.NumMedia || '0', 10);

    console.log(`Incoming from ${senderNumber}: "${messageBody.substring(0, 60)}"`);

    try {

      // ── SCENARIO 1: ONBOARDING ────────────────────────────────
      // First time user OR sending a greeting
      const isGreeting = GREETING_TRIGGERS.includes(messageBody.toLowerCase());
      const isFirstTime = !seenUsers.has(senderNumber);

      if (isGreeting || (isFirstTime && numMedia === 0 && messageBody.length < 20)) {
        seenUsers.add(senderNumber);

        twiml.message(
          `🙏 Namaste! Main RozgarBot hoon. Aapko kaam chahiye (Worker) ya kaam karwana hai (Customer)?\n\n` +
          `Bina type kiye, sirf Voice Note 🎤 bhejein aur batayein!\n\n` +
          `(Udaharan: "Mujhe ghar paint karwana hai Shankar Nagar mein" ya "Main plumber hoon, kaam chahiye")`
        );
        return res.type('text/xml').send(twiml.toString());
      }

      // Mark user as seen
      seenUsers.add(senderNumber);

      let parsedReport;
      let rawInput;
      let eventType;

      // ── VOICE NOTE PATH ───────────────────────────────────────
      if (numMedia > 0 && isVoiceMessage(req.body)) {
        const mediaUrl = req.body.MediaUrl0;
        const mediaContentType = req.body.MediaContentType0;

        console.log(`Processing voice note: ${mediaUrl}`);

        const { buffer, contentType } = await downloadTwilioAudio(mediaUrl);
        const { base64Data, mimeType } = audioBufferToBase64(buffer, contentType);

        parsedReport = await parseVoiceReport(base64Data, mimeType);
        rawInput = '[voice note]';
        eventType = 'voice';

      // ── TEXT MESSAGE PATH ─────────────────────────────────────
      } else if (messageBody.length > 0) {
        parsedReport = await parseTextReport(messageBody);
        rawInput = messageBody;
        eventType = 'text';

      } else {
        // Empty or unsupported message type
        twiml.message(
          `🙏 Namaste! Main RozgarBot hoon. Aapko kaam chahiye (Worker) ya kaam karwana hai (Customer)?\n\n` +
          `Bina type kiye, sirf Voice Note 🎤 bhejein aur batayein!\n\n` +
          `(Udaharan: "Mujhe ghar paint karwana hai Shankar Nagar mein" ya "Main plumber hoon, kaam chahiye")`
        );
        return res.type('text/xml').send(twiml.toString());
      }

      // ── SCENARIO 3: LOW CONFIDENCE / FALLBACK ────────────────
      if (parsedReport.error || parsedReport.confidence < 0.7) {

        // Check specifically if location is missing
        const hasSkill = parsedReport.skills?.length > 0 || parsedReport.job_description;
        const hasLocation = parsedReport.location && parsedReport.location !== 'null';

        if (hasSkill && !hasLocation) {
          await logWebhookEvent('low_confidence_no_location', senderNumber, req.rawBody, parsedReport);
          twiml.message(
            `⚠️ Maaf kijiyega, mujhe theek se samajh nahi aaya.\n\n` +
            `Aapne kaam toh bataya, par jagah (Location) nahi sunai di. ` +
            `Kripya ek naya Voice Note 🎤 bhej kar apna Pata (Address) batayein.`
          );
        } else {
          await logWebhookEvent('low_confidence', senderNumber, req.rawBody, parsedReport);
          twiml.message(
            `⚠️ Maaf kijiyega, mujhe theek se samajh nahi aaya.\n\n` +
            `Aapne kaam toh bataya, par jagah (Location) nahi sunai di. ` +
            `Kripya ek naya Voice Note 🎤 bhej kar apna Pata (Address) batayein.`
          );
        }
        return res.type('text/xml').send(twiml.toString());
      }

      // ── SCENARIO 2: HIGH CONFIDENCE — STORE AND CONFIRM ──────
      const priorityScore = calculatePriorityScore(parsedReport);
      const jobId = await storeNeed(parsedReport, priorityScore, senderNumber, rawInput);

      await logWebhookEvent(eventType, senderNumber, req.rawBody, {
        job_id: jobId,
        profile_score: priorityScore,
        parsed: parsedReport,
      });

      // Format skills for display
      const skillsDisplay = parsedReport.skills?.length > 0
        ? parsedReport.skills.join(', ')
        : parsedReport.job_description || 'Detected';

      const locationDisplay = parsedReport.location || 'Aapke area mein';

      // Scenario 2 reply
      const replyMessage =
        `✅ Aapka request humne darj kar liya hai!\n\n` +
        `🛠️ Kaam: ${skillsDisplay}\n` +
        `📍 Jagah: ${locationDisplay}\n\n` +
        `Hum aas-paas ke verified ${skillsDisplay} ko dhoondh rahe hain. ` +
        `Kripya 2-5 minute intezaar karein... ⏳`;

      twiml.message(replyMessage);
      return res.type('text/xml').send(twiml.toString());

    } catch (error) {
      console.error('Webhook error:', error);

      await logWebhookEvent('error', senderNumber, req.rawBody, {
        error: error.message,
      }).catch(() => {});

      twiml.message(
        `⚠️ Maaf kijiyega, abhi system mein thodi dikkat hai.\n\n` +
        `Kripya 1-2 minute baad dobara try karein. 🙏`
      );
      return res.type('text/xml').send(twiml.toString());
    }
  }
);

router.post('/status', (req, res) => {
  const { MessageSid, MessageStatus, To } = req.body;
  console.log(`Message ${MessageSid} to ${To}: ${MessageStatus}`);
  res.sendStatus(200);
});

// ── OUTBOUND NOTIFICATION HELPERS ────────────────────────────────
// Call these from your matching engine when a match is found

async function notifyCustomerOfMatch(customerNumber, workerName, workerSkill, workerPhone, trustScore) {
  const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: customerNumber,
    body:
      `🎉 Kaam Pakka! ${workerName} (${workerSkill}) 15 minute mein aapke paas pahunch rahe hain.\n\n` +
      `📞 ${workerName} ka Number: ${workerPhone}\n` +
      `⭐ Trust Score: ${trustScore}/5\n\n` +
      `(Aap inhe direct call karke aane ka rasta bata sakte hain).`
  });
}

async function notifyWorkerOfJob(workerNumber, jobLocation, customerPhone) {
  const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: workerNumber,
    body:
      `🚨 Naya Kaam (New Job)!\n\n` +
      `📍 ${jobLocation} mein kaam aaya hai.\n` +
      `📞 Customer ka Number: ${customerPhone}\n\n` +
      `Jaldi call karein aur kaam confirm karein! 👍`
  });
}

async function requestJobRating(customerNumber, workerName) {
  const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: customerNumber,
    body:
      `🙏 RozgarBot istemaal karne ke liye dhanyawad!\n\n` +
      `Kya ${workerName} ne aapka kaam poora kar diya?\n\n` +
      `Kripya unke kaam ko 1 se 5 ke beech number dein ` +
      `(Voice Note ya Text bhej kar). Aapka feedback unki madad karega! ⭐`
  });
}

module.exports = router;
module.exports.notifyCustomerOfMatch = notifyCustomerOfMatch;
module.exports.notifyWorkerOfJob = notifyWorkerOfJob;
module.exports.requestJobRating = requestJobRating;