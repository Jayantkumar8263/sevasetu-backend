const rateLimit = require('express-rate-limit');

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const senderMessageCounts = new Map();

const whatsappSenderLimiter = (req, res, next) => {
  const sender = req.body?.From;

  if (!sender) return next();

  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxMessages = 10;

  const record = senderMessageCounts.get(sender) || { count: 0, windowStart: now };

  if (now - record.windowStart > windowMs) {
    record.count = 0;
    record.windowStart = now;
  }

  record.count += 1;
  senderMessageCounts.set(sender, record);

  if (record.count > maxMessages) {
    console.warn(`Rate limit hit for sender: ${sender}`);
    return res.status(429).send(
      `<Response><Message>You're sending too many messages. Please wait a minute.</Message></Response>`
    );
  }

  next();
};

setInterval(() => {
  const now = Date.now();
  const windowMs = 60 * 1000;
  for (const [key, record] of senderMessageCounts.entries()) {
    if (now - record.windowStart > windowMs * 2) {
      senderMessageCounts.delete(key);
    }
  }
}, 5 * 60 * 1000);

module.exports = { generalLimiter, whatsappSenderLimiter };