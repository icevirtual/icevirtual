const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = path.join(__dirname, 'database.json');

let db = { devices: {}, settings: {}, logs: {} };
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error("DB Load error:", e);
  }
}

function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("DB Save error:", e);
  }
}

// 1. Register Orb
app.post('/api/register-orb', (req, res) => {
  const { ownerId, orbUrl, parcelName, region } = req.body;
  if (!ownerId || !orbUrl) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  db.devices[ownerId] = {
    orbUrl,
    parcelName: parcelName || "Unknown Parcel",
    region: region || "Unknown Region",
    lastSeen: new Date().toISOString()
  };
  saveDB();

  console.log(`[ORB REGISTERED] Owner: ${ownerId} | URL: ${orbUrl}`);
  res.json({ status: "success" });
});

// 2. Live Presence
app.post('/api/update-live-presence', (req, res) => {
  const { ownerId, onlineAvatars } = req.body;
  if (!ownerId) return res.status(400).json({ error: "Missing ownerId" });

  if (!db.devices[ownerId]) {
    db.devices[ownerId] = { orbUrl: "", parcelName: "Unknown", region: "Unknown" };
  }

  db.devices[ownerId].onlineAvatars = Array.isArray(onlineAvatars) ? onlineAvatars : [];
  db.devices[ownerId].lastPresenceUpdate = new Date().toISOString();
  saveDB();

  res.json({ status: "success" });
});

// 3. Record Event
app.post('/api/record-event', async (req, res) => {
  const { ownerId, eventType, avatarName, reason } = req.body;
  if (!ownerId || !avatarName) return res.status(400).json({ error: "Missing fields" });

  if (!db.logs[ownerId]) db.logs[ownerId] = [];

  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const logItem = {
    name: avatarName,
    type: eventType || "visit",
    reason: reason || "",
    time: timeStr,
    timestamp: Date.now()
  };

  db.logs[ownerId].unshift(logItem);
  if (db.logs[ownerId].length > 100) db.logs[ownerId].pop();
  saveDB();

  const userSettings = db.settings[ownerId] || {};
  const webhookUrl = userSettings.discordWebhook;

  if (webhookUrl && webhookUrl.startsWith("https://discord.com/api/webhooks/")) {
    try {
      const isBreach = (eventType === "breach");
      const title = isBreach ? "🚨 Intruder Ejected" : "🟢 Visitor Detected";
      const color = isBreach ? 0xff3b30 : 0x00e676;
      const device = db.devices[ownerId] || { parcelName: "Parcel", region: "Region" };

      const discordPayload = {
        embeds: [{
          title: `ICE Security • ${title}`,
          color: color,
          fields: [
            { name: "Avatar", value: avatarName, inline: true },
            { name: "Event Type", value: isBreach ? "Ejection / Home TP" : "Parcel Entry", inline: true },
            { name: "Location", value: `${device.parcelName} (${device.region})`, inline: false },
            { name: "Details", value: reason || (isBreach ? "Unauthorized entry" : "Entered parcel boundaries"), inline: false }
          ],
          footer: { text: "ICE Security Autonomous Defense Grid" },
          timestamp: new Date().toISOString()
        }]
      };

      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload)
      });
    } catch (err) {
      console.error("Discord send failed:", err);
    }
  }

  res.json({ status: "success" });
});

// 4. Remote Kick
app.post('/api/manual-action', async (req, res) => {
  const { ownerId, targetName } = req.body;
  const device = db.devices[ownerId];

  if (!device || !device.orbUrl) {
    return res.status(404).json({ error: "In-world orb not connected" });
  }

  try {
    const slRes = await fetch(device.orbUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "MANUAL_EJECT", targetName })
    });
    const slData = await slRes.json();
    res.json(slData);
  } catch (err) {
    res.status(500).json({ error: "Failed to communicate with in-world orb" });
  }
});

// 5. Get Settings
app.get('/api/settings', (req, res) => {
  const ownerId = req.query.id;
  if (!ownerId) {
    return res.json({ status: "alive", message: "ICE Backend Active" });
  }

  const device = db.devices[ownerId] || {};
  const settings = db.settings[ownerId] || {};
  const logs = db.logs[ownerId] || [];

  res.json({
    status: "success",
    orbConnected: !!device.orbUrl,
    parcelName: device.parcelName || "Standby / Unregistered",
    region: device.region || "Standby",
    onlineAvatars: device.onlineAvatars || [],
    totalVisits: logs.length,
    visitorLogs: logs.slice(0, 30),
    config: settings
  });
});

// 6. Save Settings & Push to Orb
app.post('/api/settings', async (req, res) => {
  const { ownerId } = req.query;
  const settings = req.body;
  const targetId = ownerId || settings.ownerId;

  if (!targetId) return res.status(400).json({ error: "Missing owner ID" });

  db.settings[targetId] = settings;
  saveDB();

  const device = db.devices[targetId];
  if (device && device.orbUrl) {
    try {
      let cleanWhitelist = [];
      if (Array.isArray(settings.whitelist)) {
        cleanWhitelist = settings.whitelist.map(s => String(s).trim().toLowerCase()).filter(s => s.length > 0);
      }
      const whitelistStr = cleanWhitelist.join("|"); // Virgül yerine çakışmasız boru (|) karakteri

      const slRes = await fetch(device.orbUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "SYNC_SETTINGS",
          active: (settings.mode === "lockdown").toString(),
          mode: settings.mode,
          actionType: settings.action,
          enableCountdown: (settings.enableCountdown === 1 || settings.enableCountdown === true).toString(),
          countdownSeconds: Number(settings.countdown || 10).toString(),
          whitelist: whitelistStr
        })
      });
      const slData = await slRes.json();
      return res.json({ status: "success", orbResponse: slData });
    } catch (e) {
      return res.json({ status: "warning", error: "Saved locally, orb unreachable" });
    }
  }

  res.json({ status: "warning", error: "Saved locally, orb not registered yet" });
});

// 7. Discord Test
app.post('/api/test-discord', async (req, res) => {
  const { webhookUrl, ownerId } = req.body;
  if (!webhookUrl) return res.status(400).json({ error: "Missing webhook URL" });

  try {
    const payload = {
      embeds: [{
        title: "🛡️ ICE Security • System Connected",
        description: "Your Discord webhook has been successfully linked to your ICE Security Studio.",
        color: 0x00bcd4,
        fields: [
          { name: "Owner UUID", value: ownerId || "Direct Test", inline: true },
          { name: "Status", value: "Verified & Ready", inline: true }
        ],
        footer: { text: "ICE Security Engine" },
        timestamp: new Date().toISOString()
      }]
    };

    const dRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (dRes.ok) return res.json({ status: "success" });
    return res.status(400).json({ error: "Discord rejected request" });
  } catch (e) {
    res.status(500).json({ error: "Network error connecting to Discord" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`ICE Security Backend running on port ${PORT}`);
});
