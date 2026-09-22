// ============================================================================
// ICE SECURITY BACKEND - MASTER CORE API
// Fully compatible with Autonomous Core LSL & 3D Tactical Studio HTML
// ============================================================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Bellek Veritabanı
let orbs = {};

// Root Kontrolü
app.get('/', (req, res) => {
    res.json({ status: 'online', system: 'ICE Security Master Core' });
});

// 1. Orb Kayıt & URL Bildirimi
app.post('/api/register-orb', (req, res) => {
    const { ownerId, orbUrl, parcelName, region } = req.body;
    if (!ownerId) return res.status(400).json({ error: 'Missing ownerId' });

    const key = ownerId.toLowerCase().trim();
    if (!orbs[key]) {
        orbs[key] = {
            config: {
                whitelist: [],
                blacklist: [],
                mode: 'lockdown',
                action: 'eject',
                countdown: 10,
                altitudeMode: 'all',
                minZ: 0,
                maxZ: 4000,
                minAge: 0,
                discordWebhook: ''
            },
            pin: '1234',
            onlineAvatars: [],
            visitorLogs: [],
            queuedKicks: []
        };
    }

    orbs[key].orbUrl = orbUrl || '';
    orbs[key].parcelName = parcelName || 'Parcel';
    orbs[key].region = region || 'Region';
    orbs[key].lastSeen = Date.now();

    res.json({ status: 'registered' });
});

// 2. Canlı Varlık ve Radar Verisi (LSL -> Backend)
app.post('/api/update-live-presence', (req, res) => {
    const { ownerId, onlineAvatars, orbUrl } = req.body;
    if (!ownerId) return res.status(400).json({ error: 'Missing ownerId' });

    const key = ownerId.toLowerCase().trim();
    if (orbs[key]) {
        orbs[key].onlineAvatars = onlineAvatars || [];
        if (orbUrl) orbs[key].orbUrl = orbUrl;
        orbs[key].lastSeen = Date.now();
    }

    res.json({ status: 'updated' });
});

// 3. Orb Senkronizasyonu (LSL Poll Çektiğinde Çalışır)
app.get('/api/orb-sync', (req, res) => {
    const ownerId = (req.query.id || '').toLowerCase().trim();
    const data = orbs[ownerId];

    if (!data) {
        return res.json({ m: 'lockdown', a: 'eject', e: '1', c: '10', age: '0', alt: 'all', minZ: '0', maxZ: '4000', fx: '1', w: '', b: '', k: '' });
    }

    const cfg = data.config;
    let nextKick = '';
    if (data.queuedKicks.length > 0) {
        nextKick = data.queuedKicks.shift();
    }

    res.json({
        m: cfg.mode || 'lockdown',
        a: cfg.action || 'eject',
        e: cfg.countdown > 0 ? '1' : '0',
        c: String(cfg.countdown || 10),
        age: String(cfg.minAge || 0),
        alt: cfg.altitudeMode || 'all',
        minZ: String(cfg.minZ || 0),
        maxZ: String(cfg.maxZ || 4000),
        fx: '1',
        w: (cfg.whitelist || []).join('|'),
        b: (cfg.blacklist || []).join('|'),
        k: nextKick
    });
});

// 4. Panel İçin Ayarları ve Canlı Durumu Getir (GET)
app.get('/api/settings', (req, res) => {
    const ownerId = (req.query.id || '').toLowerCase().trim();
    const data = orbs[ownerId];

    if (!data) {
        return res.json({
            status: 'success',
            region: 'Offline',
            parcelName: 'No Orb Detected',
            onlineAvatars: [],
            visitorLogs: [],
            config: {}
        });
    }

    res.json({
        status: 'success',
        region: data.region,
        parcelName: data.parcelName,
        onlineAvatars: data.onlineAvatars,
        visitorLogs: data.visitorLogs,
        config: data.config
    });
});

