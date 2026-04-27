const twilio = require('twilio');

const validateTwilioSignature = (req, res, next) => {
  if (process.env.NODE_ENV === 'development') {
    return next();
  }

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioSignature = req.headers['x-twilio-signature'];

  if (!twilioSignature) {
    console.warn('Missing Twilio signature header');
    return res.status(403).json({ error: 'Forbidden: Missing signature' });
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.hostname;
  const fullUrl = `${protocol}://${host}${req.originalUrl}`;

  const isValid = twilio.validateRequest(
    authToken,
    twilioSignature,
    fullUrl,
    req.body
  );

  if (!isValid) {
    console.warn(`Invalid Twilio signature for URL: ${fullUrl}`);
    return res.status(403).json({ error: 'Forbidden: Invalid signature' });
  }

  next();
};

module.exports = { validateTwilioSignature };