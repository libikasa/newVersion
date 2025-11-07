import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { google } from "googleapis";
import OpenAI from "openai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({
  origin: (origin, callback) => {
    const whitelist = [
      "http://localhost:3011",
      "https://smsbot-rstj.onrender.com"
    ];
    if (!origin || whitelist.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS nicht erlaubt"));
    }
  },
  credentials: true,
}));


app.use(express.json());

// === Google OAuth Setup ===
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const TOKEN_FILE = path.join(__dirname, "token.json");

function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}

function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_FILE));
}

// === OpenAI Setup ===
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === Simple session storage (per userEmail or IP) ===
const sessions = new Map();

// === Google OAuth Routes ===
app.get("/setup/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/userinfo.email",
      "openid",
    ],
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Kein Code erhalten.");

  try {
    const { tokens } = await oauth2Client.getToken(code);
    saveToken(tokens);
    res.send("<h2>✅ Kalender erfolgreich verbunden! Bot ist einsatzbereit.</h2>");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Fehler bei der Google-Verbindung.");
  }
});

// === Kalender-Helper ===
async function isSlotFree(authClient, start, end) {
  const calendar = google.calendar({ version: "v3", auth: authClient });
  const events = await calendar.events.list({
    calendarId: "primary",
    timeMin: start,
    timeMax: end,
    singleEvents: true,
  });
  return events.data.items.length === 0;
}

async function createEvent(authClient, { summary, start, end, attendeeEmail }) {
  const calendar = google.calendar({ version: "v3", auth: authClient });

  const event = {
    summary,
    start: { dateTime: start },
    end: { dateTime: end },
    attendees: [{ email: attendeeEmail }],
    conferenceData: {
      createRequest: {
        requestId: `meet-${Date.now()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };

  const response = await calendar.events.insert({
    calendarId: "primary",
    resource: event,
    conferenceDataVersion: 1,
    sendUpdates: "all",
  });

  return response.data;
}

// === Chat Endpoint ===
app.post("/chat", async (req, res) => {
  const { message, userLang, userEmail } = req.body;
  const tokens = loadToken();
  if (!tokens)
    return res.status(400).send({
      error: "Bot ist nicht verbunden. Bitte zuerst Google Setup durchführen.",
    });

  oauth2Client.setCredentials(tokens);

  // Sitzung identifizieren
  const sessionId = userEmail || req.ip;
  const session = sessions.get(sessionId) || { stage: "start", data: {} };

  try {
    let reply = "";
    const text = message.toLowerCase();

    // === STAGE LOGIC ===
    if (session.stage === "start") {
      if (text.includes("termin")) {
        reply = "Klar! Für wann möchten Sie den Termin vereinbaren?";
        session.stage = "awaiting_date";
      } else {
        const prompt = `
        Nutzer: "${message}" (${userLang})
        Antworte kurz, freundlich und natürlich.
        Thema: Immobilien, Hauskauf, Finanzierung.
        `;
        const aiRes = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
        });
        reply = aiRes.choices[0].message.content.trim();
      }
    } else if (session.stage === "awaiting_date") {
      const dateMatch = text.match(/\d{1,2}\.\d{1,2}\.\d{4}/);
      if (dateMatch) {
        session.data.date = dateMatch[0];
        reply = `Super! Zu welcher Uhrzeit am ${dateMatch[0]} würde es Ihnen passen?`;
        session.stage = "awaiting_time";
      } else {
        reply = "Bitte geben Sie ein Datum an, z. B. 08.11.2025.";
      }
    } else if (session.stage === "awaiting_time") {
      const timeMatch = text.match(/\d{1,2}(:\d{2})?/);
      if (timeMatch) {
        session.data.time = timeMatch[0];
        reply = `Perfekt. Wie lange soll das Meeting dauern? (z. B. 30 oder 60 Minuten)`;
        session.stage = "awaiting_duration";
      } else {
        reply = "Bitte geben Sie eine Uhrzeit an, z. B. 10:00 Uhr.";
      }
    } else if (session.stage === "awaiting_duration") {
      const durMatch = text.match(/\d+/);
      if (durMatch) {
        session.data.duration = parseInt(durMatch[0]);
        reply = `Alles klar. Bitte geben Sie Ihre E-Mail-Adresse an, damit ich den Termin eintragen kann.`;
        session.stage = "awaiting_email";
      } else {
        reply = "Wie lange soll der Termin dauern (in Minuten)?";
      }
    } else if (session.stage === "awaiting_email") {
      const emailMatch = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
      if (emailMatch) {
        session.data.email = emailMatch[0];
        reply = "Einen Moment, ich prüfe, ob der Termin verfügbar ist …";

        // === Termin erstellen ===
        const { date, time, duration } = session.data;
        const start = new Date(`${date.split(".").reverse().join("-")}T${time}:00`);
        const end = new Date(start.getTime() + duration * 60000);

        const free = await isSlotFree(oauth2Client, start.toISOString(), end.toISOString());
        if (!free) {
          reply = "⚠️ Dieser Zeitraum ist leider schon belegt. Bitte schlagen Sie eine andere Zeit vor.";
          session.stage = "awaiting_time";
        } else {
          const event = await createEvent(oauth2Client, {
            summary: "Beratungstermin zur Finanzierung",
            start: start.toISOString(),
            end: end.toISOString(),
            attendeeEmail: session.data.email,
          });

          reply = `✅ Termin am ${date} um ${time} wurde erfolgreich eingetragen.
📧 Einladung wurde an ${session.data.email} gesendet.
🔗 Google Meet Link: ${event.hangoutLink}`;
          session.stage = "completed";
        }
      } else {
        reply = "Bitte geben Sie eine gültige E-Mail-Adresse an.";
      }
    } else if (session.stage === "completed") {
      reply = "✅ Der Termin wurde bereits vereinbart. Möchten Sie noch etwas besprechen?";
    }

    // Sitzung speichern
    sessions.set(sessionId, session);

    res.json({ reply });
  } catch (err) {
    console.error("❌ Fehler bei /chat:", err);
    res.status(500).send({ error: "Fehler bei der Kommunikation mit der AI." });
  }
});

// === Frontend ===
const frontendPath = path.join(__dirname, "../frontend");
app.use(express.static(frontendPath));
app.get("/", (req, res) => res.sendFile(path.join(frontendPath, "indexnV.html")));

// === Server ===
const PORT = process.env.PORT || 3011;
app.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`)); 