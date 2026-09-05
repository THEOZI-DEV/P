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

app.get('/pair', async (req, res) => {
    const num = (req.query.phone || '').replace(/\D/g, '');
    if (!num || num.length < 7) return res.json({ error: 'Numéro invalide.' });

    const sessionPath = path.join(SESSIONS_DIR, num);
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });

    console.log(`[PAIR] Demande pour: ${num}`);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        let version;
        try { version = (await fetchLatestBaileysVersion()).version; }
        catch { version = [2, 3000, 1015901307]; }

        console.log(`[PAIR] Version WA: ${version}`);

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

        if (!sock.authState.creds.registered) {
            console.log(`[PAIR] Socket créé, attente 6s...`);
            setTimeout(async () => {
                try {
                    console.log(`[PAIR] Appel requestPairingCode...`);
                    const code = await sock.requestPairingCode(num);
                    console.log(`[PAIR] Code reçu: ${code}`);
                    const formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
                    if (!res.headersSent) res.json({ code: formattedCode });
                } catch (e) {
                    console.error(`[PAIR] Erreur requestPairingCode:`, e);
                    if (!res.headersSent) res.json({ error: e.message || 'Erreur inconnue' });
                }
            }, 6000);
        } else {
            res.json({ error: 'Session déjà connectée.' });
        }

        sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
            console.log(`[PAIR] connection.update: ${connection}`);
            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`[PAIR] Connexion fermée: ${reason}`);
            }
        });

    } catch (e) {
        console.error(`[PAIR] Erreur globale:`, e);
        if (!res.headersSent) res.json({ error: e.message });
    }
});

app.listen(PORT, () => console.log(`✅ Serveur prêt sur le port ${PORT}`));
