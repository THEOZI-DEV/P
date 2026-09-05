import {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay,
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

const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

const tempDvmsys = {};

async function startUserBot(phoneNumber, isPairing = false) {
    const sessionName = `session_${phoneNumber.replace(/[^0-9]/g, '')}`;
    const sessionPath = path.join(sessionsDir, sessionName);

    if (isPairing) {
        if (tempDvmsys[sessionName]) {
            try { tempDvmsys[sessionName].end(); delete tempDvmsys[sessionName]; } catch (e) {}
        }
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
    }

    fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const dvmsy = makeWASocket({
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

    tempDvmsys[sessionName] = dvmsy;
    dvmsy.ev.on("creds.update", saveCreds);

    return { dvmsy, sessionPath, sessionName };
}

app.get("/pair", async (req, res) => {
    const num = (req.query.phone || req.query.number || '').replace(/\D/g, '')
    if (!num || num.length < 7) return res.json({ error: 'Numéro invalide.' })

    try {
        const code = await new Promise(async (resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timeout — réessaie')), 45000)
            let codeSent = false

            const { dvmsy, sessionPath, sessionName } = await startUserBot(num, true)

            dvmsy.ev.on('connection.update', async ({ connection }) => {

                if (connection === 'connecting' && !codeSent) {
                    await delay(1500)
                    try {
                        const pairCode = await dvmsy.requestPairingCode(num.trim(), 'INAMIXMD')
                        codeSent = true
                        clearTimeout(timer)
                        resolve(pairCode)
                    } catch (err) {
                        console.warn('[pair] requestPairingCode échoué sur connecting:', err.message)
                    }
                }

                // ✅ Handler open — géré même après codeSent
                if (connection === 'open') {
                    if (!codeSent) {
                        clearTimeout(timer)
                        reject(new Error('Session déjà connectée, supprime-la d\'abord.'))
                    } else {
                        // ✅ Connexion confirmée — les creds sont bien sauvegardés
                        console.log(`✅ [${num}] Connecté et creds sauvegardés !`)
                        // Nettoyage après 10s
                        setTimeout(() => {
                            try { dvmsy.end(); } catch (_) {}
                            delete tempDvmsys[sessionName]
                        }, 10000)
                    }
                }

                if (connection === 'close' && !codeSent) {
                    clearTimeout(timer)
                    reject(new Error('Connexion fermée avant la génération du code.'))
                }
            })
        })

        res.json({ code })
    } catch (e) {
        res.json({ error: e.message || 'Erreur lors de la génération du code.' })
    }
});

app.listen(PORT, () => console.log(`✅ Serveur prêt sur le port ${PORT}`));
