const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ── Même pattern que index.js : startUserBot ──────────────────────────────
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

async function startUserBot(phoneNumber, isPairing = false) {
    const sessionName = `session_${phoneNumber.replace(/[^0-9]/g, '')}`;
    const sessionPath = path.join(sessionsDir, sessionName);

    // Suppression de l'ancienne session si on demande un nouveau pairing
    if (isPairing) {
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
    }

    // Toujours s'assurer que le dossier existe avant useMultiFileAuthState
    fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    // ── Config identique à index.js ───────────────────────────────────────
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

    sock.ev.on("creds.update", saveCreds);
    return sock;
}

// ── Route /pair — copie exacte du pattern index.js ───────────────────────
app.get('/pair', async (req, res) => {
    const num = (req.query.phone || '').replace(/\D/g, '');
    if (!num || num.length < 7) return res.json({ error: 'Numéro invalide.' });

    try {
        const code = await new Promise(async (resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timeout — réessaie')), 45000);
            let codeSent = false;

            const sock = await startUserBot(num, true);

            sock.ev.on('connection.update', async ({ connection }) => {
                if (codeSent) return;

                if (connection === 'connecting') {
                    await delay(1500);
                    try {
                        const pairCode = await sock.requestPairingCode(num.trim());
                        codeSent = true;
                        clearTimeout(timer);
                        resolve(pairCode);
                    } catch (err) {
                        console.warn('[pair] requestPairingCode échoué sur connecting:', err.message);
                    }
                } else if (connection === 'open' && !codeSent) {
                    clearTimeout(timer);
                    reject(new Error('Session déjà connectée, supprime-la d\'abord.'));
                } else if (connection === 'close' && !codeSent) {
                    clearTimeout(timer);
                    reject(new Error('Connexion fermée avant la génération du code.'));
                }
            });
        });

        res.json({ code });
    } catch (e) {
        res.json({ error: e.message || 'Erreur lors de la génération du code.' });
    }
});

app.listen(PORT, () => console.log(`✅ Serveur prêt sur le port ${PORT}`));
