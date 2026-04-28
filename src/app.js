require('dotenv').config();
const express = require('express');
const webhookRouter = require('./routes/webhook');
const { generalLimiter } = require('./middleware/rateLimiter');

const app = express();
app.set('trust proxy', 1);

app.use(
  express.urlencoded({
    extended: false,
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

app.use(express.json());
app.use(generalLimiter);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'rozgarbot-backend' });
});

app.use('/webhook', webhookRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`RozgarBot backend running on port ${PORT}`);
});

module.exports = app;