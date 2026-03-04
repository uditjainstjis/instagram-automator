const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const dbPath = path.resolve(__dirname, 'chat_history.db');

async function setupDatabase() {
    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      facebook_id TEXT UNIQUE,
      name TEXT,
      access_token TEXT,
      page_id TEXT,
      instagram_business_id TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      instagram_id TEXT,
      sender_id TEXT,
      text TEXT,
      timestamp INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS training_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      content TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT, 
      message TEXT,
      timestamp INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);

    return db;
}

async function logActivity(user_id, type, message) {
    const db = await setupDatabase();
    await db.run(
        'INSERT INTO activity_logs (user_id, type, message, timestamp) VALUES (?, ?, ?, ?)',
        [user_id, type, message, Date.now()]
    );
}

async function getLogs(user_id, limit = 20) {
    const db = await setupDatabase();
    return await db.all(
        'SELECT * FROM activity_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?',
        [user_id, limit]
    );
}

async function saveMessage(user_id, instagram_id, sender_id, text) {
    const db = await setupDatabase();
    await logActivity(user_id, sender_id === 'bot' ? 'outgoing' : 'incoming', text);
    await db.run(
        'INSERT INTO messages (user_id, instagram_id, sender_id, text, timestamp) VALUES (?, ?, ?, ?, ?)',
        [user_id, instagram_id, sender_id, text, Date.now()]
    );
}

async function getChatHistory(user_id, sender_id, limit = 10) {
    const db = await setupDatabase();
    return await db.all(
        'SELECT * FROM messages WHERE user_id = ? AND sender_id = ? ORDER BY timestamp DESC LIMIT ?',
        [user_id, sender_id, limit]
    );
}

async function upsertUser(facebook_id, name, access_token, page_id, instagram_business_id) {
    const db = await setupDatabase();
    const existing = await db.get('SELECT id FROM users WHERE facebook_id = ?', [facebook_id]);
    if (existing) {
        await db.run(
            'UPDATE users SET name = ?, access_token = ?, page_id = ?, instagram_business_id = ? WHERE id = ?',
            [name, access_token, page_id, instagram_business_id, existing.id]
        );
        return existing.id;
    } else {
        const result = await db.run(
            'INSERT INTO users (facebook_id, name, access_token, page_id, instagram_business_id) VALUES (?, ?, ?, ?, ?)',
            [facebook_id, name, access_token, page_id, instagram_business_id]
        );
        return result.lastID;
    }
}

async function getUser(id) {
    const db = await setupDatabase();
    return await db.get('SELECT * FROM users WHERE id = ?', [id]);
}

async function getUserByInstagramId(instagram_business_id) {
    const db = await setupDatabase();
    return await db.get('SELECT * FROM users WHERE instagram_business_id = ? AND is_active = 1', [instagram_business_id]);
}

async function addTrainingData(user_id, content) {
    const db = await setupDatabase();
    // Clear old training data or append? Let's treat it as a single block for simplicity
    await db.run('DELETE FROM training_data WHERE user_id = ?', [user_id]);
    await db.run('INSERT INTO training_data (user_id, content) VALUES (?, ?)', [user_id, content]);
}

async function getTrainingData(user_id) {
    const db = await setupDatabase();
    const data = await db.get('SELECT content FROM training_data WHERE user_id = ?', [user_id]);
    return data ? data.content : "";
}

module.exports = { saveMessage, getChatHistory, upsertUser, getUser, getUserByInstagramId, addTrainingData, getTrainingData, logActivity, getLogs };
