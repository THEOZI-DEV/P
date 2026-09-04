import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay,
} from "@whiskeysockets/baileys";

import pino from "pino";
import { Boom } from "@hapi/boom";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import handlerCommand from './handler.js';
import { smsg } from './Utils/func.js';
import { autoReply } from './commands/chatbot.js';
import { trackMessage, trackHistory } from './commands/clear.js';
import { loveDetect } from './commands/couple.js';
import { linkDetection } from './commands/group.js';
import { slowmodeGuard } from './commands/admintools.js';
import { trackActivity, updatePresence } from './commands/groupinfo.js';
import { incrementCount }                from './commands/topmembers.js';
import { loadSessionSettings, saveSettings } from './commands/settings.js';
import { autoReactHook } from './commands/reactions.js';
import { resolveConnectMedia } from './commands/menu.js';
import { respond as tagRespond } from './commands/tag.js';
import { onGroupParticipants }               from './commands/welcome.js';
import { autoStatusHook }                     from './commands/autoStatus.js';
import { checkAntiBotMessage, trackCommandForAntibot } from './commands/antibot.js';
import { autoJoin } from './Utils/autoJoin.js';
import { startTelegramBot } from './telegramBot.js';
import { handleJoinRequest, startAutoApproveWorker } from './commands/autoapprove.js';
import { restoreTimers } from './commands/grouptime.js';
import { autorecord, autotype } from './commands/auto.js';
import {
    cacheMessage, cacheStatus,
    handleDeletedMessage, handleStatusReply,
} from './commands/antidelete.js';
import { detectTagall }        from './commands/antitag.js';
import { detectGroupMention }  from './commands/antigroupmention.js';
import { detectTransfert }     from './commands/antitransfert.js';
import { detectVocal }         from './commands/antivocal.js';
import { detectImage }         from './commands/antiimage.js';
import './logger.js'
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Handlers globaux — empêchent tout crash silencieux d'arrêter le panel ──
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION] Le process aurait crashé sans ce handler :', err?.stack || err?.message || err);
});
process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason)
    // Erreurs Telegram normales — pas de vrais bugs
    if (/query is too old|ETELEGRAM.*400|response timeout expired|query ID is invalid/i.test(msg)) return
    console.error('[UNHANDLED REJECTION] Promise rejetée non catchée :', reason?.stack || msg);
});

const app = express();
const port = process.env.SERVER_PORT || process.env.PORT;
const sessionsDir = path.join(__dirname, 'accounts');

// Création du dossier de stockage si absent
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

export let tempDvmsys = {};
const sessionReconnectAttempts = {};
global.msgStore = {};

// Cache des buffers média de connexion — invalidé automatiquement si le fichier change
// → lecture disque seulement si le contenu a réellement changé (mtime différent)
const _mediaBufCache = new Map(); // path → { buf, mtime }
function readMediaCached(filePath) {
    try {
        const mtime = fs.statSync(filePath).mtimeMs;
        const cached = _mediaBufCache.get(filePath);
        if (cached && cached.mtime === mtime) return cached.buf;
        // Fichier nouveau ou modifié → re-lecture
        const buf = fs.readFileSync(filePath);
        _mediaBufCache.set(filePath, { buf, mtime });
        return buf;
    } catch { return null; }
}

// Helper pour récupérer les paramètres (AntiPromote etc)
const getSetting = (type, key) => config[key] || false;

/**
 * FONCTION PRINCIPALE DE CONNEXION DU BOT
 */
