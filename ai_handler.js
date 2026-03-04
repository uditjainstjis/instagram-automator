const axios = require('axios');
const { getChatHistory, getTrainingData } = require('./database');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

async function generateReply(user_id, sender_id, incomingMessage) {
    const history = await getChatHistory(user_id, sender_id);
    const trainingData = await getTrainingData(user_id);

    // Format history for context
    const historyContext = history.reverse().map(msg => `${msg.sender_id === sender_id ? 'User' : 'Bot'}: ${msg.text}`).join('\n');

    const prompt = `
You are an AI assistant for an Instagram account. Your goal is to reply to DMs in a professional and helpful manner, maintaining the brand's voice.
Use the following training data to understand the tone and common responses:
${trainingData || "No specific training data provided yet. Be professional and helpful."}

Recent Chat History:
${historyContext}

User: ${incomingMessage}
Bot:`;

    try {
        const response = await axios.post(GEMINI_URL, {
            contents: [{
                parts: [{ text: prompt }]
            }]
        });

        if (response.data && response.data.candidates && response.data.candidates[0].content) {
            return response.data.candidates[0].content.parts[0].text.trim();
        } else {
            console.error('Unexpected Gemini Response:', JSON.stringify(response.data));
            return "I'm sorry, I'm having trouble processing that right now.";
        }
    } catch (error) {
        console.error('Error generating AI reply:', error.response ? error.response.data : error.message);
        return "I'm sorry, I'm having trouble thinking right now. Could you try again later?";
    }
}

module.exports = { generateReply };
