const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 60000; // 60 secondes max par requête

app.use(express.json());
app.use(express.static('public'));

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: 'Numéro requis' });

    phone = phone.replace(/[^0-9]/g, '');
    if (phone.length < 7) return res.status(400).json({ error: 'Numéro invalide' });

    const sessionFolder = `./session_${Date.now()}`;
    let pairingCodeRequested = false;
    let finished = false;

    // Nettoyage du dossier de session
    const cleanup = () => {
        try {
            if (fs.existsSync(sessionFolder)) {
                fs.rmSync(sessionFolder, { recursive: true, force: true });
            }
        } catch (_) {}
    };

    // Timeout global de 60s pour éviter les requêtes bloquées
    const globalTimeout = setTimeout(() => {
        if (!finished) {
            finished = true;
            cleanup();
            if (!res.headersSent) {
                res.status(504).json({ error: 'Délai dépassé — WhatsApp ne répond pas' });
            }
        }
    }, REQUEST_TIMEOUT);

    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '22.04.4'],
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // ✅ Fix principal : requestPairingCode déclenché par l'événement qr
            // (= signal que le socket est prêt), pas par un délai arbitraire
            if (qr && !pairingCodeRequested && !sock.authState.creds.registered) {
                pairingCodeRequested = true;
                try {
                    const code = await sock.requestPairingCode(phone);
                    if (!res.headersSent) {
                        res.json({ code });
                    }
                } catch (err) {
                    finished = true;
                    clearTimeout(globalTimeout);
                    cleanup();
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Impossible de générer le code : ' + err.message });
                    }
                }
            }

            // ✅ Fix : gestion de la connexion réussie (utilisateur a entré le code)
            if (connection === 'open') {
                console.log('✅ WhatsApp connecté ! Envoi des identifiants...');
                await delay(3000);

                const credsPath = path.join(sessionFolder, 'creds.json');
                if (fs.existsSync(credsPath)) {
                    const jid = `${phone}@s.whatsapp.net`;
                    const credsRaw = fs.readFileSync(credsPath, 'utf8');
                    const sessionBase64 = Buffer.from(credsRaw).toString('base64');

                    await sock.sendMessage(jid, {
                        document: fs.readFileSync(credsPath),
                        mimetype: 'application/json',
                        fileName: 'creds.json',
                        caption: 'Voici ton fichier creds.json !'
                    });

                    await sock.sendMessage(jid, {
                        text: `KnightBot!${sessionBase64}`
                    });
                }

                setTimeout(() => {
                    finished = true;
                    clearTimeout(globalTimeout);
                    try { sock.ws.close(); } catch (_) {}
                    cleanup();
                }, 5000);
            }

            // ✅ Fix : gestion de la fermeture de connexion pendant le pairing
            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = reason === DisconnectReason.loggedOut;

                if (!finished && !isLoggedOut) {
                    finished = true;
                    clearTimeout(globalTimeout);
                    cleanup();
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Connexion fermée par WhatsApp (code: ' + reason + ')' });
                    }
                }
            }
        });

    } catch (error) {
        finished = true;
        clearTimeout(globalTimeout);
        cleanup();
        console.error(error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Erreur serveur : ' + error.message });
        }
    }
});

app.listen(PORT, () => console.log(`✅ Serveur prêt sur le port ${PORT}`));
