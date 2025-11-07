import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import OpenAI from "openai";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// === OpenAI Setup ===
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === Session Storage ===
const sessions = new Map();

// === Chat Endpoint (nV-kompatibel) ===
app.post("/chat", async (req, res) => {
  const { message, userLang, userEmail } = req.body;

  // Session identifizieren
  const sessionId = userEmail || req.ip;
  const session = sessions.get(sessionId) || { stage: "start", data: {} };

  try {
    let reply = "";
    const text = (message || "").toLowerCase();

    if (session.stage === "start") {
      if (text.includes("termin")) {
        reply = "Klar! Für wann möchten Sie den Termin vereinbaren?";
        session.stage = "awaiting_date";
      } else {
        // AI-Prompt
        const prompt = `
Nutzer: "${message}" (${userLang || "de"})
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
        reply = "Bitte geben Sie ein Datum an, z. B. 08.11.2025.";
      }
    } else if (session.stage === "awaiting_time") {
      const timeMatch = text.match(/\d{1,2}(:\d{2})?/);
      if (timeMatch) {
        session.data.time = timeMatch[0];
        reply = `Perfekt. Wie lange soll das Meeting dauern? (z. B. 30 oder 60 Minuten)`;
        session.stage = "awaiting_duration";
      } else {
        reply = "Bitte geben Sie eine Uhrzeit an, z. B. 10:00 Uhr.";
      }
    } else if (session.stage === "awaiting_duration") {
      const durMatch = text.match(/\d+/);
      if (durMatch) {
        session.data.duration = parseInt(durMatch[0], 10);
        reply = `Alles klar. Bitte geben Sie Ihre E-Mail-Adresse an, damit ich den Termin eintragen kann.`;
        session.stage = "awaiting_email";
      } else {
        reply = "Wie lange soll der Termin dauern (in Minuten)?";
      }
    } else if (session.stage === "awaiting_email") {
      const emailMatch = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
      if (emailMatch) {
        session.data.email = emailMatch[0];
        // Kalender-Logik vorerst deaktiviert
        reply = `✅ Test: E-Mail erhalten: ${session.data.email}. Terminlogik ist für Debug deaktiviert.`;
        session.stage = "completed";
      } else {
        reply = "Bitte geben Sie eine gültige E-Mail-Adresse an.";
      }
    } else if (session.stage === "completed") {
      reply = "✅ Der Termin wurde bereits vereinbart. Möchten Sie noch etwas besprechen?";
    }

    // Session speichern
    sessions.set(sessionId, session);

    res.json({ reply });
  } catch (err) {
    console.error("❌ Fehler bei /chat:", err);
    res.status(500).json({ error: err.message || "Fehler bei der Kommunikation mit der AI." });
  }
});

// === Frontend ===
const frontendPath = path.join(__dirname, "../frontend");
app.use(express.static(frontendPath));
app.get("/", (req, res) => res.sendFile(path.join(frontendPath, "indexnV.html")));

// === Server starten ===
const PORT = process.env.PORT || 3011;
app.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`));
