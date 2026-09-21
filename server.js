const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = path.join(__dirname, 'database.json');

let db = { devices: {}, settings: {}, logs: {}, auth: {} };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } 
  catch (e) { console.error("DB Load error:", e); }
}

if (!db.auth) db.auth = {};

function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } 
  catch (e) { console.error("DB Save error:", e); }
}

// 1. PIN Tanımlama / Güncelleme
app.post('/api/set-pin', (req, res) => {
  const { ownerId, pin } = req.body;
  if (!ownerId || !pin) {
    return res.status(400).json({ error: "Owner ID and PIN are required." });
  }

  const cleanPin = String(pin).trim();
  if (cleanPin.length < 4 || cleanPin.length > 8) {
    return res.status(400).json({ error: "PIN must be between 4 and 8 characters." });
  }

  db.auth[ownerId] = cleanPin;
  saveDB();

  console.log(`[AUTH] PIN set for owner: ${ownerId}`);
  res.json({ status: "success", message: "PIN updated successfully." });
});

// 2. In-World Donanımsal PIN Sıfırlama (Orb Menüsünden)
app.post('/api/reset-pin', (req, res) => {
  const { ownerId } = req.body;
  if (!ownerId) return res.status(400).json({ error: "Missing ownerId" });

  if (db.auth && db.auth[ownerId]) {
    delete db.auth[ownerId];
    saveDB();
    console.log(`[AUTH] PIN successfully wiped by Orb hardware reset for: ${ownerId}`);
  }
  
  res.json({ status: "success", message: "PIN reset successfully." });
});

// 3. PIN Doğrulama
app.post('/api/verify-pin', (req, res) => {
  const { ownerId, pin } = req.body;
  if (!ownerId) return res.status(400).json({ error: "Missing Owner ID." });

  const existingPin = db.auth[ownerId];
  if (!existingPin) {
    return res.json({ status: "no_pin_set", message: "No PIN configured yet." });
  }

  if (String(pin).trim() === existingPin) {
    return res.json({ status: "success", verified: true });
  }

  return res.status(401).json({ status: "invalid_pin", error: "Incorrect Security PIN." });
});

// 4. Orb Kaydı
app.post('/api/register-orb', (req, res) => {
  const { ownerId, orbUrl, parcelName, region } = req.body;
  if (!ownerId || !orbUrl) return res.status(400).json({ error: "Missing fields" });

  if (!db.devices[ownerId]) db.devices[ownerId] = {};
  db.devices[ownerId].orbUrl = orbUrl;
  db.devices[ownerId].parcelName = parcelName || "Unknown Parcel";
  db.devices[ownerId].region = region || "Unknown Region";
  db.devices[ownerId].lastSeen = new Date().toISOString();
  saveDB();
  res.json({ status: "success" });
});

// 5. Radar & Canlı Konum Güncelleme
app.post('/api/update-live-presence', (req, res) => {
  const { ownerId, onlineAvatars, orbUrl } = req.body;
  if (!ownerId) return res.status(400).json({ error: "Missing ownerId" });

  if (!db.devices[ownerId]) db.devices[ownerId] = { parcelName: "Unknown", region: "Unknown" };
  if (orbUrl && orbUrl.startsWith("http")) db.devices[ownerId].orbUrl = orbUrl;
  
  db.devices[ownerId].onlineAvatars = Array.isArray(onlineAvatars) ? onlineAvatars : [];
  db.devices[ownerId].lastPresenceUpdate = new Date().toISOString();
  saveDB();
  res.json({ status: "success" });
});

// 6. Olay Kaydı & Discord Webhook
app.post('/api/record-event', async (req, res) => {
  const { ownerId, eventType, avatarName, reason } = req.body;
  if (!ownerId || !avatarName) return res.status(400).json({ error: "Missing fields" });

  if (!db.logs[ownerId]) db.logs[ownerId] = [];
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  db.logs[ownerId].unshift({
    name: avatarName, type: eventType || "visit", reason: reason || "", time: timeStr, timestamp: Date.now()
  });
  if (db.logs[ownerId].length > 100) db.logs[ownerId].pop();
  saveDB();

  const userSettings = db.settings[ownerId] || {};
  const webhookUrl = userSettings.discordWebhook;

  if (webhookUrl && webhookUrl.includes("webhooks")) {
    try {
      const isBreach = (eventType === "breach");
      const device = db.devices[ownerId] || { parcelName: "Parcel", region: "Region" };
      await fetch(webhookUrl.trim(), {
        method: "POST", 
        headers: { 
            "Content-Type": "application/json",
            "User-Agent": "ICE-Security-Bot/1.0"
        },
        body: JSON.stringify({
          content: null,
          embeds: [{
            title: isBreach ? "🚨 Intruder Ejected" : "🟢 Visitor Detected",
            color: isBreach ? 0xff3b30 : 0x00e676,
            fields: [
              { name: "Avatar", value: avatarName, inline: true },
              { name: "Location", value: `${device.parcelName} (${device.region})`, inline: true },
              { name: "Details", value: reason || (isBreach ? "Unauthorized" : "Entered boundaries"), inline: false }
            ],
            footer: { text: "ICE Security Autonomous Defense Grid" },
            timestamp: new Date().toISOString()
          }]
        })
      });
    } catch (err) {
      console.error("Discord send failed:", err);
    }
  }
  res.json({ status: "success" });
});