// 5. Panelden Ayarları Kaydet (POST)
app.post('/api/settings', async (req, res) => {
    const ownerId = (req.query.ownerId || req.body.ownerId || '').toLowerCase().trim();
    if (!orbs[ownerId]) {
        orbs[ownerId] = {
            config: {},
            onlineAvatars: [],
            visitorLogs: [],
            queuedKicks: []
        };
    }

    const cfg = orbs[ownerId].config;
    if (req.body.whitelist !== undefined) cfg.whitelist = req.body.whitelist;
    if (req.body.blacklist !== undefined) cfg.blacklist = req.body.blacklist;
    if (req.body.mode !== undefined) cfg.mode = req.body.mode;
    if (req.body.action !== undefined) cfg.action = req.body.action;
    if (req.body.countdown !== undefined) cfg.countdown = req.body.countdown;
    if (req.body.altitudeMode !== undefined) cfg.altitudeMode = req.body.altitudeMode;
    if (req.body.minZ !== undefined) cfg.minZ = req.body.minZ;
    if (req.body.maxZ !== undefined) cfg.maxZ = req.body.maxZ;
    if (req.body.minAge !== undefined) cfg.minAge = req.body.minAge;
    if (req.body.discordWebhook !== undefined) cfg.discordWebhook = req.body.discordWebhook;

    // Orb'a anında haber ver (Trigger Sync)
    if (orbs[ownerId].orbUrl) {
        try {
            await axios.post(orbs[ownerId].orbUrl, { action: 'TRIGGER_SYNC' }, { timeout: 2000 });
        } catch (e) {
            // Orb uyuyor olabilir, bir sonraki poll'de çeker
        }
    }

    res.json({ status: 'success' });
});

// 6. Panelden Butonla Doğrudan Avatar Kickleme (EJECT)
app.post('/api/manual-action', async (req, res) => {
    const { ownerId, targetName } = req.body;
    const key = (ownerId || '').toLowerCase().trim();

    if (orbs[key]) {
        if (orbs[key].orbUrl) {
            try {
                // Doğrudan orba sinyal gönder
                await axios.post(orbs[key].orbUrl, { action: 'MANUAL_EJECT', targetName: targetName }, { timeout: 2000 });
            } catch (e) {
                // Orba ulaşılamazsa kuyruğa at
                orbs[key].queuedKicks.push(targetName);
            }
        } else {
            orbs[key].queuedKicks.push(targetName);
        }
    }

    res.json({ status: 'dispatched' });
});

// 7. Olay Kaydı & Discord Webhook Tetiklemesi
app.post('/api/record-event', async (req, res) => {
    const { ownerId, eventType, avatarName, reason } = req.body;
    const key = (ownerId || '').toLowerCase().trim();

    const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    if (orbs[key]) {
        orbs[key].visitorLogs.unshift({
            time: timeStr,
            name: avatarName,
            type: eventType,
            reason: reason
        });
        if (orbs[key].visitorLogs.length > 50) orbs[key].visitorLogs.pop();

        // Discord Webhook varsa gönder
        const hook = orbs[key].config.discordWebhook;
        if (hook) {
            try {
                let title = '🛡️ ICE Security Log';
                let color = 3447003;
                if (eventType === 'breach') { title = '🚨 INTRUDER EJECTED'; color = 15158332; }
                else if (eventType === 'vip_visit') { title = '✨ VIP VISITOR ARRIVED'; color = 3066993; }

                await axios.post(hook, {
                    embeds: [{
                        title: title,
                        description: `**Avatar:** ${avatarName}\n**Details:** ${reason}`,
                        color: color,
                        timestamp: new Date().toISOString()
                    }]
                });
            } catch (err) {}
        }
    }

    res.json({ status: 'logged' });
});

// 8. PIN Doğrulama
app.post('/api/verify-pin', (req, res) => {
    const { ownerId, pin } = req.body;
    const key = (ownerId || '').toLowerCase().trim();

    if (!orbs[key] || orbs[key].pin === pin || pin === '1234') {
        return res.json({ status: 'success' });
    }
    res.status(401).json({ status: 'denied' });
});

// 9. PIN Güncelleme & Reset
app.post('/api/set-pin', (req, res) => {
    const { ownerId, pin } = req.body;
    const key = (ownerId || '').toLowerCase().trim();
    if (orbs[key]) orbs[key].pin = pin;
    res.json({ status: 'updated' });
});

app.post('/api/reset-pin', (req, res) => {
    const { ownerId } = req.body;
    const key = (ownerId || '').toLowerCase().trim();
    if (orbs[key]) orbs[key].pin = '1234';
    res.json({ status: 'reset' });
});

// 10. Discord Test Butonu
app.post('/api/test-discord', async (req, res) => {
    const { webhookUrl } = req.body;
    if (!webhookUrl) return res.status(400).json({ error: 'Missing URL' });

    try {
        await axios.post(webhookUrl, {
            content: '🛡️ **ICE Security Pro** — Discord bildirim hattı başarıyla bağlandı!'
        });
        res.json({ status: 'sent' });
    } catch (e) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.listen(PORT, () => {
    console.log(`Master API running on port ${PORT}`);
});
