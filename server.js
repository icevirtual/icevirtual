const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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
if (!db.settings) db.settings = {};
if (!db.devices) db.devices = {};
if (!db.logs) db.logs = {};

function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } 
  catch (e) { console.error("DB Save error:", e); }
}

// 1. PIN Tanımlama / Güncelleme
app.post('/api/set-pin', (req, res) => {
  const { ownerId, pin } = req.body;
  if (!ownerId || !pin) return res.status(400).json({ error: "Owner ID and PIN required." });

  const cleanId = String(ownerId).toLowerCase().trim();
  const cleanPin = String(pin).trim();
  if (cleanPin.length < 4 || cleanPin.length > 8) {
    return res.status(400).json({ error: "PIN must be 4-8 chars." });
  }

  db.auth[cleanId] = cleanPin;
  saveDB();
  res.json({ status: "success", message: "PIN updated." });
});

// 2. In-World Donanımsal PIN Sıfırlama
app.post('/api/reset-pin', (req, res) => {
  const { ownerId } = req.body;
  if (!ownerId) return res.status(400).json({ error: "Missing ownerId" });

  const cleanId = String(ownerId).toLowerCase().trim();
  if (db.auth && db.auth[cleanId]) {
    delete db.auth[cleanId];
    saveDB();
    console.log(`[AUTH] PIN wiped by Orb hardware reset for: ${cleanId}`);
  }
  res.json({ status: "success", message: "PIN reset." });
});

// 3. PIN Doğrulama
app.post('/api/verify-pin', (req, res) => {
  const { ownerId, pin } = req.body;
  if (!ownerId) return res.status(400).json({ error: "Missing Owner ID." });

  const cleanId = String(ownerId).toLowerCase().trim();
  const existingPin = db.auth[cleanId];
  if (!existingPin) return res.json({ status: "no_pin_set" });

  if (String(pin).trim() === existingPin) {
    return res.json({ status: "success", verified: true });
  }
  return res.status(401).json({ status: "invalid_pin", error: "Incorrect Security PIN." });
});

// 4. Orb Kaydı
app.post('/api/register-orb', (req, res) => {
  const { ownerId, orbUrl, parcelName, region } = req.body;
  if (!ownerId || !orbUrl) return res.status(400).json({ error: "Missing fields" });

  const cleanId = String(ownerId).toLowerCase().trim();
  if (!db.devices[cleanId]) db.devices[cleanId] = {};
  db.devices[cleanId].orbUrl = orbUrl;
  db.devices[cleanId].parcelName = parcelName || "Unknown Parcel";
  db.devices[cleanId].region = region || "Unknown Region";
  db.devices[cleanId].lastSeen = new Date().toISOString();
  saveDB();
  res.json({ status: "success" });
});

// 5. Radar & Canlı Konum Güncelleme
app.post('/api/update-live-presence', (req, res) => {
  const { ownerId, onlineAvatars, orbUrl } = req.body;
  if (!ownerId) return res.status(400).json({ error: "Missing ownerId" });

  const cleanId = String(ownerId).toLowerCase().trim();
  if (!db.devices[cleanId]) db.devices[cleanId] = { parcelName: "Unknown", region: "Unknown" };
  if (orbUrl && orbUrl.startsWith("http")) db.devices[cleanId].orbUrl = orbUrl;
  
  db.devices[cleanId].onlineAvatars = Array.isArray(onlineAvatars) ? onlineAvatars : [];
  db.devices[cleanId].lastPresenceUpdate = new Date().toISOString();
  saveDB();
  res.json({ status: "success" });
});

// 6. Olay Kaydı & Discord Webhook (Kusursuz İletim)
app.post('/api/record-event', async (req, res) => {
  const { ownerId, eventType, avatarName, reason } = req.body;
  if (!ownerId || !avatarName) return res.status(400).json({ error: "Missing fields" });

  const cleanId = String(ownerId).toLowerCase().trim();
  if (!db.logs[cleanId]) db.logs[cleanId] = [];
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  
  db.logs[cleanId].unshift({
    name: avatarName, type: eventType || "visit", reason: reason || "", time: timeStr, timestamp: Date.now()
  });
  if (db.logs[cleanId].length > 100) db.logs[cleanId].pop();
  saveDB();

  // Webhook URL'yi tüm ayarlardan güvenli çek
  const userSettings = db.settings[cleanId] || {};
  let webhookUrl = userSettings.discordWebhook;

  console.log(`[EVENT] Received ${eventType} for ${avatarName} (Owner: ${cleanId}). Webhook: ${webhookUrl ? "CONFIGURED" : "NOT SET"}`);

  if (webhookUrl && webhookUrl.includes("discord.com/api/webhooks")) {
    try {
      const isBreach = (eventType === "breach");
      const isVip = (eventType === "vip_visit");
      const device = db.devices[cleanId] || { parcelName: "Parcel", region: "Region" };

      let title = "🟢 Visitor Detected";
      let color = 0x00e676; // Yeşil

      if (isBreach) {
        title = "🚨 Intruder Ejected";
        color = 0xff3b30; // Kırmızı
      } else if (isVip) {
        title = "✨ VIP Whitelisted Guest Arrived";
        color = 0x00e5ff; // Mavi
      }

      const dRes = await fetch(webhookUrl.trim(), {
        method: "POST", 
        headers: { 
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        body: JSON.stringify({
          embeds: [{
            title: title,
            color: color,
            fields: [
              { name: "Avatar", value: avatarName, inline: true },
              { name: "Location", value: `${device.parcelName} (${device.region})`, inline: true },
              { name: "Status / Details", value: reason || (isBreach ? "Unauthorized" : "Welcome"), inline: false }
            ],
            footer: { text: "ICE Security Autonomous Defense Grid" },
            timestamp: new Date().toISOString()
          }]
        })
      });

      console.log(`[DISCORD] Dispatch status: ${dRes.status}`);
    } catch (err) {
      console.error("[DISCORD] Send failed:", err);
    }
  }

  res.json({ status: "success" });
});

// 7. Manuel Eject Kuyruğu
app.post('/api/manual-action', async (req, res) => {
  const { ownerId, targetName } = req.body;
  if (!ownerId) return res.status(400).json({ error: "Missing ID" });

  const cleanId = String(ownerId).toLowerCase().trim();
  if (!db.devices[cleanId]) db.devices[cleanId] = {};
  const device = db.devices[cleanId];

  device.kickQueue = device.kickQueue || [];
  device.kickQueue.push(targetName);
  saveDB();

  res.json({ status: "success" });

  if (device.orbUrl) {
    try {
      await fetch(device.orbUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "MANUAL_EJECT", targetName }),
        signal: AbortSignal.timeout(2000)
      });
    } catch (err) {}
  }
});

