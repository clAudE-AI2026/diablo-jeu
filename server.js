const express = require('express');
const { WebSocketServer } = require('ws');
const { createServer } = require('http');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = {};

function createSession(hostName) {
  const id = uuidv4().slice(0, 6).toUpperCase();
  sessions[id] = {
    id,
    host: hostName,
    joueurs: {},       // joueurs seulement — PAS l'hôte
    etat: 'lobby',
    tourActuel: null,
    accordsEnCours: {},
    historique: [],
    cartes: loadCartes(),
    cartesUtilisees: new Set(),
    createdAt: Date.now()
  };
  return sessions[id];
}

function loadCartes() {
  const cartesPath = path.join(__dirname, 'contenu', 'cartes.json');
  return JSON.parse(fs.readFileSync(cartesPath, 'utf8'));
}

// ─── Routes HTTP ──────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'oracle.html')));
app.get('/joueur', (req, res) => res.sendFile(path.join(__dirname, 'public', 'joueur.html')));

app.post('/api/session', (req, res) => {
  const { hostName } = req.body;
  const session = createSession(hostName || 'Hôte');
  res.json({ sessionId: session.id });
});

app.get('/api/qr/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const url = `${proto}://${host}/joueur?s=${sessionId}`;
  try {
    const qr = await QRCode.toDataURL(url, { width: 300, color: { dark: '#ff2d55', light: '#1a1a2e' } });
    res.json({ qr, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/session/:id', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Session introuvable' });
  res.json({
    id: s.id, host: s.host, etat: s.etat,
    // FIX 1 : l'hôte n'est pas dans joueurs, donc ce tableau ne contient que les vrais joueurs
    joueurs: Object.values(s.joueurs).map(j => ({ id: j.id, nom: j.nom, palier: j.palier, points: j.points })),
    nbJoueurs: Object.keys(s.joueurs).length
  });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

// FIX 3 : ping/pong pour détecter les déconnexions silencieuses
const PING_INTERVAL = 25000; // 25s — Railway coupe les WS inactifs après 30s
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);

wss.on('connection', (ws) => {
  ws.id = uuidv4();
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const session = sessions[msg.sessionId];
    if (!session) return;

    switch (msg.type) {

      // ── Hôte se connecte ──────────────────────────────────────────────────
      case 'HOST_CONNECT': {
        session.hostWs = ws;
        ws.sessionId = msg.sessionId;
        ws.role = 'host';
        // FIX 3 : confirmer avec l'état actuel pour permettre la reconnexion
        send(ws, {
          type: 'HOST_CONNECTED',
          sessionId: session.id,
          etat: session.etat,
          joueurs: getJoueursList(session),
          nbJoueurs: Object.keys(session.joueurs).length
        });
        break;
      }

      // ── Joueur rejoint ────────────────────────────────────────────────────
      case 'JOIN': {
        // FIX 3 : si le joueurId existe déjà (reconnexion), réutiliser le même slot
        let joueurId = msg.joueurId;
        let isReconnect = false;

        if (joueurId && session.joueurs[joueurId]) {
          // Reconnexion : mettre à jour le WS
          session.joueurs[joueurId].ws = ws;
          isReconnect = true;
        } else {
          // Nouveau joueur
          joueurId = uuidv4().slice(0, 8);
          session.joueurs[joueurId] = {
            id: joueurId,
            nom: msg.nom || `Joueur${Object.keys(session.joueurs).length + 1}`,
            palier: 0, points: 0, ws
          };
        }

        ws.joueurId = joueurId;
        ws.sessionId = msg.sessionId;
        ws.role = 'joueur';

        const joueur = session.joueurs[joueurId];
        send(ws, {
          type: 'JOIN_OK',
          joueurId,
          nom: joueur.nom,
          palier: joueur.palier,
          points: joueur.points,
          etatSession: session.etat,
          isReconnect
        });

        // Notifier tout le monde
        broadcast(session, {
          type: isReconnect ? 'JOUEUR_RECONNECTED' : 'JOUEUR_JOINED',
          joueurId,
          nom: joueur.nom,
          // FIX 1 : totalJoueurs = nb de joueurs SANS l'hôte
          totalJoueurs: Object.keys(session.joueurs).length
        });
        break;
      }

      // ── Hôte lance la partie ──────────────────────────────────────────────
      case 'START_GAME': {
        if (ws.role !== 'host') return;
        // FIX 2 : vérifier minimum 2 joueurs AVANT de démarrer
        const nbJoueurs = Object.keys(session.joueurs).length;
        if (nbJoueurs < 2) {
          send(ws, {
            type: 'ERROR',
            code: 'NOT_ENOUGH_PLAYERS',
            msg: `Il faut au moins 2 joueurs pour lancer DIABLO. Actuellement : ${nbJoueurs} joueur${nbJoueurs > 1 ? 's' : ''}.`
          });
          return;
        }
        session.etat = 'jeu';
        broadcast(session, { type: 'GAME_STARTED' });
        break;
      }

      // ── Hôte tire une carte ───────────────────────────────────────────────
      case 'TIRER_CARTE': {
        if (ws.role !== 'host') return;
        const carte = tirerCarte(session, msg.joueurCible, msg.joueur2);
        if (!carte) { send(ws, { type: 'ERROR', msg: 'Plus de cartes disponibles' }); return; }

        session.tourActuel = carte;
        broadcast(session, { type: 'NOUVELLE_CARTE', carte: sanitizeCarte(carte) });

        if (carte.cible === 'duo' && msg.joueurCible && msg.joueur2) {
          const actionId = uuidv4().slice(0, 8);
          session.accordsEnCours[actionId] = {
            actionId, carte,
            joueur1Id: msg.joueurCible,
            joueur2Id: msg.joueur2,
            reponses: {},
            timeout: setTimeout(() => resolveAccord(session, actionId, 'timeout'), 30000)
          };
          const j1 = session.joueurs[msg.joueurCible];
          const j2 = session.joueurs[msg.joueur2];
          if (j1?.ws) send(j1.ws, { type: 'ACCORD_REQUIS', actionId, texte: carte.texte_joueur, partenaire: j2?.nom || '???' });
          if (j2?.ws) send(j2.ws, { type: 'ACCORD_REQUIS', actionId, texte: carte.texte_joueur, partenaire: j1?.nom || '???' });
          send(ws, { type: 'ACCORD_EN_ATTENTE', actionId });
        }

        if (carte.cible === 'solo' && msg.joueurCible) {
          const j = session.joueurs[msg.joueurCible];
          if (j?.ws) send(j.ws, { type: 'ACTION_SOLO', texte: carte.texte_joueur, roleGroupe: carte.role_groupe, points: carte.points });
        }
        break;
      }

      case 'ACCORD_REPONSE': {
        const accord = session.accordsEnCours[msg.actionId];
        if (!accord) return;
        accord.reponses[ws.joueurId] = msg.accepte;
        if (Object.keys(accord.reponses).length >= 2) {
          clearTimeout(accord.timeout);
          resolveAccord(session, msg.actionId, 'reponse');
        } else {
          send(ws, { type: 'ACCORD_ATTENTE_AUTRE' });
        }
        break;
      }

      case 'ACTION_RESULTAT': {
        const carte = session.tourActuel;
        if (!carte) return;
        const joueur = session.joueurs[ws.joueurId];
        if (!joueur) return;
        if (msg.accompli) {
          joueur.points += carte.points || 0;
          broadcast(session, { type: 'ACTION_ACCOMPLIE', joueurId: ws.joueurId, nom: joueur.nom, points: joueur.points });
        } else {
          broadcast(session, { type: 'ACTION_REFUSEE', joueurId: ws.joueurId, nom: joueur.nom, penalite: carte.penalite_refus || 'shot' });
        }
        break;
      }

      case 'MONTER_PALIER': {
        const joueur = session.joueurs[ws.joueurId];
        if (!joueur || joueur.palier >= 2) return;
        joueur.palier++;
        send(ws, { type: 'PALIER_UPDATE', palier: joueur.palier });
        broadcast(session, { type: 'JOUEUR_PALIER_UP', joueurId: ws.joueurId, nom: joueur.nom, palier: joueur.palier });
        break;
      }

      case 'END_GAME': {
        if (ws.role !== 'host') return;
        session.etat = 'fin';
        const joueurs = Object.values(session.joueurs).sort((a, b) => b.points - a.points);
        const jugements = session.cartes.jugements_finaux;
        const verdicts = joueurs.map((j, i) => ({
          nom: j.nom, points: j.points, palier: j.palier,
          verdict: jugements[i % jugements.length].replace(/{joueur}/g, j.nom)
        }));
        broadcast(session, { type: 'GAME_OVER', verdicts });
        break;
      }
    }
  });

  // FIX 3 : à la déconnexion, marquer le joueur comme déconnecté MAIS le garder en mémoire
  ws.on('close', () => {
    for (const session of Object.values(sessions)) {
      if (ws.joueurId && session.joueurs[ws.joueurId]) {
        session.joueurs[ws.joueurId].ws = null;
        broadcast(session, { type: 'JOUEUR_DISCONNECTED', joueurId: ws.joueurId, nom: session.joueurs[ws.joueurId].nom });
      }
      // Si l'hôte se déconnecte, le notifier sur reconnexion
      if (session.hostWs === ws) {
        session.hostWs = null;
      }
    }
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveAccord(session, actionId, raison) {
  const accord = session.accordsEnCours[actionId];
  if (!accord) return;
  const tousAccepte = Object.values(accord.reponses).every(r => r === true) && Object.keys(accord.reponses).length >= 2;
  const j1 = session.joueurs[accord.joueur1Id];
  const j2 = session.joueurs[accord.joueur2Id];
  if (tousAccepte) {
    if (j1) j1.points += accord.carte.points || 0;
    if (j2) j2.points += accord.carte.points || 0;
    broadcast(session, { type: 'ACCORD_OUI', actionId, joueur1: j1?.nom, joueur2: j2?.nom, points: accord.carte.points });
  } else {
    broadcast(session, { type: 'ACCORD_NON', actionId, penalite: accord.carte.penalite_refus || 'shot chacun' });
  }
  delete session.accordsEnCours[actionId];
}

function tirerCarte(session, joueur1Id, joueur2Id) {
  const joueur1 = session.joueurs[joueur1Id];
  const joueur2 = joueur2Id ? session.joueurs[joueur2Id] : null;
  let palierMax = joueur1 ? joueur1.palier : 0;
  if (joueur2) palierMax = Math.min(palierMax, joueur2.palier);
  const paliers = ['tiede', 'chaud', 'brulant'];
  const palierNom = paliers[palierMax] || 'tiede';
  const cartesDisponibles = session.cartes.cartes[palierNom].filter(c => !session.cartesUtilisees.has(c.id));
  let pool = cartesDisponibles;
  if (joueur1Id && joueur2Id) pool = cartesDisponibles.filter(c => c.cible === 'duo');
  else if (joueur1Id) pool = cartesDisponibles.filter(c => c.cible === 'solo');
  else pool = cartesDisponibles.filter(c => c.cible === 'groupe');
  if (pool.length === 0) pool = cartesDisponibles;
  if (pool.length === 0) return null;
  const carte = pool[Math.floor(Math.random() * pool.length)];
  session.cartesUtilisees.add(carte.id);
  const j1nom = joueur1?.nom || 'Joueur 1';
  const j2nom = joueur2?.nom || 'Joueur 2';
  return {
    ...carte,
    texte: carte.texte.replace(/{joueur}/g, j1nom).replace(/{joueur1}/g, j1nom).replace(/{joueur2}/g, j2nom),
    texte_joueur: carte.texte_joueur ? carte.texte_joueur.replace(/{joueur}/g, j1nom).replace(/{joueur1}/g, j1nom).replace(/{joueur2}/g, j2nom) : null,
    joueur1: j1nom, joueur2: j2nom, palierNom
  };
}

function sanitizeCarte(carte) {
  const { texte_joueur, ...pub } = carte;
  return pub;
}

function getJoueursList(session) {
  return Object.values(session.joueurs).map(j => ({ id: j.id, nom: j.nom, palier: j.palier, points: j.points }));
}

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcast(session, data) {
  if (session.hostWs) send(session.hostWs, data);
  Object.values(session.joueurs).forEach(j => { if (j.ws) send(j.ws, data); });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔴 DIABLO en ligne sur http://localhost:${PORT}\n`);
});
