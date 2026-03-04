# InstaAuto: Your Personal AI Instagram Agent

InstaAuto is a self-hosted platform that allows you to automate your Instagram Direct Messages using Google's Gemini AI. Unlike generic services, you can "train" InstaAuto on your existing chats or a specific tone of voice.

## Features
- **One-Click Authorization**: Log in with Facebook to link your professional Instagram account.
- **Smart Training**: Paste your past chats into the dashboard to train the AI.
- **Context-Aware**: The AI remembers the last few messages in a conversation.
- **Self-Hosted**: You own your data and your tokens.

## Setup

### 1. Meta Developer Portal
1. Go to [Meta for Developers](https://developers.facebook.com/).
2. Create a new App (Type: Other -> Business).
3. Add the **Messenger** and **Instagram Graph API** products.
4. Go to **Settings -> Basic** to get your `APP_ID` and `APP_SECRET`.
5. Add `http://localhost:3000/auth/callback` (or your ngrok URL) to the **Facebook Login -> Settings -> Valid OAuth Redirect URIs**.

### 2. Implementation
1. Copy `.env.example` to `.env` and fill in your keys.
2. Run the server:
   ```bash
   node server.js
   ```
3. Use a tool like **ngrok** to expose your server to the internet:
   ```bash
   ngrok http 3000
   ```
4. Update `REDIRECT_URI` in `.env` to your ngrok URL if using it for remote access.

### 3. Training
Once logged in, go to the dashboard and paste your chat logs into the "Training Data" section. Your AI will immediately start using that context for its replies.

## Security
This app uses `cookie-session` for basic management. For a production environment, consider adding HTTPS and a more robust session store.