// 8. Panel Veri Alma (PIN Korumalı)
app.get('/api/settings', (req, res) => {
  const ownerId = req.query.id;
  const clientPin = req.query.pin;
  if (!ownerId) return res.json({ status: "alive" });

  const cleanId = String(ownerId).toLowerCase().trim();
  const existingPin = db.auth[cleanId];
  if (existingPin && String(clientPin).trim() !== existingPin) {
    return res.status(401).json({
      status: "auth_required",
      hasPinSet: true,
      error: "Authentication required."
    });
  }

  const device = db.devices[cleanId] || {};
  const logs = db.logs[cleanId] || [];
  res.json({
    status: "success",
    hasPinSet: !!existingPin,
    orbConnected: !!device.orbUrl,
    parcelName: device.parcelName || "Standby",
    region: device.region || "Standby",
    onlineAvatars: device.onlineAvatars || [],
    totalVisits: logs.length,
    visitorLogs: logs.slice(0, 30),
    config: db.settings[cleanId] || {}
  });
});

// 9. Orb Mikro-Senkronizasyon
app.get('/api/orb-sync', (req, res) => {
  const ownerId = req.query.id;
  const orbUrl = req.query.url;
  if (!ownerId) return res.json({});
  
  const cleanId = String(ownerId).toLowerCase().trim();
  if (!db.devices[cleanId]) db.devices[cleanId] = {};
  const device = db.devices[cleanId];
  if (orbUrl && orbUrl.startsWith("http")) device.orbUrl = orbUrl;

  const settings = db.settings[cleanId] || {};
  const cleanList = (arr) => Array.isArray(arr) ? arr.map(s => String(s).trim().toLowerCase()).filter(s => s.length > 0) : [];

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
    w: cleanList(settings.whitelist).join("|"),
    b: cleanList(settings.blacklist).join("|"),
    age: parseInt(settings.minAge) || 0,
    alt: settings.altitudeMode || "all",
    minZ: parseInt(settings.minZ) || 0,
    maxZ: parseInt(settings.maxZ) || 4000,
    fx: (settings.enableFx === 0 ? 0 : 1),
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

  const cleanId = String(targetId).toLowerCase().trim();
  const existingPin = db.auth[cleanId];
  if (existingPin && String(clientPin).trim() !== existingPin) {
    return res.status(401).json({ status: "auth_required", error: "Invalid PIN." });
  }

  db.settings[cleanId] = settings;
  saveDB();
  console.log(`[SETTINGS] Updated for ${cleanId}. Webhook: ${settings.discordWebhook ? "YES" : "NO"}`);

  const device = db.devices[cleanId];
  if (device && device.orbUrl) {
    try {
      await fetch(device.orbUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "TRIGGER_SYNC" }), 
        signal: AbortSignal.timeout(2000)
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
  if (!webhookUrl || !webhookUrl.includes("discord.com/api/webhooks")) {
      return res.status(400).json({ error: "Invalid Discord Webhook URL" });
  }
  
  try {
    const dRes = await fetch(webhookUrl.trim(), {
      method: "POST", 
      headers: { 
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      },
      body: JSON.stringify({ 
        embeds: [{ 
          title: "🛡️ ICE Security Test Dispatch", 
          description: "Discord webhook integration operational.",
          color: 0x00e5ff,
          fields: [
            { name: "Status", value: "Verified & Connected", inline: true },
            { name: "System", value: "ICE Security Pro v2.0", inline: true }
          ],
          footer: { text: "Autonomous Parcel Defense Grid" },
          timestamp: new Date().toISOString()
        }] 
      })
    });
    
    if (dRes.ok || dRes.status === 204) return res.json({ status: "success" });
    const errorText = await dRes.text();
    return res.status(400).json({ error: `Discord HTTP ${dRes.status}: ${errorText}` });
  } catch (e) {
    res.status(500).json({ error: "Backend network failed: " + e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`ICE Security Backend running on port ${PORT}`));