// 7. Manuel Eject Kuyruğu
app.post('/api/manual-action', async (req, res) => {
  const { ownerId, targetName } = req.body;
  if (!ownerId) return res.status(400).json({ error: "Missing ID" });

  if (!db.devices[ownerId]) db.devices[ownerId] = {};
  const device = db.devices[ownerId];

  device.kickQueue = device.kickQueue || [];
  device.kickQueue.push(targetName);
  saveDB();

  res.json({ status: "success" });

  if (device.orbUrl) {
    try {
      await fetch(device.orbUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "MANUAL_EJECT", targetName }),
        timeout: 2000
      });
    } catch (err) {}
  }
});

// 8. Panel Veri Alma (PIN Korumalı)
app.get('/api/settings', (req, res) => {
  const ownerId = req.query.id;
  const clientPin = req.query.pin;
  if (!ownerId) return res.json({ status: "alive" });

  const existingPin = db.auth[ownerId];
  if (existingPin && String(clientPin).trim() !== existingPin) {
    return res.status(401).json({
      status: "auth_required",
      hasPinSet: true,
      error: "Authentication required. Please enter Security PIN."
    });
  }

  const device = db.devices[ownerId] || {};
  const logs = db.logs[ownerId] || [];
  res.json({
    status: "success",
    hasPinSet: !!existingPin,
    orbConnected: !!device.orbUrl,
    parcelName: device.parcelName || "Standby",
    region: device.region || "Standby",
    onlineAvatars: device.onlineAvatars || [],
    totalVisits: logs.length,
    visitorLogs: logs.slice(0, 30),
    config: db.settings[ownerId] || {}
  });
});

// 9. Orb Mikro-Senkronizasyon
app.get('/api/orb-sync', (req, res) => {
  const ownerId = req.query.id;
  const orbUrl = req.query.url;
  if (!ownerId) return res.json({});
  
  if (!db.devices[ownerId]) db.devices[ownerId] = {};
  const device = db.devices[ownerId];

  if (orbUrl && orbUrl.startsWith("http")) device.orbUrl = orbUrl;

  const settings = db.settings[ownerId] || {};
  
  let cleanWhitelist = [];
  if (Array.isArray(settings.whitelist)) {
    cleanWhitelist = settings.whitelist.map(s => String(s).trim().toLowerCase()).filter(s => s.length > 0);
  }

  let kickTarget = "";
  if (device.kickQueue && device.kickQueue.length > 0) {
      kickTarget = device.kickQueue.shift();
      saveDB();
  }

  res.json({
    m: settings.mode || "lockdown",
    a: settings.action || "eject",
    e: (settings.enableCountdown === 1 || settings.enableCountdown === true) ? 1 : 0,
    c: parseInt(settings.countdown) || 10,
    w: cleanWhitelist.join("|"),
    k: kickTarget
  });
});

// 10. Panel Ayarlarını Kaydetme (PIN Korumalı)
app.post('/api/settings', async (req, res) => {
  const { ownerId } = req.query;
  const clientPin = req.query.pin;
  const settings = req.body;
  const targetId = ownerId || settings.ownerId;
  if (!targetId) return res.status(400).json({ error: "Missing ID" });

  const existingPin = db.auth[targetId];
  if (existingPin && String(clientPin).trim() !== existingPin) {
    return res.status(401).json({ status: "auth_required", error: "Invalid PIN. Access denied." });
  }

  db.settings[targetId] = settings;
  saveDB();

  const device = db.devices[targetId];
  if (device && device.orbUrl) {
    try {
      await fetch(device.orbUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "TRIGGER_SYNC" }), timeout: 2000
      });
      return res.json({ status: "success", message: "Saved and triggered sync instantly." });
    } catch (e) {
      return res.json({ status: "success", message: "Saved to cloud. Orb will auto-sync." });
    }
  }
  res.json({ status: "success", message: "Saved locally." });
});

// 11. Discord Webhook Testi
app.post('/api/test-discord', async (req, res) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl || !webhookUrl.includes("webhooks")) {
      return res.status(400).json({ error: "Invalid Discord Webhook URL" });
  }
  
  try {
    const dRes = await fetch(webhookUrl.trim(), {
      method: "POST", 
      headers: { 
          "Content-Type": "application/json",
          "User-Agent": "ICE-Security-Bot/1.0"
      },
      body: JSON.stringify({ 
          content: null,
          embeds: [{ 
              title: "🛡️ ICE Security Test", 
              description: "Your Discord webhook integration is functioning perfectly.",
              color: 0x00bcd4 
          }] 
      })
    });
    
    if (dRes.ok) return res.json({ status: "success" });
    const errorText = await dRes.text();
    return res.status(400).json({ error: "Discord rejected request: " + errorText });
  } catch (e) {
    res.status(500).json({ error: "Network error to Discord" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`ICE Security Backend running on port ${PORT}`));
