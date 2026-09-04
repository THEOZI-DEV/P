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

app.get('/pair', async (req, res) => {
    let phone = (req.query.phone || '').replace(/[^0-9]/g, '');
    if (!phone || phone.length < 7) return res.status(400).json({ error: 'Numéro invalide.' });

    const sessionFolder = `./session_${Date.now()}`;
    fs.mkdirSync(sessionFolder, { recursive: true });

    const cleanup = () => {
        try {
            if (fs.existsSync(sessionFolder))
                fs.rmSync(sessionFolder, { recursive: true, force: true });
        } catch (_) {}
    };

    try {
        const code = await new Promise(async (resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Timeout — WhatsApp ne répond pas')), 45000);
            let codeSent = false;

            const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
                },
                logger: pino({ level: 'silent' }),
                printQRInTerminal: false,
                browser: ['Ubuntu', 'Chrome', '20.0.04'],
            });

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
                if (codeSent) return;

                // ✅ Même pattern que index.js : connecting + delay(1500)
                if (connection === 'connecting') {
                    await delay(1500);
                    try {
                        const pairCode = await sock.requestPairingCode(phone);
                        codeSent = true;
                        clearTimeout(timer);
                        resolve(pairCode);
                    } catch (err) {
                        console.warn('[pair] requestPairingCode échoué:', err.message);
                    }
                }

                if (connection === 'open' && !codeSent) {
                    clearTimeout(timer);
                    reject(new Error('Session déjà connectée.'));
                }

                if (connection === 'close' && !codeSent) {
                    clearTimeout(timer);
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    reject(new Error('Connexion fermée (code: ' + reason + ')'));
                }

                // Envoi des creds après connexion réussie
                if (connection === 'open') {
                    await delay(3000);
                    const credsPath = path.join(sessionFolder, 'creds.json');
                    if (fs.existsSync(credsPath)) {
                        const jid = `${phone}@s.whatsapp.net`;
                        const sessionBase64 = Buffer.from(fs.readFileSync(credsPath, 'utf8')).toString('base64');
                        await sock.sendMessage(jid, {
                            document: fs.readFileSync(credsPath),
                            mimetype: 'application/json',
                            fileName: 'creds.json',
                            caption: 'Voici ton fichier creds.json !'
                        });
                        await sock.sendMessage(jid, { text: `KnightBot!${sessionBase64}` });
                    }
                    setTimeout(() => {
                        try { sock.ws.close(); } catch (_) {}
                        cleanup();
                    }, 5000);
                }
            });
        });

        res.json({ code });

    } catch (e) {
        cleanup();
        res.status(500).json({ error: e.message || 'Erreur lors de la génération du code.' });
    }
});

app.listen(PORT, () => console.log(`✅ Serveur prêt sur le port ${PORT}`));
