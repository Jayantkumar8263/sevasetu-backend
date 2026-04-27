# Rozgar Bot

WhatsApp-based field reporting backend for disaster relief coordination.

## What it does
- Receives WhatsApp messages from field workers via Twilio
- Parses reports using Gemini AI (multilingual: Hindi, Hinglish, English)
- Calculates priority score
- Stores structured data in Firestore for the dashboard and matching engine

## Setup

### Prerequisites
- Node.js 20+
- A Twilio account with WhatsApp sandbox enabled
- A Google Cloud project with Gemini API access
- A Firebase project with Firestore enabled

### Installation
```bash
git clone https://github.com/Jayantkumar8263/sevasetu-backend
cd sevasetu-backend
npm install
```

### Environment Variables
Create a `.env` file with:
