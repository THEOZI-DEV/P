import {
    default as makeWASocket,
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

app.get('/pair', async (req, res) => {
    const num = (req.query.phone || '').replace(/\D/g, '');
    if (!num || num.length < 7) return res.json({ error: 'Numéro invalide.' });

    const sessionPath = path.join(SESSIONS_DIR, num);
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        let version;
        try { version = (await fetchLatestBaileysVersion()).version; }
        catch { version = [2, 3000, 1015901307]; }

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            markOnlineOnConnect: false,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
        });

        sock.ev.on("creds.update", saveCreds);

        // ✅ Pattern exact : setTimeout 6s + check !registered
        if (!sock.authState.creds.registered) {
            console.log(`⏳ [PAIRING] Waiting 6s for ${num}...`);
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(num);
                    const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                    console.log(`🔑 [PAIRING] Code: ${formattedCode}`);
                    if (!res.headersSent) res.json({ code: formattedCode });
                } catch (e) {
                    console.error(`[PAIRING] Error:`, e.message);
                    if (!res.headersSent) res.json({ error: 'Erreur génération du code.' });
                }
            }, 6000);
        } else {
            if (!res.headersSent) res.json({ error: 'Session déjà connectée.' });
        }

        sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (connection === 'close') {
                console.log(`❌ [${num}] Connexion fermée: ${reason}`);
                if (reason !== DisconnectReason.loggedOut && reason !== 401) {
                    // pas de reconnexion auto sur un pairing one-shot
                }
            } else if (connection === 'open') {
                console.log(`✅ [${num}] Connecté !`);
            }
        });

    } catch (e) {
        console.error(e);
        if (!res.headersSent) res.json({ error: e.message });
    }
});

app.listen(PORT, () => console.log(`✅ Serveur prêt sur le port ${PORT}`));
