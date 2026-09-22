// ============================================================================
// ICE SECURITY BACKEND API - v2.5 (Commercial Edition)
// Organization: icevirtual | Product: ICE Security
// ============================================================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS Kuralı: Yeni icevirtual alan adı dahil tüm isteklere tam izin verir
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Bellek içi veri havuzu (In-memory storage)
let securityData = {};

// Root Kontrolü
app.get('/', (req, res) => {
    res.send({ status: 'online', brand: 'icevirtual', product: 'ICE Security API v2.5' });
});

// Telemetri Alımı (Second Life LSL Orb'dan gelen veriler)
app.post('/api/telemetry', (req, res) => {
    const { ownerKey, region, parcelName, status, scanMode, countdown, avatars } = req.body;

    if (!ownerKey) {
        return res.status(400).json({ error: 'ownerKey is required' });
    }

    if (!securityData[ownerKey]) {
        securityData[ownerKey] = {
            settings: {
                discordWebhook: '',
                whitelist: [],
                pin: '1234'
            },
            pendingCommands: []
        };
    }

    securityData[ownerKey].telemetry = {
        region: region || 'Unknown',
        parcelName: parcelName || 'Unknown',
        status: status !== undefined ? status : 1,
        scanMode: scanMode !== undefined ? scanMode : 1,
        countdown: countdown || 10,
        avatars: Array.isArray(avatars) ? avatars : [],
        lastSeen: new Date().toISOString()
    };

    res.json({ success: true, message: 'Telemetry processed' });
});

// Panel İçin Durum ve Radar Verisi Çekme
app.get('/api/status/:ownerKey', (req, res) => {
    const { ownerKey } = req.params;
    const data = securityData[ownerKey];

    if (!data || !data.telemetry) {
        return res.json({
            online: false,
            region: 'Offline',
            parcelName: 'No Orb Detected',
            status: 0,
            scanMode: 1,
            countdown: 10,
            avatars: []
        });
    }

    res.json({
        online: true,
        ...data.telemetry,
        settings: data.settings || {}
    });
});

// Panelden Gelen Ayar & Komut Güncellemesi (Disarm, Lockdown, Whitelist, vb.)
app.post('/api/settings/:ownerKey', (req, res) => {
    const { ownerKey } = req.params;
    const { discordWebhook, whitelist, pin, command } = req.body;

    if (!securityData[ownerKey]) {
        securityData[ownerKey] = {
            settings: {},
            pendingCommands: [],
            telemetry: null
        };
    }

    if (discordWebhook !== undefined) securityData[ownerKey].settings.discordWebhook = discordWebhook;
    if (whitelist !== undefined) securityData[ownerKey].settings.whitelist = whitelist;
    if (pin !== undefined) securityData[ownerKey].settings.pin = pin;

    if (command) {
        securityData[ownerKey].pendingCommands.push(command);
    }

    res.json({ success: true, message: 'Settings updated successfully' });
});

// Discord Webhook Testi
app.post('/api/test-discord', async (req, res) => {
    const { webhookUrl } = req.body;

    if (!webhookUrl) {
        return res.status(400).json({ error: 'Webhook URL missing' });
    }

    try {
        await axios.post(webhookUrl, {
            embeds: [{
                title: '🛡️ ICE SECURITY — Test Alert',
                description: 'Discord Webhook connection established successfully.',
                color: 3447003,
                footer: { text: 'icevirtual security core' },
                timestamp: new Date().toISOString()
            }]
        });
        res.json({ success: true, message: 'Discord test notification sent!' });
    } catch (err) {
        res.status(500).json({ error: 'Discord Webhook delivery failed' });
    }
});

// Sunucuyu Başlat
app.listen(PORT, () => {
    console.log(`[ICE Security] Backend running on port ${PORT}`);
});