export async function startUserBot(phoneNumber, isPairing = false) {
    const sessionName = `session_${phoneNumber.replace(/[^0-9]/g, '')}`;
    const sessionPath = path.join(sessionsDir, sessionName);

    // Suppression de l'ancienne session si on demande un nouveau pairing
    if (isPairing) {
        if (tempDvmsys[sessionName]) {
            try { tempDvmsys[sessionName].end(); delete tempDvmsys[sessionName]; } catch (e) { }
        }
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
    }

    // Toujours s'assurer que le dossier existe avant useMultiFileAuthState
    // Sans ça → ENOENT sur creds.json quand Baileys tente d'écrire après rmSync
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
        keepAliveIntervalMs: 30000,  // Ping WhatsApp toutes les 30s — évite le socket zombie
        connectTimeoutMs:    60000,  // Timeout de connexion 60s
        defaultQueryTimeoutMs: 60000,
    });

    tempDvmsys[sessionName] = dvmsy;

    // Vrai seulement après une connexion réussie au moins une fois.
    // Sert à distinguer un échec de pairing (jamais connecté) d'une simple
    // coupure réseau sur une session déjà active.
    let hasConnected      = false;
    let isConnected       = false; // Socket réellement vivant
    let heartbeatInterval = null;  // Ping WhatsApp toutes les 45s

    dvmsy.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            const decode = jidDecode(jid) || {};
            return decode.user && decode.server && `${decode.user}@${decode.server}` || jid;
        }
        return jid;
    };
    
    dvmsy.ev.on('messaging-history.set', (data) => {
        trackHistory(dvmsy, data)
    })

    dvmsy.ev.on("messages.upsert", async chatUpdate => {
        // Socket zombie — le socket est "open" mais mort : ignorer les messages entrants
        if (!isConnected) return;
        try {
            const msg = chatUpdate.messages[0];
            if (!msg.message) return;

            // Cache tous les messages pour antidelete (avant le filtre status)
            cacheMessage(msg);

            // Traitement des statuts (status@broadcast)
            if (msg.key.remoteJid === 'status@broadcast') {
                cacheStatus(msg);
                autoStatusHook(dvmsy, msg).catch(e => console.error('autoStatusHook error:', e.message));
                detectGroupMention(dvmsy, msg).catch(e => console.error('detectGroupMention error:', e.message));
                return;
            }

            // Enregistre le message dans le ring buffer (pour .clear)
            trackMessage(dvmsy, msg);

            const m = smsg(dvmsy, msg);

            // Slowmode : supprime le message si l'utilisateur envoie trop vite
            slowmodeGuard(dvmsy, m).catch(e => console.error('slowmodeGuard error:', e.message));

            // Chatbot absence : répondre automatiquement si activé (avant handler)
            autoReply(dvmsy, msg).catch(e => console.error('autoReply error:', e.message));

            // Détection auto des messages d'amour en groupe (couple)
            loveDetect(dvmsy, msg).catch(e => console.error('loveDetect error:', e.message));

            // Antibot : tracker les commandes + détecter les réponses de bots
            const _antibotBody   = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
            const _antibotSender = msg.key?.participant || msg.key?.remoteJid
            trackCommandForAntibot(msg.key?.remoteJid, _antibotSender, dvmsy._prefix, _antibotBody)
            checkAntiBotMessage(dvmsy, msg).catch(e => console.error('checkAntiBotMessage error:', e.message))

            // Antilink : supprime/avertit/expulse si un lien interdit est détecté
            linkDetection(dvmsy, msg).catch(e => console.error('linkDetection error:', e.message));

            // Auto-react : réagit automatiquement si activé pour cette session (.autoreact on)
            autoReactHook(dvmsy, msg).catch(e => console.error('autoReactHook error:', e.message));

            // Présence automatique : recording / composing si activé (.setautorecord on / .setautotype on)
            autorecord(dvmsy, msg).catch(e => console.error('autorecord error:', e.message));
            autotype(dvmsy, msg).catch(e => console.error('autotype error:', e.message));

            // Réponse auto quand le bot est tagué (.setreponder / .responder de settings.js)
            tagRespond(dvmsy, msg).catch(e => console.error('tagRespond error:', e.message));

            // Sauvegarde statut si l'utilisateur répond à un statut
            const ownerJid = dvmsy.user?.id?.split(':')[0] + '@s.whatsapp.net';
            handleStatusReply(dvmsy, msg, ownerJid).catch(e => console.error('handleStatusReply error:', e.message));

            // Antitag : détecte et supprime les tagall non-admin en groupe
            detectTagall(dvmsy, msg).catch(e => console.error('detectTagall error:', e.message));

            // AntiGroupMention : détecte les mentions de groupe (@everyone) en statut
            detectGroupMention(dvmsy, msg).catch(e => console.error('detectGroupMention error:', e.message));

            // AntiTransfert : détecte et sanctionne les messages transférés
            detectTransfert(dvmsy, msg).catch(e => console.error('detectTransfert error:', e.message));

            detectVocal(dvmsy, msg).catch(e => console.error('detectVocal error:', e.message));

            detectImage(dvmsy, msg).catch(e => console.error('detectImage error:', e.message));

            // Suivi d'activité (pour .memberinfo / .inactive / .groupstats)
            if (msg.key.remoteJid?.endsWith('@g.us')) {
                const senderId = msg.key.participant || msg.key.remoteJid;
                try { trackActivity(dvmsy, msg.key.remoteJid, senderId); } catch (e) { console.error('trackActivity error:', e.message); }
                try { incrementCount(dvmsy, msg.key.remoteJid, senderId); } catch (e) { console.error('incrementCount error:', e.message); }
            }

            Promise.resolve().then(() => {
                handlerCommand(dvmsy, m, msg, chatUpdate, undefined).catch(err => {
                    console.error("Erreur handler:", err.stack || err.message);
                });
            });

            // Auto-delete : supprime le message de commande de l'utilisateur après usage
            // (.autodelete on / .autodelete off via settings.js)
            try {
                const P = dvmsy._prefix || global.config?.PREFIX || '.';
                const body =
                    msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.imageMessage?.caption ||
                    msg.message?.videoMessage?.caption || '';
                if (body.startsWith(P)) {
                    const adCfg = loadSessionSettings(dvmsy);
                    if (adCfg?.autoDelete) {
                        setTimeout(async () => {
                            try {
                                await dvmsy.sendMessage(msg.key.remoteJid, { delete: msg.key });
                            } catch {}
                        }, 7000);
                    }
                }
            } catch {}
            
        } catch (err) {
            console.error("Erreur de traitement du message:", err.stack || err.message);
        }
    });
  
    // --- SUIVI DE PRÉSENCE (pour .listonline) ---
    // Welcome / Goodbye (.setwelcome on / .setgoodbye on — settings.js)
    // Détection des messages supprimés (REVOKE via protocolMessage)
    dvmsy.ev.on("messages.update", updates => {
        for (const { key, update } of updates) {
            if (update.message?.protocolMessage?.type === 0) {
                const chatJid  = key.remoteJid;
                const ownerJid = dvmsy.user?.id?.split(':')[0] + '@s.whatsapp.net';
                handleDeletedMessage(dvmsy, key, chatJid, ownerJid)
                    .catch(e => console.error('handleDeletedMessage error:', e.message));
            }
        }
    });

    dvmsy.ev.on("group-participants.update", (update) => {
        onGroupParticipants(dvmsy, update).catch(e => console.error('onGroupParticipants error:', e.message));
        handleJoinRequest(dvmsy, update).catch(e => console.error('handleJoinRequest error:', e.message));
    });

    dvmsy.ev.on("presence.update", ({ id, presences }) => {
        try {
            if (!id?.endsWith('@g.us') || !presences) return;
            for (const [jid, info] of Object.entries(presences)) {
                updatePresence(dvmsy, id, jid, info?.lastKnownPresence || 'unavailable');
            }
        } catch (e) {
            console.error('presence.update error:', e.message);
        }
    });

    // --- GESTION DE LA CONNEXION ---
    const MAX_RECONNECT_NETWORK = 3
    const MAX_RECONNECT_LOGOUT  = 2

    if (!sessionReconnectAttempts[phoneNumber]) {
        sessionReconnectAttempts[phoneNumber] = 0
    }

    async function deleteSession() {
        try { tempDvmsys[sessionName]?.end() } catch (e) {}
        delete tempDvmsys[sessionName]
        delete sessionReconnectAttempts[phoneNumber]
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true })
        }
    }

    async function tryReconnect(maxAttempts, label) {
        sessionReconnectAttempts[phoneNumber]++
        if (sessionReconnectAttempts[phoneNumber] <= maxAttempts) {
            const delay = sessionReconnectAttempts[phoneNumber] * 5000
            console.log(`🔄 [${phoneNumber}] ${label} tentative ${sessionReconnectAttempts[phoneNumber]}/${maxAttempts} dans ${delay/1000}s...`)
            await new Promise(r => setTimeout(r, delay))
            startUserBot(phoneNumber)
        } else {
            console.log(`🗑️ [${phoneNumber}] ${maxAttempts} tentatives échouées → session supprimée.`)
            await deleteSession()
        }
    }

    dvmsy.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            isConnected = false
            if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null }

            // Arrêt volontaire via .shutdown — pas de reconnexion
            if (dvmsy._shuttingDown) {
                delete tempDvmsys[sessionName];
                return;
            }

            // Nettoyage listeners pour éviter les fuites mémoire à chaque reconnexion
            dvmsy.ev.removeAllListeners()

            let reason = new Boom(lastDisconnect?.error)?.output.statusCode;
            const loggedOut       = reason === DisconnectReason.loggedOut;
            const restartRequired = reason === DisconnectReason.restartRequired;

            // Calcul du délai avec backoff exponentiel (max 60s)
            const attempt = sessionReconnectAttempts[phoneNumber] || 0
            const backoffDelay = Math.min(3000 * Math.pow(2, attempt), 60000)

            if (restartRequired) {
                console.log(`[${phoneNumber}] Redémarrage requis (normal), reconnexion...`)
                sessionReconnectAttempts[phoneNumber] = 0
                startUserBot(phoneNumber)
            } else if (loggedOut) {
                console.log(`⚠️ [${phoneNumber}] Déconnexion WhatsApp détectée.`)
                await tryReconnect(MAX_RECONNECT_LOGOUT, 'LoggedOut')
            } else if (!hasConnected) {
                console.log(`🗑️ [${phoneNumber}] Session supprimée (échec de connexion).`)
                await deleteSession()
            } else if (tempDvmsys[sessionName]) {
                console.log(`⚠️ [${phoneNumber}] Coupure réseau — reconnexion dans ${backoffDelay/1000}s (tentative ${attempt + 1})`)
                sessionReconnectAttempts[phoneNumber] = attempt + 1
                await tryReconnect(MAX_RECONNECT_NETWORK, 'Réseau')
            }
        } else if (connection === "open") {
            hasConnected  = true
            isConnected   = true
            sessionReconnectAttempts[phoneNumber] = 0

            // ── Heartbeat — maintient la présence active ─────────────────────
            // sendPresenceUpdate garde la session "vivante" côté WhatsApp
            // Si ça échoue → on ignore, Baileys gère la déco via keepAliveIntervalMs
            if (heartbeatInterval) clearInterval(heartbeatInterval)
            heartbeatInterval = setInterval(async () => {
                if (!isConnected) return
                dvmsy.sendPresenceUpdate('available').catch(() => {})
            }, 45000)
            // Charger le préfixe sauvegardé + sauvegarder ownerNumber pour cette session
            try {
                const savedCfg = loadSessionSettings(dvmsy)
                // Initialiser le prefix de cette session — toujours défini dès la connexion.
                // Source unique : settings_<phone>.json → sinon config.PREFIX
                dvmsy._prefix  = savedCfg?.prefix  || global.config?.PREFIX   || '👾'
                dvmsy._botName = savedCfg?.botName || global.config?.BOT_NAME || '⚛︎ 𝗔𝗧𝗢𝗠𝗜𝗖 𝗖𝗢𝗥𝗘 ⚛︎'

                // ── Cache groupMetadata — évite le rate-limit WhatsApp ──────
                // Monkey-patch une seule fois à la connexion : tous les appels
                // dvmsy.groupMetadata() passent automatiquement par le cache.
                if (!dvmsy._groupMetaCache) {
                    dvmsy._groupMetaCache = new Map()
                    const _orig = dvmsy.groupMetadata.bind(dvmsy)
                    dvmsy.groupMetadata = async (jid) => {
                        const TTL = 60_000
                        const now = Date.now()
                        const hit = dvmsy._groupMetaCache.get(jid)
                        if (hit && now - hit.ts < TTL) return hit.data
                        const data = await _orig(jid)
                        dvmsy._groupMetaCache.set(jid, { data, ts: now })
                        if (dvmsy._groupMetaCache.size > 300)
                            for (const [k,v] of dvmsy._groupMetaCache)
                                if (now - v.ts > TTL) dvmsy._groupMetaCache.delete(k)
                        return data
                    }
                }
                // ────────────────────────────────────────────────────────────
                // ── Sauvegarde automatique de l'owner de la session ──────────
                // Le numéro qui vient de se connecter EST l'owner de cette session.
                // On normalise en chiffres purs (sans :0, sans @s.whatsapp.net).
                const ownerNum = dvmsy.user?.id?.split(':')[0]?.split('@')[0]?.replace(/[^0-9]/g, '');
                if (ownerNum && !savedCfg.ownerNumber) {
                    savedCfg.ownerNumber = ownerNum;
                    saveSettings(dvmsy, savedCfg);
                }
                // ─────────────────────────────────────────────────────────────
            } catch {}
            console.log(`✅ [${phoneNumber}] Session Connectée !`)

            // ── Bio automatique à la connexion ────────────────────────────
            setTimeout(async () => {
                try {
                    const bio = '𝗔𝗧𝗢𝗠𝗜𝗖 𝗖𝗢𝗥𝗘 𝗜𝗦 𝗛𝗘𝗥𝗘 🔥 🚀'
                    if (typeof dvmsy.updateProfileStatus === 'function') {
                        await dvmsy.updateProfileStatus(bio)
                    } else if (typeof dvmsy.setStatus === 'function') {
                        await dvmsy.setStatus(bio)
                    }
                    console.log(`✅ [${phoneNumber}] Bio mise à jour.`)
                } catch (e) {
                    console.warn('[bio]', e.message)
                }
            }, 5000)
            const userJid = dvmsy.user.id.split(":")[0] + "@s.whatsapp.net";
            const caption = `╭───────────────⭓\n│ ✅ *⚛︎ 𝗔𝗧𝗢𝗠𝗜𝗖 𝗖𝗢𝗥𝗘 ⚛︎ 𝙲𝙾𝙽𝙽𝙴𝙲𝚃𝙴́*\n├───────────────\n│ 👤 *User:* ${dvmsy.user.name || 'Bot'}\n│ 🛠️ *Autoload:* Success\n│ 🔥 *Auto-React:* Charnel\n│ 👀 *Auto-Status:* Active\n╰───────────────⭓\n\n> ⚛︎ 𝗔𝗧𝗢𝗠𝗜𝗖 𝗖𝗢𝗥𝗘 ⚛︎ ϟ`;

            // Média DÉDIÉ au message de connexion — distinct de .menu (voir
            // .setconnectimage/.setconnectvideo), sinon le média global par
            // défaut déposé dans database/ (connect.gif ou connect.jpg).
            const media = resolveConnectMedia(dvmsy);
            try {
                if (media?.type === 'video') {
                    const videoBuf  = readMediaCached(media.path);
                    const isGif     = media.path.endsWith('.gif');
                    await dvmsy.sendMessage(userJid, {
                        video:       videoBuf,
                        caption,
                        gifPlayback: isGif,
                        mimetype:    isGif ? 'image/gif' : 'video/mp4',
                    });
                } else if (media?.type === 'image') {
                    const imageBuf = readMediaCached(media.path);
                    await dvmsy.sendMessage(userJid, { image: imageBuf, caption });
                } else {
                    await dvmsy.sendMessage(userJid, { text: caption });
                }
            } catch (e) {
                console.error('Erreur message de connexion:', e.message);
                await dvmsy.sendMessage(userJid, { text: caption }).catch(() => {});
            }

            // Rejoint automatiquement les groupes/chaînes listés dans autojoin.json
            // (non bloquant : ne retarde pas le reste de la connexion)
            autoJoin(dvmsy).catch(e => console.error('autoJoin error:', e.message));

            // Démarre le worker auto-approve pour cette session (polling toutes les 60s)
            startAutoApproveWorker(dvmsy);

            // Restaure les timers opentime/closetime persistés avant le redémarrage
            restoreTimers(dvmsy);
        }
    });

    dvmsy.ev.on("creds.update", saveCreds);
    return dvmsy;
}

