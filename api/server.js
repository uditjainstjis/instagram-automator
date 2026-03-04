require('dotenv').config();
const express = require('express');
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
} = require('../database');
const { generateReply } = require('../ai_handler');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

app.use(cookieSession({
    name: 'session',
    keys: [process.env.APP_SECRET || 'secret'],
    maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
}));

const PORT = process.env.PORT || 3000;
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;

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
    // Use the refined scopes for 2024/2025
    const scope = [
        'instagram_business_basic',
        'instagram_business_manage_messages',
        'public_profile'
    ].join(',');

    const authUrl = `https://www.facebook.com/v12.0/dialog/oauth?client_id=${APP_ID}&redirect_uri=${REDIRECT_URI}&scope=${scope}`;
    res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        console.error('Auth Error:', error);
        return res.status(400).send(`Authentication error: ${error}`);
    }

    if (!code) return res.status(400).send('No authorization code provided');

    try {
        // 1. Exchange code for access token
        const tokenRes = await axios.get(`https://graph.facebook.com/v12.0/oauth/access_token`, {
            params: {
                client_id: APP_ID,
                client_secret: APP_SECRET,
                redirect_uri: REDIRECT_URI,
                code
            }
        });

        const userAccessToken = tokenRes.data.access_token;

        // 2. Get User Info
        const userRes = await axios.get(`https://graph.facebook.com/me?access_token=${userAccessToken}`);
        const fbId = userRes.data.id;
        const fbName = userRes.data.name;

        // 3. Get Pages and their Instagram accounts
        const pagesRes = await axios.get(`https://graph.facebook.com/v12.0/me/accounts?access_token=${userAccessToken}`);
        const pages = pagesRes.data.data;

        if (!pages || pages.length === 0) {
            return res.status(400).send('No Facebook Pages found. Ensure your Instagram account is linked to a Facebook Page or has permissions granted.');
        }

        let igId = null;
        let pageId = null;
        let pageAccessToken = null;

        for (const page of pages) {
            try {
                const igRes = await axios.get(`https://graph.facebook.com/v12.0/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`);
                if (igRes.data.instagram_business_account) {
                    igId = igRes.data.instagram_business_account.id;
                    pageId = page.id;
                    pageAccessToken = page.access_token;
                    break;
                }
            } catch (e) {
                console.warn(`Could not fetch IG account for page ${page.id}`);
            }
        }

        if (!igId) {
            return res.status(400).send('No linked Instagram Business account found. Go to Instagram -> Settings -> Linked Accounts to connect a Facebook Page.');
        }

        // 4. Save user to DB (SO WE HAVE AN ID FOR LOGGING)
        const userId = await upsertUser(fbId, fbName, pageAccessToken, pageId, igId);
        req.session.userId = userId;

        // 5. Subscribe App to the Page's Webhooks
        await axios.post(`https://graph.facebook.com/v12.0/${pageId}/subscribed_apps`, {
            subscribed_fields: ['messages', 'messaging_postbacks'],
            access_token: pageAccessToken
        });

        await logActivity(userId, 'info', `Connected Instagram account: ${igId}`);

        res.redirect('/');
    } catch (error) {
        console.error('OAuth Callback Error:', error.response ? error.response.data : error.message);
        res.status(500).send('Authentication failed. Check your App ID and App Secret.');
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
                        await axios.post(`https://graph.facebook.com/v12.0/me/messages?access_token=${user.access_token}`, {
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
