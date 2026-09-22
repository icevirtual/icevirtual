// ============================================================================
// ICE SECURITY BACKEND API - v2.6 (Sync Engine)
// Organization: icevirtual | Product: ICE Security
// ============================================================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Bellek içi durum havuzu
let securityData = {};

app.get('/', (req, res) => {
    res.send({ status: 'online', brand: 'icevirtual', product: 'ICE Security API v2.6' });
});

// Telemetri Alımı & Orb ile Çift Yönlü Senkronizasyon
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
                status: 1,      // 1: Active, 0: Disarmed
                scanMode: 1     // 1: Lockdown, 2: Tracker Only
            },
            telemetry: null
        };
    }

    securityData[ownerKey].telemetry = {
        region: region || 'Unknown',
        parcelName: parcelName || 'Unknown',
        status: status !== undefined ? status : securityData[ownerKey].settings.status,
        scanMode: scanMode !== undefined ? scanMode : securityData[ownerKey].settings.scanMode,
        countdown: countdown || 10,
        avatars: Array.isArray(avatars) ? avatars : [],
        lastSeen: new Date().toISOString()
    };

    // KRİTİK NOKTA: Orb'a paneldeki güncel ayarları geri döndürüyoruz!
    res.json({
        success: true,
        status: securityData[ownerKey].settings.status,
        scanMode: securityData[ownerKey].settings.scanMode,
        whitelist: securityData[ownerKey].settings.whitelist
    });
});

// Web Paneli İçin Durum Sorgulama
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
            avatars: [],
            whitelist: []
        });
    }

    res.json({
        online: true,
        ...data.telemetry,
        status: data.settings.status,
        scanMode: data.settings.scanMode,
        whitelist: data.settings.whitelist,
        discordWebhook: data.settings.discordWebhook
    });
});

// Web Panelinden Gelen Emirleri Kaydetme
app.post('/api/settings/:ownerKey', (req, res) => {
    const { ownerKey } = req.params;
    const { discordWebhook, whitelist, command } = req.body;

    if (!securityData[ownerKey]) {
        securityData[ownerKey] = {
            settings: { discordWebhook: '', whitelist: [], status: 1, scanMode: 1 },
            telemetry: null
        };
    }

    if (discordWebhook !== undefined) securityData[ownerKey].settings.discordWebhook = discordWebhook;
    if (whitelist !== undefined) securityData[ownerKey].settings.whitelist = whitelist;

    if (command === 'disarm') {
        securityData[ownerKey].settings.status = 0;
    } else if (command === 'lockdown') {
        securityData[ownerKey].settings.status = 1;
        securityData[ownerKey].settings.scanMode = 1;
    } else if (command === 'tracker_only') {
        securityData[ownerKey].settings.status = 1;
        securityData[ownerKey].settings.scanMode = 2;
    }

    res.json({ success: true, settings: securityData[ownerKey].settings });
});

// Discord Test
app.post('/api/test-discord', async (req, res) => {
    const { webhookUrl } = req.body;
    if (!webhookUrl) return res.status(400).json({ error: 'Webhook URL missing' });

    try {
        await axios.post(webhookUrl, {
            embeds: [{
                title: '🛡️ ICE SECURITY — System Alert',
                description: 'Discord Webhook connection is fully functional.',
                color: 65535,
                timestamp: new Date().toISOString()
            }]
        });
        res.json({ success: true, message: 'Discord test sent!' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to deliver webhook' });
    }
});

app.listen(PORT, () => {
    console.log(`[ICE Security] Backend running on port ${PORT}`);
});
