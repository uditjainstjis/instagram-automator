require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const axios = require('axios');
const cookieSession = require('cookie-session');
const {
    upsertUser,
    getUser,
    getUserByInstagramId,
    addTrainingData,
    getTrainingData,
    saveMessage,
    logActivity,
    getLogs
} = require('./database');
const { generateReply } = require('./ai_handler');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, './views'));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, './public')));

app.use(cookieSession({
    name: 'session',
    keys: [process.env.APP_SECRET || 'secret'],
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
}));

const PORT = process.env.PORT || 3000;
const APP_ID = (process.env.APP_ID || '').trim();
const APP_SECRET = (process.env.APP_SECRET || '').trim();
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
let REDIRECT_URI = (process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`).trim();
if (REDIRECT_URI.includes('onrender.com') && !REDIRECT_URI.startsWith('http')) {
    REDIRECT_URI = `https://${REDIRECT_URI}`;
}

console.log('App Startup Configuration:');
console.log('- APP_ID:', APP_ID ? 'Set (ends in ...' + APP_ID.slice(-4) + ')' : 'MISSING');
console.log('- REDIRECT_URI:', REDIRECT_URI);

// --- Dashboard ---
app.get('/', async (req, res) => {
    let user = null;
    let trainingData = "";
    let logs = [];
    if (req.session.userId) {
        user = await getUser(req.session.userId);
        trainingData = await getTrainingData(req.session.userId);
        logs = await getLogs(req.session.userId);
    }
    res.render('index', { user, trainingData, logs });
});

app.post('/save-training', async (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    await addTrainingData(req.session.userId, req.body.content);
    await logActivity(req.session.userId, 'info', 'Training data updated.');
    res.redirect('/');
});

app.get('/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
});

// --- OAuth Flow ---
app.get('/auth/instagram', (req, res) => {
    // Instagram Business Login scopes — MUST use instagram.com/oauth/authorize endpoint
    const scope = [
        'instagram_business_basic',
        'instagram_business_manage_messages',
        'instagram_business_manage_comments',
        'instagram_business_content_publish'
    ].join(',');

    // Use Instagram's own OAuth endpoint (NOT Facebook's dialog — that does NOT support instagram_business_* scopes)
    const authUrl = `https://www.instagram.com/oauth/authorize?` +
        `client_id=${APP_ID}&` +
        `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
        `scope=${encodeURIComponent(scope)}&` +
        `response_type=code&` +
        `enable_fb_login=0`;

    console.log('Redirecting to Auth URL:', authUrl);
    res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
    const { code, error, error_message } = req.query;

    if (error) {
        console.error('Auth Error:', error, error_message);
        return res.status(400).send(
            `<h2>Authentication Error</h2><p>${error}</p><p>${error_message || ''}</p><a href="/">Go back</a>`
        );
    }

    if (!code) return res.status(400).send('No authorization code provided');

    try {
        // 1. Exchange code for a short-lived Instagram User access token
        //    Uses api.instagram.com (NOT graph.facebook.com) for Instagram Login flow
        const tokenRes = await axios.post(`https://api.instagram.com/oauth/access_token`, new URLSearchParams({
            client_id: APP_ID,
            client_secret: APP_SECRET,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI,
            code
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const shortLivedToken = tokenRes.data.access_token;
        const igUserId = tokenRes.data.user_id; // Instagram User ID is returned directly

        console.log('Token exchange success. IG User ID:', igUserId);

        // 2. Exchange short-lived token for a long-lived token (valid 60 days)
        const longLivedRes = await axios.get(`https://graph.instagram.com/access_token`, {
            params: {
                grant_type: 'ig_exchange_token',
                client_secret: APP_SECRET,
                access_token: shortLivedToken
            }
        });

        const userAccessToken = longLivedRes.data.access_token;

        // 3. Get Instagram User Info using Graph API
        const userRes = await axios.get(`https://graph.instagram.com/v21.0/me`, {
            params: {
                fields: 'id,name,username',
                access_token: userAccessToken
            }
        });

        const igId = userRes.data.id;
        const igName = userRes.data.name || userRes.data.username || igId;

        console.log('Instagram user:', igName, '| ID:', igId);

        // 4. Save user to DB — store IG user token as access_token
        //    pageId is null since we're using Instagram Login (not Facebook Pages)
        const userId = await upsertUser(igId, igName, userAccessToken, null, igId);
        req.session.userId = userId;

        await logActivity(userId, 'info', `Connected Instagram account: @${igName} (${igId})`);

        res.redirect('/');
    } catch (error) {
        console.error('OAuth Callback Error:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).send(
            `<h2>Authentication Failed</h2>` +
            `<p>${error.response ? JSON.stringify(error.response.data) : error.message}</p>` +
            `<a href="/">Go back</a>`
        );
    }
});

// --- Webhooks ---
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'instagram') {
        for (const entry of body.entry) {
            const igId = entry.id;
            const user = await getUserByInstagramId(igId);

            if (!user) {
                console.log(`Received message for unknown Instagram ID: ${igId}`);
                continue;
            }

            if (!entry.messaging) continue;

            for (const messaging of entry.messaging) {
                const sender_id = messaging.sender.id;
                const message_text = messaging.message ? messaging.message.text : null;

                if (message_text) {
                    // Save incoming
                    await saveMessage(user.id, igId, sender_id, message_text);

                    // Generate reply
                    const replyText = await generateReply(user.id, sender_id, message_text);

                    // Send reply
                    try {
                        await axios.post(`https://graph.instagram.com/v21.0/${user.ig_id}/messages?access_token=${user.access_token}`, {
                            recipient: { id: sender_id },
                            message: { text: replyText }
                        });

                        // Save outgoing
                        await saveMessage(user.id, igId, 'bot', replyText);
                    } catch (error) {
                        const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
                        console.error(`Error sending message for user ${user.id}:`, errorMsg);
                        await logActivity(user.id, 'error', `Failed to send reply: ${errorMsg}`);
                    }
                }
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

module.exports = app;
