const axios = require('axios');

async function downloadTwilioAudio(mediaUrl) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  try {
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      auth: {
        username: accountSid,
        password: authToken,
      },
      timeout: 30000,
      maxContentLength: 10 * 1024 * 1024,
    });

    const contentType = response.headers['content-type'] || 'audio/ogg';
    const buffer = Buffer.from(response.data);

    console.log(`Downloaded audio: ${buffer.length} bytes, type: ${contentType}`);
    return { buffer, contentType };

  } catch (error) {
    if (error.response?.status === 403) {
      throw new Error('Audio download failed: Twilio authentication error');
    }
    if (error.code === 'ECONNABORTED') {
      throw new Error('Audio download timed out');
    }
    throw new Error(`Audio download failed: ${error.message}`);
  }
}

function audioBufferToBase64(buffer, contentType) {
  const mimeType = contentType.split(';')[0].trim();
  const base64Data = buffer.toString('base64');
  return { base64Data, mimeType };
}

function isVoiceMessage(body) {
  const mediaContentType = body.MediaContentType0;
  return mediaContentType && mediaContentType.startsWith('audio/');
}

module.exports = { downloadTwilioAudio, audioBufferToBase64, isVoiceMessage };