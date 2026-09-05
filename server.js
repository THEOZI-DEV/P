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

// ✅ Objet global — exactement comme tempDvmsys dans index.js
const tempDvmsys = {};

app.get('/pair', async (req, res) => {
    const num = (req.query.phone || '').replace(/\D/g, '');
    if (!num || num.length < 7) return res.json({ error: 'Numéro invalide.' });

    const sessionName = `session_${num}`;
    const sessionPath = path.join(SESSIONS_DIR, sessionName);

    // Fermer l'ancienne session si elle existe
    if (tempDvmsys[sessionName]) {
        try { tempDvmsys[sessionName].end(); delete tempDvmsys[sessionName]; } catch (e) {}
    }
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    fs.mkdirSync(sessionPath, { recursive: true });

    console.log(`[PAIR] Demande pour: ${num}`);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        // ✅ Config identique à index.js
        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
            },
            syncFullHistory: false,
            keepAliveIntervalMs: 30000,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
        });

        // ✅ Stockage global comme tempDvmsys[sessionName] dans index.js
        tempDvmsys[sessionName] = sock;
        sock.ev.on("creds.update", saveCreds);

        if (!sock.authState.creds.registered) {
            console.log(`[PAIR] Attente 6s...`);
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(num);
                    const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                    console.log(`[PAIR] Code: ${formattedCode}`);
                    if (!res.headersSent) res.json({ code: formattedCode });
                } catch (e) {
                    console.error(`[PAIR] Erreur:`, e.message);
                    if (!res.headersSent) res.json({ error: e.message });
                    delete tempDvmsys[sessionName];
                }
            }, 6000);
        } else {
            res.json({ error: 'Session déjà connectée.' });
        }

        sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
            console.log(`[PAIR][${num}] ${connection}`);

            if (connection === 'open') {
                console.log(`[PAIR][${num}] ✅ Connecté !`);
                setTimeout(() => {
                    try { sock.end(); } catch (_) {}
                    delete tempDvmsys[sessionName];
                }, 10000);
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`[PAIR][${num}] Fermé: ${reason}`);
                delete tempDvmsys[sessionName];
            }
        });

    } catch (e) {
        console.error(`[PAIR] Erreur globale:`, e.message);
        delete tempDvmsys[sessionName];
        if (!res.headersSent) res.json({ error: e.message });
    }
});

app.listen(PORT, () => console.log(`✅ Serveur prêt sur le port ${PORT}`));
