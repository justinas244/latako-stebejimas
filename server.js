const express = require('express');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config();

// ============ KONFIGŪRACIJA ============
const PORT = process.env.PORT || 10000;
const WS_PORT = process.env.WS_PORT || 8080;

// MySQL konfigūracija
const dbConfig = {
    host: process.env.DB_HOST || 'latakas-2c957c92-ku-7312.l.aivencloud.com',
    port: process.env.DB_PORT || 26099,
    user: process.env.DB_USER || 'avnadmin',
    password: process.env.DB_PASSWORD || 'AVNS_O218wwrMWicUdZRG7EK',
    database: process.env.DB_NAME || 'defaultdb',
    ssl: { rejectUnauthorized: false }
};

// ============ GLOBALAUS KINTAMIEJI ============
let db;
let recordingEnabled = true;  // Pagal nutylėjimą įrašymas įjungtas
const connectedClients = new Set();

// ============ MYSQL PRISIJUNGIMAS ============
async function initDB() {
    try {
        db = await mysql.createConnection(dbConfig);
        
        // Sukuriame lenteles
        await db.execute(`
            CREATE TABLE IF NOT EXISTS batch_measurements (
                id INT AUTO_INCREMENT PRIMARY KEY,
                water_levels JSON NOT NULL,
                distances JSON NOT NULL,
                measurement_count INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await db.execute(`
            CREATE TABLE IF NOT EXISTS system_state (
                id INT AUTO_INCREMENT PRIMARY KEY,
                is_recording BOOLEAN DEFAULT TRUE,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        
        // Patikriname ar yra įrašas
        const [rows] = await db.execute('SELECT COUNT(*) as count FROM system_state');
        if (rows[0].count === 0) {
            await db.execute('INSERT INTO system_state (is_recording) VALUES (TRUE)');
        } else {
            // Paimame dabartinę būseną
            const [state] = await db.execute('SELECT is_recording FROM system_state ORDER BY id DESC LIMIT 1');
            recordingEnabled = state[0].is_recording === 1;
        }
        
        console.log('✅ MySQL prisijungta');
    } catch (error) {
        console.error('❌ MySQL klaida:', error.message);
        process.exit(1);
    }
}

// ============ FUNKCIJOS ============
async function getRecordingState() {
    const [rows] = await db.execute('SELECT is_recording FROM system_state ORDER BY id DESC LIMIT 1');
    return rows[0] ? rows[0].is_recording === 1 : true;
}

async function setRecordingState(state) {
    const value = state ? 1 : 0;
    await db.execute('UPDATE system_state SET is_recording = ? ORDER BY id DESC LIMIT 1', [value]);
    recordingEnabled = state;
    
    // Informuojame visus WebSocket klientus
    broadcastToClients({
        type: 'status_change',
        recording: state
    });
}

async function clearAllMeasurements() {
    await db.execute('DELETE FROM batch_measurements');
    
    // Informuojame visus WebSocket klientus
    broadcastToClients({
        type: 'clear'
    });
}

async function getStatistics() {
    const [rows] = await db.execute(
        'SELECT water_levels FROM batch_measurements ORDER BY id DESC LIMIT 1000'
    );
    
    const allLevels = [];
    for (const row of rows) {
        const levels = JSON.parse(row.water_levels);
        allLevels.push(...levels);
    }
    
    if (allLevels.length === 0) {
        return { current: 0, avg: 0, max: 0, min: 0, count: 0 };
    }
    
    return {
        current: allLevels[allLevels.length - 1],
        avg: +(allLevels.reduce((a, b) => a + b, 0) / allLevels.length).toFixed(2),
        max: Math.max(...allLevels),
        min: Math.min(...allLevels),
        count: allLevels.length
    };
}

async function getAllMeasurements() {
    const [rows] = await db.execute(
        'SELECT water_levels, created_at FROM batch_measurements ORDER BY created_at ASC LIMIT 5000'
    );
    
    const allMeasurements = [];
    for (const row of rows) {
        const levels = JSON.parse(row.water_levels);
        const baseTime = new Date(row.created_at).getTime();
        const interval = 500; // 0.5 sekundės
        
        for (let i = 0; i < levels.length; i++) {
            const time = new Date(baseTime + (i * interval));
            allMeasurements.push({
                water_level: levels[i],
                created_at: time.toISOString().replace('T', ' ').substring(0, 19)
            });
        }
    }
    
    return allMeasurements;
}

// WebSocket transliacija
function broadcastToClients(message) {
    const data = JSON.stringify(message);
    connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// ============ EXPRESS SERVERIS (HTTP API) ============
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// API: Wemos siunčia batch'ą
app.post('/index.php', async (req, res) => {
    try {
        const batchData = req.body.batch ? JSON.parse(req.body.batch) : req.body;
        
        if (!batchData || !batchData.water_levels) {
            return res.json({ status: 'Klaida', error: 'Neteisingas formatas' });
        }
        
        const waterLevels = JSON.stringify(batchData.water_levels);
        const distances = JSON.stringify(batchData.distances || []);
        const count = batchData.water_levels.length;
        
        const isRecording = await getRecordingState();
        
        if (isRecording) {
            // Įrašome į MySQL
            const [result] = await db.execute(
                'INSERT INTO batch_measurements (water_levels, distances, measurement_count) VALUES (?, ?, ?)',
                [waterLevels, distances, count]
            );
            
            // Suformuojame matavimus WebSocket siuntimui
            const levels = batchData.water_levels;
            const baseTime = Math.floor(Date.now() / 1000);
            const interval = 0.5;
            const measurements = [];
            
            for (let i = 0; i < levels.length; i++) {
                const time = new Date((baseTime + (i * interval)) * 1000);
                measurements.push({
                    id: `${result.insertId}_${i}`,
                    water_level: levels[i],
                    created_at: time.toISOString().replace('T', ' ').substring(0, 19)
                });
            }
            
            // Siunčiame per WebSocket
            broadcastToClients({
                type: 'new_data',
                data: measurements
            });
            
            res.json({ status: 'Gauta', saved: true, count: count });
        } else {
            res.json({ status: 'Ignoruota', saved: false, reason: 'Recording disabled' });
        }
    } catch (error) {
        console.error('Klaida:', error);
        res.json({ status: 'Klaida', error: error.message });
    }
});

// API: Gauti būseną
app.post('/index.php', async (req, res) => {
    if (req.body.action === 'get_status') {
        const isRecording = await getRecordingState();
        return res.json({ recording: isRecording });
    }
    
    if (req.body.action === 'get_stats') {
        const stats = await getStatistics();
        return res.json(stats);
    }
    
    if (req.body.action === 'get_data') {
        const data = await getAllMeasurements();
        return res.json(data);
    }
    
    if (req.body.action === 'start') {
        await setRecordingState(true);
        return res.json({ success: true, recording: true });
    }
    
    if (req.body.action === 'stop') {
        await setRecordingState(false);
        return res.json({ success: true, recording: false });
    }
    
    if (req.body.action === 'clear') {
        await clearAllMeasurements();
        return res.json({ success: true, cleared: true });
    }
    
    res.json({ error: 'Nežinomas veiksmas' });
});

// Eksportas į CSV
app.get('/export', async (req, res) => {
    const measurements = await getAllMeasurements();
    
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vandens_lygis_${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.csv"`);
    
    // Pridedame BOM lietuviškiems simboliams
    res.write('\uFEFF');
    res.write('Vandens lygis (cm),Laikas\n');
    
    for (const m of measurements) {
        res.write(`${m.water_level.toFixed(2)},"${m.created_at}"\n`);
    }
    res.end();
});

// ============ WEB SOCKET SERVERIS ============
const wsServer = new WebSocket.Server({ port: WS_PORT });

wsServer.on('connection', (ws) => {
    console.log('🟢 WebSocket klientas prisijungė');
    connectedClients.add(ws);
    
    ws.on('close', () => {
        console.log('🔴 WebSocket klientas atsijungė');
        connectedClients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket klaida:', error);
    });
    
    // Siunčiame pradinę būseną
    ws.send(JSON.stringify({
        type: 'status_change',
        recording: recordingEnabled
    }));
});

console.log(`🔌 WebSocket serveris paleistas :${WS_PORT}`);

// ============ PALEIDIMAS ============
async function start() {
    await initDB();
    
    app.listen(PORT, () => {
        console.log(`✅ HTTP serveris paleistas :${PORT}`);
        console.log(`📊 http://localhost:${PORT}`);
    });
}

start();