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

// CORS — autoriser toutes les origines (nécessaire pour Railway reverse proxy)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = {};

function createSession(hostName) {
  const id = uuidv4().slice(0, 6).toUpperCase();
  sessions[id] = {
    id,
    host: hostName,
    joueurs: {},
    etat: 'lobby',
    tourActuel: null,
    accordsEnCours: {},
    votesEnCours: {},      // NEW: votes de désignation
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
  const session = createSession(hostName || 'Oracle');
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
    joueurs: Object.values(s.joueurs).map(j => ({ id: j.id, nom: j.nom, palier: j.palier, points: j.points })),
    nbJoueurs: Object.keys(s.joueurs).length
  });
});

// ─── WebSocket ────────────────────────────────────────────────────────────────

const PING_INTERVAL = 25000;
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

      case 'HOST_CONNECT': {
        session.hostWs = ws;
        ws.sessionId = msg.sessionId;
        ws.role = 'host';
        send(ws, {
          type: 'HOST_CONNECTED',
          sessionId: session.id,
          etat: session.etat,
          joueurs: getJoueursList(session),
          nbJoueurs: Object.keys(session.joueurs).length
        });
        break;
      }

      case 'JOIN': {
        let joueurId = msg.joueurId;
        let isReconnect = false;
        if (joueurId && session.joueurs[joueurId]) {
          session.joueurs[joueurId].ws = ws;
          isReconnect = true;
        } else {
          joueurId = uuidv4().slice(0, 8);
          session.joueurs[joueurId] = { id: joueurId, nom: msg.nom || `Joueur${Object.keys(session.joueurs).length + 1}`, palier: 0, points: 0, ws };
        }
        ws.joueurId = joueurId;
        ws.sessionId = msg.sessionId;
        ws.role = 'joueur';
        const joueur = session.joueurs[joueurId];
        send(ws, { type: 'JOIN_OK', joueurId, nom: joueur.nom, palier: joueur.palier, points: joueur.points, etatSession: session.etat, isReconnect });
        broadcast(session, { type: isReconnect ? 'JOUEUR_RECONNECTED' : 'JOUEUR_JOINED', joueurId, nom: joueur.nom, totalJoueurs: Object.keys(session.joueurs).length });
        break;
      }

      case 'START_GAME': {
        if (ws.role !== 'host') return;
        const nb = Object.keys(session.joueurs).length;
        if (nb < 2) { send(ws, { type: 'ERROR', code: 'NOT_ENOUGH_PLAYERS', msg: `Il faut au moins 2 joueurs. Actuellement : ${nb}.` }); return; }
        session.etat = 'jeu';
        broadcast(session, { type: 'GAME_STARTED' });
        break;
      }

      case 'TIRER_CARTE': {
        if (ws.role !== 'host') return;
        const carte = tirerCarte(session);
        if (!carte) { send(ws, { type: 'ERROR', msg: 'Plus de cartes disponibles' }); return; }
        session.tourActuel = carte;

        if (carte.type === 'solo') {
          // Désignation aléatoire par l'Oracle
          const joueurCible = getJoueurAleatoire(session);
          if (!joueurCible) return;
          const texte = carte.texte.replace(/{joueur}/g, joueurCible.nom);
          broadcast(session, { type: 'NOUVELLE_CARTE', carte: { ...carte, texte, joueurCible: joueurCible.nom } });
          if (joueurCible.ws) send(joueurCible.ws, { type: 'ACTION_SOLO', texte: carte.texte_joueur, points: carte.points });
        }

        else if (carte.type === 'duo') {
          // Désignation aléatoire de 2 joueurs par l'Oracle
          const duo = getDuoAleatoire(session);
          if (!duo) return;
          const [j1, j2] = duo;
          const texte = carte.texte.replace(/{joueur1}/g, j1.nom).replace(/{joueur2}/g, j2.nom);
          broadcast(session, { type: 'NOUVELLE_CARTE', carte: { ...carte, texte, joueur1: j1.nom, joueur2: j2.nom } });

          const actionId = uuidv4().slice(0, 8);
          session.accordsEnCours[actionId] = {
            actionId, carte, joueur1Id: j1.id, joueur2Id: j2.id, reponses: {},
            timeout: setTimeout(() => resolveAccord(session, actionId, 'timeout'), 30000)
          };
          if (j1.ws) send(j1.ws, { type: 'ACCORD_REQUIS', actionId, texte: carte.texte_joueur, partenaire: j2.nom });
          if (j2.ws) send(j2.ws, { type: 'ACCORD_REQUIS', actionId, texte: carte.texte_joueur, partenaire: j1.nom });
          send(ws, { type: 'ACCORD_EN_ATTENTE', actionId });
        }

        else if (carte.type === 'vote') {
          // Lancer un vote de désignation sur tous les téléphones
          const voteId = uuidv4().slice(0, 8);
          const joueursList = getJoueursList(session);
          session.votesEnCours[voteId] = {
            voteId, carte, votes: {}, // joueurId -> joueurIdCible
            timeout: setTimeout(() => resolveVote(session, voteId), 20000)
          };
          broadcast(session, { type: 'NOUVELLE_CARTE', carte: { ...carte } });
          // Envoyer le vote à tous les joueurs
          Object.values(session.joueurs).forEach(j => {
            if (j.ws) send(j.ws, {
              type: 'VOTE_REQUIS',
              voteId,
              question: carte.texte_vote,
              joueurs: joueursList.map(jj => ({ id: jj.id, nom: jj.nom }))
            });
          });
          send(ws, { type: 'VOTE_EN_ATTENTE', voteId, duree: 20 });
        }

        else if (carte.type === 'shot') {
          broadcast(session, { type: 'NOUVELLE_CARTE', carte });
        }

        break;
      }

      // ── Accord duo ────────────────────────────────────────────────────────
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

      // ── Vote de désignation ───────────────────────────────────────────────
      case 'VOTE_REPONSE': {
        const vote = session.votesEnCours[msg.voteId];
        if (!vote) return;
        vote.votes[ws.joueurId] = msg.cibleId; // le joueur vote pour une cible
        const nbJoueurs = Object.keys(session.joueurs).length;
        const nbVotes = Object.keys(vote.votes).length;
        // Si tout le monde a voté, on résout immédiatement
        if (nbVotes >= nbJoueurs) {
          clearTimeout(vote.timeout);
          resolveVote(session, msg.voteId);
        }
        break;
      }

      // ── Action solo ───────────────────────────────────────────────────────
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
        const jugements = session.cartes.repliques_oracle.jugement_final;
        const verdicts = joueurs.map((j, i) => ({
          nom: j.nom, points: j.points, palier: j.palier,
          verdict: jugements[i % jugements.length].replace(/{joueur}/g, j.nom)
        }));
        broadcast(session, { type: 'GAME_OVER', verdicts });
        break;
      }
    }
  });

  ws.on('close', () => {
    for (const session of Object.values(sessions)) {
      if (ws.joueurId && session.joueurs[ws.joueurId]) {
        session.joueurs[ws.joueurId].ws = null;
        broadcast(session, { type: 'JOUEUR_DISCONNECTED', joueurId: ws.joueurId, nom: session.joueurs[ws.joueurId].nom });
      }
      if (session.hostWs === ws) session.hostWs = null;
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

function resolveVote(session, voteId) {
  const vote = session.votesEnCours[voteId];
  if (!vote) return;

  // Compter les votes par cible
  const scores = {};
  Object.values(vote.votes).forEach(cibleId => {
    scores[cibleId] = (scores[cibleId] || 0) + 1;
  });

  // Trouver le max
  const maxVotes = Math.max(...Object.values(scores), 0);

  // Trouver les ex-aequo
  let finalistes = Object.entries(scores)
    .filter(([id, nb]) => nb === maxVotes)
    .map(([id]) => id);

  // Si personne n'a voté → désignation aléatoire
  if (finalistes.length === 0) {
    const j = getJoueurAleatoire(session);
    finalistes = j ? [j.id] : [];
  }

  let designeId;
  if (finalistes.length === 1) {
    designeId = finalistes[0];
  } else {
    // Ex-aequo : celui avec le moins de points
    const finalJoueurs = finalistes.map(id => session.joueurs[id]).filter(Boolean);
    finalJoueurs.sort((a, b) => (a.points || 0) - (b.points || 0));
    const minPoints = finalJoueurs[0].points || 0;
    const vraisExaequo = finalJoueurs.filter(j => (j.points || 0) === minPoints);
    // Si encore ex-aequo → aléatoire
    designeId = vraisExaequo[Math.floor(Math.random() * vraisExaequo.length)].id;
  }

  const designe = session.joueurs[designeId];
  if (!designe) { delete session.votesEnCours[voteId]; return; }

  // Donner les points et envoyer l'action au désigné
  designe.points += vote.carte.points || 0;

  // Choisir la bonne réplique
  const repliques = session.cartes.repliques_oracle;
  const isEgalite = finalistes.length > 1;
  const repliquesPool = isEgalite ? repliques.vote_egalite : repliques.vote_resultat;
  const replique = repliquesPool[Math.floor(Math.random() * repliquesPool.length)].replace(/{joueur}/g, designe.nom);

  broadcast(session, {
    type: 'VOTE_RESULTAT',
    voteId,
    designeId,
    designeNom: designe.nom,
    replique,
    isEgalite
  });

  // Envoyer l'action au téléphone du désigné
  if (designe.ws) {
    send(designe.ws, {
      type: 'ACTION_SOLO',
      texte: vote.carte.texte_joueur,
      points: vote.carte.points
    });
  }

  delete session.votesEnCours[voteId];
}

function tirerCarte(session) {
  // Déterminer le palier minimum du groupe
  const joueurs = Object.values(session.joueurs);
  if (joueurs.length === 0) return null;
  const palierMin = Math.min(...joueurs.map(j => j.palier || 0));
  const paliers = ['tiede', 'chaud', 'brulant'];
  const palierNom = paliers[palierMin] || 'tiede';

  const cartesDisponibles = session.cartes.cartes[palierNom]
    .filter(c => !session.cartesUtilisees.has(c.id));

  // Si plus de cartes dans ce palier, ouvrir les autres
  const pool = cartesDisponibles.length > 0
    ? cartesDisponibles
    : session.cartes.cartes[palierNom]; // reset si épuisé

  if (pool.length === 0) return null;
  const carte = pool[Math.floor(Math.random() * pool.length)];
  session.cartesUtilisees.add(carte.id);
  return { ...carte, palierNom };
}

function getJoueurAleatoire(session) {
  const joueurs = Object.values(session.joueurs).filter(j => j.ws);
  if (joueurs.length === 0) return null;
  return joueurs[Math.floor(Math.random() * joueurs.length)];
}

function getDuoAleatoire(session) {
  const joueurs = Object.values(session.joueurs).filter(j => j.ws);
  if (joueurs.length < 2) return null;
  const shuffled = joueurs.sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1]];
}

function sanitizeCarte(carte) {
  const { texte_joueur, texte_vote, ...pub } = carte;
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
  console.log(`\n🔴 DIABLO v2.0 en ligne sur http://localhost:${PORT}\n`);
});

