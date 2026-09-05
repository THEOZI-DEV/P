import {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
} from "@whiskeysockets/baileys";
import pino from "pino";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ✅ Map exactement comme dans le code source
const activeSockets = new Map();

async function startWhatsAppSession(identifier, res) {
    const sessionPath = path.join(SESSIONS_DIR, identifier);
    console.log(`🔌 [INIT] Starting: ${identifier}`);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        let version;
        try { version = (await fetchLatestBaileysVersion()).version; } 
        catch { version = [2, 3000, 1015901307]; }

        // ✅ Config identique au code source
        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
        });

        // ✅ global.globalSock + activeSockets.set — exactement comme le code source
        global.globalSock = sock;
        activeSockets.set(identifier, sock);
        sock.ev.on("creds.update", saveCreds);

        // ✅ Pairing code — même pattern : setTimeout 6s + check !registered
        if (!sock.authState.creds.registered) {
            console.log(`⏳ [PAIRING] Waiting 6s...`);
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(identifier);
                    const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                    console.log(`🔑 [PAIRING] Code: ${formattedCode}`);
                    if (!res.headersSent) res.json({ code: formattedCode });
                } catch (e) {
                    console.error(`🩸 [PAIRING]`, e.message);
                    if (!res.headersSent) res.json({ error: e.message });
                }
            }, 6000);
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`❌ [${identifier}] Closed: ${reason}`);
                if (reason !== DisconnectReason.loggedOut && reason !== 401) {
                    startWhatsAppSession(identifier, { headersSent: true });
                } else {
                    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
                    activeSockets.delete(identifier);
                }
            } else if (connection === 'open') {
                console.log(`✅ [${identifier}] ONLINE!`);
            }
        });

    } catch (e) {
        console.error(`[PAIR] Erreur globale:`, e.message);
        activeSockets.delete(identifier);
        if (!res.headersSent) res.json({ error: e.message });
    }
}

app.get('/pair', async (req, res) => {
    const num = (req.query.phone || '').replace(/\D/g, '');
    if (!num || num.length < 7) return res.json({ error: 'Numéro invalide.' });

    // Fermer l'ancienne session si elle existe
    if (activeSockets.has(num)) {
        const s = activeSockets.get(num);
        try { s.ev.removeAllListeners(); s.ws.close(); s.end(); } catch (_) {}
        activeSockets.delete(num);
    }

    const sessionPath = path.join(SESSIONS_DIR, num);
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });

    fs.mkdirSync(sessionPath, { recursive: true });

    startWhatsAppSession(num, res);
});

app.listen(PORT, () => console.log(`✅ Serveur prêt sur le port ${PORT}`));