async function restoreSessions() {
    console.log("📂 [AUTOLOAD] Recherche de sessions...");
    if (fs.existsSync(sessionsDir)) {
        const folders = fs.readdirSync(sessionsDir);
        for (const folder of folders) {
            if (folder.startsWith('session_')) {
                const phoneNumber = folder.replace('session_', '');
                console.log(`🔄 Restauration auto : ${phoneNumber}`);
                await startUserBot(phoneNumber);
                await delay(5000); // 5 secondes entre chaque compte pour la sécurité
            }
        }
    }
}

/**
 * INTERFACE WEB (PANEL)
 */
app.get("/", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>⚛︎ 𝗔𝗧𝗢𝗠𝗜𝗖 𝗖𝗢𝗥𝗘 ⚛︎ - 𝙿𝙰𝙽𝙴𝙻</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Rajdhani:wght@500;700&display=swap');
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                background: #050505;
                color: #fff;
                font-family: 'Rajdhani', sans-serif;
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
                position: relative;
                overflow: hidden;
            }
            
            /* Animation de fond */
            .matrix-bg {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                z-index: 0;
            }
            
            .matrix-bg span {
                position: absolute;
                color: #ff0000;
                font-size: 20px;
                font-family: 'Orbitron', monospace;
                text-shadow: 0 0 8px #ff0000;
                animation: fall 3s linear infinite;
                opacity: 0.2;
            }
            
            @keyframes fall {
                0% { transform: translateY(-100px); opacity: 0.2; }
                100% { transform: translateY(100vh); opacity: 0.8; }
            }
            
            .container {
                position: relative;
                z-index: 1;
                width: 100%;
                max-width: 500px;
                padding: 20px;
            }
            
            .box {
                background: rgba(0, 0, 0, 0.95);
                border: 3px solid #ff0000;
                border-radius: 30px;
                padding: 40px 30px;
                text-align: center;
                backdrop-filter: blur(10px);
                box-shadow: 0 0 50px rgba(255, 0, 0, 0.3),
                            inset 0 0 20px rgba(255, 0, 0, 0.2);
                position: relative;
                overflow: hidden;
            }
            
            .box::before {
                content: '';
                position: absolute;
                top: -50%;
                left: -50%;
                width: 200%;
                height: 200%;
                background: linear-gradient(45deg, transparent, rgba(255, 0, 0, 0.1), transparent);
                transform: rotate(45deg);
                animation: shine 3s infinite;
            }
            
            @keyframes shine {
                0% { transform: translateX(-100%) rotate(45deg); }
                100% { transform: translateX(100%) rotate(45deg); }
            }
            
            h1 {
                font-family: 'Orbitron', sans-serif;
                color: #ff0000;
                text-shadow: 0 0 20px #ff0000, 0 0 40px #ff0000;
                font-size: 42px;
                margin-bottom: 10px;
                letter-spacing: 4px;
                position: relative;
                display: inline-block;
            }
            
            h1::after {
                content: '';
                position: absolute;
                bottom: -10px;
                left: 50%;
                transform: translateX(-50%);
                width: 60px;
                height: 3px;
                background: #ff0000;
                box-shadow: 0 0 10px #ff0000;
            }
            
            .subtitle {
                color: #888;
                font-size: 16px;
                margin-bottom: 35px;
                letter-spacing: 3px;
                text-transform: uppercase;
            }
            
            .input-group {
                margin-bottom: 25px;
                position: relative;
            }
            
            .input-group label {
                display: block;
                text-align: left;
                color: #ff0000;
                margin-bottom: 8px;
                font-weight: bold;
                letter-spacing: 1px;
                font-size: 14px;
            }
            
            .input-group input {
                width: 100%;
                padding: 18px 20px;
                background: #111;
                border: 2px solid #333;
                color: #fff;
                border-radius: 15px;
                font-size: 18px;
                text-align: center;
                outline: none;
                font-family: 'Orbitron', monospace;
                transition: all 0.3s ease;
            }
            
            .input-group input:focus {
                border-color: #ff0000;
                box-shadow: 0 0 20px rgba(255, 0, 0, 0.3);
            }
            
            .input-group input::placeholder {
                color: #333;
                font-size: 14px;
            }
            
            button {
                width: 100%;
                padding: 18px;
                background: linear-gradient(45deg, #ff0000, #cc0000);
                color: #fff;
                border: none;
                border-radius: 15px;
                font-weight: bold;
                cursor: pointer;
                font-family: 'Orbitron', sans-serif;
                font-size: 18px;
                letter-spacing: 2px;
                transition: 0.3s;
                position: relative;
                overflow: hidden;
            }
            
            button::before {
                content: '';
                position: absolute;
                top: 0;
                left: -100%;
                width: 100%;
                height: 100%;
                background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
                transition: left 0.5s;
            }
            
            button:hover::before {
                left: 100%;
            }
            
            button:hover {
                transform: translateY(-3px);
                box-shadow: 0 10px 30px rgba(255, 0, 0, 0.5);
            }
            
            button:disabled {
                background: #333;
                cursor: not-allowed;
                transform: none;
                box-shadow: none;
            }
            
            button:disabled::before {
                display: none;
            }
            
            #loading {
                margin: 20px 0;
                display: none;
            }
            
            .loader {
                display: inline-block;
                width: 30px;
                height: 30px;
                border: 3px solid #333;
                border-top: 3px solid #ff0000;
                border-radius: 50%;
                animation: spin 1s linear infinite;
            }
            
            .loading-text {
                color: #ff0000;
                margin-top: 10px;
                font-weight: bold;
                animation: pulse 1.5s infinite;
            }
            
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            
            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.4; }
            }
            
            #res {
                margin-top: 25px;
                font-size: 40px;
                font-family: 'Orbitron', monospace;
                color: #fff;
                padding: 25px;
                border: 3px solid #ff0000;
                display: none;
                border-radius: 20px;
                cursor: pointer;
                background: linear-gradient(45deg, #0a0a0a, #1a1a1a);
                letter-spacing: 6px;
                font-weight: bold;
                text-shadow: 0 0 15px #ff0000;
                transition: 0.3s;
                position: relative;
            }
            
            #res:hover {
                transform: scale(1.05);
                box-shadow: 0 0 40px rgba(255, 0, 0, 0.6);
            }
            
            #res::before {
                content: '📋 CLICK TO COPY';
                position: absolute;
                top: -20px;
                left: 50%;
                transform: translateX(-50%);
                font-size: 12px;
                color: #ff0000;
                background: #000;
                padding: 5px 10px;
                border-radius: 10px;
                border: 1px solid #ff0000;
                opacity: 0;
                transition: 0.3s;
                white-space: nowrap;
            }
            
            #res:hover::before {
                opacity: 1;
                top: -30px;
            }
            
            .stats {
                margin-top: 20px;
                display: flex;
                justify-content: center;
                gap: 30px;
                color: #666;
                font-size: 14px;
            }
            
            .stats span {
                color: #ff0000;
                font-weight: bold;
            }
            
            .footer {
                margin-top: 20px;
                color: #333;
                font-size: 12px;
                text-transform: uppercase;
                letter-spacing: 2px;
            }
        </style>
    </head>
    <body>
        <div class="matrix-bg" id="matrix"></div>
        
        <div class="container">
            <div class="box">
                <h1>⚛︎ 𝗔𝗧𝗢𝗠𝗜𝗖 𝗖𝗢𝗥𝗘 ⚛︎</h1>
                <div class="subtitle">M U L T I - D E V I C E</div>
                
                <div class="input-group">
                    <label>📱 NUMÉRO WHATSAPP</label>
                    <input type="text" id="num" placeholder="Ex: 225XXXXXXXX" maxlength="15">
                </div>
                
                <button id="btn" onclick="connect()">
                    <span>⚡ GÉNÉRER LE CODE ⚡</span>
                </button>
                
                <div id="loading">
                    <div class="loader"></div>
                    <div class="loading-text">CRYPTAGE EN COURS...</div>
                </div>
                
                <div id="res" onclick="copyCode()"></div>
                
                <div class="stats">
                    <div>🟢 <span>ONLINE</span></div>
                    <div>🔴 <span id="sessionCount">0</span> SESSIONS</div>
                </div>
                
                <div class="footer">
                    ⚡ ⚛︎ 𝗔𝗧𝗢𝗠𝗜𝗖 𝗖𝗢𝗥𝗘 ⚛︎ SYSTEM V2.0 ⚡
                </div>
            </div>
        </div>

        <script>
            // Effet Matrix amélioré
            function createMatrix() {
                const matrix = document.getElementById('matrix');
                const chars = '01アイウエオカキクケコサシスセソタチツテト';
                
                for(let i = 0; i < 50; i++) {
                    const span = document.createElement('span');
                    span.style.left = Math.random() * 100 + '%';
                    span.style.animationDelay = Math.random() * 3 + 's';
                    span.style.animationDuration = 2 + Math.random() * 3 + 's';
                    span.style.fontSize = (15 + Math.random() * 20) + 'px';
                    span.innerHTML = chars[Math.floor(Math.random() * chars.length)];
                    matrix.appendChild(span);
                }
            }
            
            createMatrix();
            
            // Mise à jour du compteur de sessions
            async function updateSessionCount() {
                try {
                    const response = await fetch('/sessions/count');
                    const data = await response.json();
                    document.getElementById('sessionCount').textContent = data.count || 0;
                } catch(e) {}
            }
            
            setInterval(updateSessionCount, 5000);
            updateSessionCount();
            
            async function connect() {
                const num = document.getElementById('num').value.replace(/[^0-9]/g, '');
                const resBox = document.getElementById('res');
                const btn = document.getElementById('btn');
                const loading = document.getElementById('loading');
                
                if(!num) {
                    alert('❌ Entrez un numéro valide !');
                    return;
                }
                
                if(num.length < 10) {
                    alert('❌ Numéro trop court !');
                    return;
                }
                
                btn.disabled = true;
                resBox.style.display = "none";
                loading.style.display = "block";
                
                try {
                    const response = await fetch('/pair?number=' + num);
                    const data = await response.json();
                    
                    loading.style.display = "none";
                    
                    if(data.code) {
                        resBox.style.display = "block";
                        resBox.innerText = data.code.match(/.{1,3}/g).join('-');
                        btn.disabled = false;
                    } else {
                        alert('❌ ' + (data.error || "Erreur lors de la génération."));
                        btn.disabled = false;
                    }
                } catch(e) {
                    loading.style.display = "none";
                    btn.disabled = false;
                    alert('❌ Erreur de connexion au serveur');
                }
            }
            
            function copyCode() {
                const code = document.getElementById('res').innerText.replace(/-/g, '');
                navigator.clipboard.writeText(code);
                
                // Animation de copie
                const resBox = document.getElementById('res');
                resBox.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    resBox.style.transform = 'scale(1)';
                }, 200);
                
                alert('✅ Code copié dans le presse-papier !');
            }
            
            // Auto-formatage du numéro
            document.getElementById('num').addEventListener('input', function(e) {
                this.value = this.value.replace(/[^0-9]/g, '');
            });
        </script>
    </body>
    </html>`);
});

app.get("/pair", async (req, res) => {
    const num = (req.query.number || '').replace(/\D/g, '')
    if (!num || num.length < 7) return res.json({ error: 'Numéro invalide.' })

    try {
        const code = await new Promise(async (resolve, reject) => {
            // Timeout global de 45s — si WhatsApp ne répond pas
            const timer = setTimeout(() => reject(new Error('Timeout — réessaie')), 45000)
            let codeSent = false

            const dvmsy = await startUserBot(num, true)

            dvmsy.ev.on('connection.update', async ({ connection }) => {
                if (codeSent) return

                if (connection === 'connecting') {
                    // Petit délai pour que le handshake WS soit finalisé
                    // (~1.5s au lieu de 8s fixes — adaptatif selon la vitesse réseau)
                    await delay(1500)
                    try {
                        const pairCode = await dvmsy.requestPairingCode(num.trim(), 'INAMIXMD')
                        codeSent = true
                        clearTimeout(timer)
                        resolve(pairCode)
                    } catch (err) {
                        console.warn('[pair] requestPairingCode échoué sur connecting:', err.message)
                    }
                } else if (connection === 'open' && !codeSent) {
                    // Session déjà active — pas de nouveau code possible
                    clearTimeout(timer)
                    reject(new Error('Session déjà connectée, supprime-la d\'abord.'))
                } else if (connection === 'close' && !codeSent) {
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

// Nouvelle route pour compter les sessions
app.get("/sessions/count", (req, res) => {
    try {
        const count = fs.readdirSync(sessionsDir).filter(f => f.startsWith('session_')).length;
        res.json({ count });
    } catch (e) {
        res.json({ count: 0 });
    }
});

// NOTE : la vérification des anniversaires est maintenant gérée par session
// dans startUserBot() — chaque session a son propre setInterval local.

// NOTE : arrêt géré par Pterodactyl via le signal natif

// --- DÉMARRAGE GLOBAL ---
app.listen(port, async () => {
    let ip = ''
    try {
        const res = await fetch('https://api.ipify.org?format=json')
        const data = await res.json()
        ip = data.ip
    } catch { ip = 'IP inconnue' }
    console.log(`🌐 ⚛︎ 𝗔𝗧𝗢𝗠𝗜𝗖 𝗖𝗢𝗥𝗘 ⚛︎ prêt sur : http://${ip}:${port}`);
    await restoreSessions();

    // ── Bio automatique sur toutes les sessions actives au démarrage ──────
    setTimeout(async () => {
        for (const dvmsy of Object.values(tempDvmsys)) {
            try {
                await dvmsy.updateProfileStatus('𝗔𝗧𝗢𝗠𝗜𝗖 𝗖𝗢𝗥𝗘 𝗜𝗦 𝗛𝗘𝗥𝗘 🔥 🚀')
            } catch {}
        }
    }, 8000) // attendre 8s que les sessions soient bien connectées
    startTelegramBot();
});
