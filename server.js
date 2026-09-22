const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

let securityState = {};

app.get('/', (req, res) => {
    res.send({ status: 'online', brand: 'icevirtual', product: 'ICE Security' });
});

// Telemetri ve Orb Eşitlemesi
app.post('/api/telemetry', (req, res) => {
    const { ownerKey, region, parcelName, status, scanMode, countdown, avatars } = req.body;
    if (!ownerKey) return res.status(400).json({ error: 'ownerKey missing' });

    if (!securityState[ownerKey]) {
        securityState[ownerKey] = {
            status: 1,
            scanMode: 1,
            whitelist: [],
            discordWebhook: ''
        };
    }

    securityState[ownerKey].region = region || 'Unknown';
    securityState[ownerKey].parcelName = parcelName || 'Unknown';
    securityState[ownerKey].countdown = countdown || 10;
    securityState[ownerKey].avatars = Array.isArray(avatars) ? avatars : [];
    securityState[ownerKey].lastSeen = Date.now();

    // Orb'a paneldeki son emirleri ve whitelist'i geri gönder
    res.json({
        status: securityState[ownerKey].status,
        scanMode: securityState[ownerKey].scanMode,
        whitelist: securityState[ownerKey].whitelist
    });
});

// Panel Durum Sorgusu
app.get('/api/status/:ownerKey', (req, res) => {
    const data = securityState[req.params.ownerKey];
    if (!data) {
        return res.json({
            online: false,
            region: 'Offline',
            parcelName: '--',
            avatars: [],
            whitelist: []
        });
    }
    res.json({ online: true, ...data });
});

// Panel Komut ve Ayar Kaydı
app.post('/api/settings/:ownerKey', (req, res) => {
    const { ownerKey } = req.params;
    const { command, whitelist, discordWebhook } = req.body;

    if (!securityState[ownerKey]) {
        securityState[ownerKey] = { status: 1, scanMode: 1, whitelist: [], discordWebhook: '' };
    }

    if (command === 'disarm') securityState[ownerKey].status = 0;
    if (command === 'lockdown') { securityState[ownerKey].status = 1; securityState[ownerKey].scanMode = 1; }
    if (command === 'tracker_only') { securityState[ownerKey].status = 1; securityState[ownerKey].scanMode = 2; }
    
    if (whitelist !== undefined) securityState[ownerKey].whitelist = whitelist;
    if (discordWebhook !== undefined) securityState[ownerKey].discordWebhook = discordWebhook;

    res.json({ success: true, state: securityState[ownerKey] });
});

// Discord Alert Testi
app.post('/api/test-discord', async (req, res) => {
    const { webhookUrl } = req.body;
    if (!webhookUrl) return res.status(400).json({ error: 'Webhook URL required' });

    try {
        await axios.post(webhookUrl, {
            content: '🛡️ **ICE Security Alert** — Discord entegrasyonu başarıyla aktif edildi!'
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Discord webhook connection failed' });
    }
});

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
