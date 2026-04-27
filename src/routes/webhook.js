const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const { validateTwilioSignature } = require('../middleware/twilioValidator');
const { whatsappSenderLimiter } = require('../middleware/rateLimiter');
const { parseTextReport, parseVoiceReport, calculatePriorityScore } = require('../services/gemini');
const { downloadTwilioAudio, audioBufferToBase64, isVoiceMessage } = require('../services/audioHandler');
const { storeNeed, logWebhookEvent } = require('../services/firestore');

const MessagingResponse = twilio.twiml.MessagingResponse;

router.post(
  '/whatsapp',
  validateTwilioSignature,
  whatsappSenderLimiter,
  async (req, res) => {
    const twiml = new MessagingResponse();
    const senderNumber = req.body.From;
    const messageBody = req.body.Body || '';
    const numMedia = parseInt(req.body.NumMedia || '0', 10);

    console.log(`Incoming from ${senderNumber}: "${messageBody.substring(0, 50)}"`);

    try {
      let parsedReport;
      let rawInput;
      let eventType;

      if (numMedia > 0 && isVoiceMessage(req.body)) {
        const mediaUrl = req.body.MediaUrl0;
        const mediaContentType = req.body.MediaContentType0;

        console.log(`Processing voice note: ${mediaUrl}`);

        const { buffer, contentType } = await downloadTwilioAudio(mediaUrl);
        const { base64Data, mimeType } = audioBufferToBase64(buffer, contentType);

        parsedReport = await parseVoiceReport(base64Data, mimeType);
        rawInput = '[voice note]';
        eventType = 'voice';

      } else if (messageBody.trim().length > 0) {
        parsedReport = await parseTextReport(messageBody);
        rawInput = messageBody;
        eventType = 'text';

      } else {
        twiml.message(
          'SevaSetu: Please send a text message or voice note describing the situation.\n' +
          'Example: "flood mein 5 families phaas gayi hain ward 12 mein"'
        );
        return res.type('text/xml').send(twiml.toString());
      }

      if (parsedReport.error) {
        await logWebhookEvent('error', senderNumber, req.rawBody, parsedReport);
        twiml.message(
          'SevaSetu: We received your report but could not understand it.\n' +
          'Please describe: 1) Where? 2) What problem? 3) How many people affected?'
        );
        return res.type('text/xml').send(twiml.toString());
      }

      const priorityScore = calculatePriorityScore(parsedReport);
      const needId = await storeNeed(parsedReport, priorityScore, senderNumber, rawInput);

      await logWebhookEvent(eventType, senderNumber, req.rawBody, {
        need_id: needId,
        priority_score: priorityScore,
        parsed: parsedReport,
      });

      const priorityEmoji = priorityScore >= 8 ? '🔴' : priorityScore >= 5 ? '🟡' : '🟢';
      const replyMessage = [
        ` *SevaSetu Report Received*`,
        ``,
        ` Location: ${parsedReport.location || 'Not specified'}`,
        ` Issue: ${parsedReport.problem_type?.replace(/_/g, ' ')}`,
        `${priorityEmoji} Priority: ${priorityScore}/10`,
        `Affected: ${parsedReport.people_affected || 'Unknown'} people`,
        ``,
        `Matching volunteers now. Ref ID: ${needId.slice(-6)}`,
      ].join('\n');

      twiml.message(replyMessage);
      return res.type('text/xml').send(twiml.toString());

    } catch (error) {
      console.error('Webhook error:', error);

      await logWebhookEvent('error', senderNumber, req.rawBody, {
        error: error.message,
      }).catch(() => {});

      twiml.message(
        'SevaSetu: System error. Please try again in a moment.'
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

module.exports = router;