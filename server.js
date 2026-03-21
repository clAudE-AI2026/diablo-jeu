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
    votesEnCours: {},
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
  const url = proto + '://' + host + '/joueur?s=' + sessionId;
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
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    var session = sessions[msg.sessionId];
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
        var joueurId = msg.joueurId;
        var isReconnect = false;
        if (joueurId && session.joueurs[joueurId]) {
          session.joueurs[joueurId].ws = ws;
          isReconnect = true;
        } else {
          joueurId = uuidv4().slice(0, 8);
          session.joueurs[joueurId] = {
            id: joueurId,
            nom: msg.nom || ('Joueur' + (Object.keys(session.joueurs).length + 1)),
            sexe: msg.sexe || 'autre',   // 'homme', 'femme', 'autre'
            palier: 0,
            points: 0,
            ws: ws
          };
        }
        ws.joueurId = joueurId;
        ws.sessionId = msg.sessionId;
        ws.role = 'joueur';
        var joueur = session.joueurs[joueurId];
        send(ws, { type: 'JOIN_OK', joueurId: joueurId, nom: joueur.nom, palier: joueur.palier, points: joueur.points, etatSession: session.etat, isReconnect: isReconnect });
        broadcast(session, { type: isReconnect ? 'JOUEUR_RECONNECTED' : 'JOUEUR_JOINED', joueurId: joueurId, nom: joueur.nom, totalJoueurs: Object.keys(session.joueurs).length });
        break;
      }

      case 'START_GAME': {
        if (ws.role !== 'host') return;
        var nb = Object.keys(session.joueurs).length;
        if (nb < 2) {
          send(ws, { type: 'ERROR', code: 'NOT_ENOUGH_PLAYERS', msg: 'Il faut au moins 2 joueurs. Actuellement : ' + nb + '.' });
          return;
        }
        session.etat = 'jeu';
        broadcast(session, { type: 'GAME_STARTED' });
        break;
      }

      case 'TIRER_CARTE': {
        if (ws.role !== 'host') return;
        var carte = tirerCarte(session);
        if (!carte) { send(ws, { type: 'ERROR', msg: 'Plus de cartes disponibles' }); return; }
        session.tourActuel = carte;

        if (carte.type === 'solo') {
          var joueurCible = getJoueurAleatoire(session);
          if (!joueurCible) return;
          var texte = carte.texte.replace(/{joueur}/g, joueurCible.nom);
          broadcast(session, { type: 'NOUVELLE_CARTE', carte: Object.assign({}, carte, { texte: texte, joueurCible: joueurCible.nom }) });
          if (joueurCible.ws) send(joueurCible.ws, { type: 'ACTION_SOLO', texte: carte.texte_joueur, points: carte.points });
        }

        else if (carte.type === 'duo') {
          // Determiner si la carte est intime (chaud/brulant) pour appliquer le filtre sexe
          var estIntime = (carte.palierNom === 'chaud' || carte.palierNom === 'brulant');
          var duo = getDuoAleatoire(session, estIntime);
          if (!duo) return;
          var j1 = duo[0];
          var j2 = duo[1];
          var texte2 = carte.texte.replace(/{joueur1}/g, j1.nom).replace(/{joueur2}/g, j2.nom);
          broadcast(session, { type: 'NOUVELLE_CARTE', carte: Object.assign({}, carte, { texte: texte2, joueur1: j1.nom, joueur2: j2.nom }) });
          var actionId = uuidv4().slice(0, 8);
          session.accordsEnCours[actionId] = {
            actionId: actionId, carte: carte, joueur1Id: j1.id, joueur2Id: j2.id, reponses: {},
            timeout: setTimeout(function() { resolveAccord(session, actionId, 'timeout'); }, 30000)
          };
          if (j1.ws) send(j1.ws, { type: 'ACCORD_REQUIS', actionId: actionId, texte: carte.texte_joueur, partenaire: j2.nom });
          if (j2.ws) send(j2.ws, { type: 'ACCORD_REQUIS', actionId: actionId, texte: carte.texte_joueur, partenaire: j1.nom });
          send(ws, { type: 'ACCORD_EN_ATTENTE', actionId: actionId });
        }

        else if (carte.type === 'vote') {
          var voteId = uuidv4().slice(0, 8);
          var joueursList = getJoueursList(session);
          session.votesEnCours[voteId] = {
            voteId: voteId, carte: carte, votes: {},
            timeout: setTimeout(function() { resolveVote(session, voteId); }, 20000)
          };
          broadcast(session, { type: 'NOUVELLE_CARTE', carte: carte });
          Object.values(session.joueurs).forEach(function(j) {
            if (j.ws) send(j.ws, {
              type: 'VOTE_REQUIS',
              voteId: voteId,
              question: carte.texte_vote,
              joueurs: joueursList.map(function(jj) { return { id: jj.id, nom: jj.nom }; })
            });
          });
          send(ws, { type: 'VOTE_EN_ATTENTE', voteId: voteId, duree: 20 });
        }

        else if (carte.type === 'groupe') {
          var cible = getJoueurAleatoire(session);
          if (!cible) return;
          var texteGroupe = carte.texte.replace(/{joueur}/g, cible.nom).replace(/{joueur1}/g, cible.nom);
          broadcast(session, { type: 'NOUVELLE_CARTE', carte: Object.assign({}, carte, { texte: texteGroupe, joueurCible: cible.nom, joueurCibleId: cible.id }) });
          if (cible.ws) send(cible.ws, { type: 'ACTION_GROUPE_CIBLE', texte: carte.texte_joueur, duree: 30 });
          send(ws, { type: 'GROUPE_EN_ATTENTE', cibleNom: cible.nom, duree: 30 });
        }

        else if (carte.type === 'shot') {
          broadcast(session, { type: 'NOUVELLE_CARTE', carte: carte });
        }

        break;
      }

      case 'ACCORD_REPONSE': {
        var accord = session.accordsEnCours[msg.actionId];
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

      case 'VOTE_REPONSE': {
        var vote = session.votesEnCours[msg.voteId];
        if (!vote) return;
        vote.votes[ws.joueurId] = msg.cibleId;
        var nbJ = Object.keys(session.joueurs).length;
        var nbV = Object.keys(vote.votes).length;
        if (nbV >= nbJ) {
          clearTimeout(vote.timeout);
          resolveVote(session, msg.voteId);
        }
        break;
      }

      case 'GROUPE_RESULTAT': {
        if (ws.role !== 'host') return;
        if (msg.succes) {
          broadcast(session, { type: 'GROUPE_SUCCES', cibleNom: msg.cibleNom });
        } else {
          broadcast(session, { type: 'GROUPE_ECHEC', cibleNom: msg.cibleNom });
        }
        break;
      }

      case 'ACTION_RESULTAT': {
        var carteAct = session.tourActuel;
        if (!carteAct) return;
        var joueurAct = session.joueurs[ws.joueurId];
        if (!joueurAct) return;
        if (msg.accompli) {
          joueurAct.points += carteAct.points || 0;
          broadcast(session, { type: 'ACTION_ACCOMPLIE', joueurId: ws.joueurId, nom: joueurAct.nom, points: joueurAct.points });
        } else {
          broadcast(session, { type: 'ACTION_REFUSEE', joueurId: ws.joueurId, nom: joueurAct.nom, penalite: carteAct.penalite_refus || 'shot' });
        }
        break;
      }

      case 'MONTER_PALIER': {
        var joueurPal = session.joueurs[ws.joueurId];
        if (!joueurPal || joueurPal.palier >= 2) return;
        joueurPal.palier++;
        send(ws, { type: 'PALIER_UPDATE', palier: joueurPal.palier });
        broadcast(session, { type: 'JOUEUR_PALIER_UP', joueurId: ws.joueurId, nom: joueurPal.nom, palier: joueurPal.palier });
        break;
      }

      case 'END_GAME': {
        if (ws.role !== 'host') return;
        session.etat = 'fin';
        var joueursFinaux = Object.values(session.joueurs).sort(function(a, b) { return b.points - a.points; });
        var jugements = session.cartes.repliques_oracle.jugement_final;
        var verdicts = joueursFinaux.map(function(j, i) {
          return {
            nom: j.nom, points: j.points, palier: j.palier,
            verdict: jugements[i % jugements.length].replace(/{joueur}/g, j.nom)
          };
        });
        broadcast(session, { type: 'GAME_OVER', verdicts: verdicts });
        break;
      }
    }
  });

  ws.on('close', function() {
    Object.values(sessions).forEach(function(session) {
      if (ws.joueurId && session.joueurs[ws.joueurId]) {
        session.joueurs[ws.joueurId].ws = null;
        broadcast(session, { type: 'JOUEUR_DISCONNECTED', joueurId: ws.joueurId, nom: session.joueurs[ws.joueurId].nom });
      }
      if (session.hostWs === ws) session.hostWs = null;
    });
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveAccord(session, actionId, raison) {
  var accord = session.accordsEnCours[actionId];
  if (!accord) return;
  var tousAccepte = Object.values(accord.reponses).every(function(r) { return r === true; }) && Object.keys(accord.reponses).length >= 2;
  var j1 = session.joueurs[accord.joueur1Id];
  var j2 = session.joueurs[accord.joueur2Id];
  if (tousAccepte) {
    if (j1) j1.points += accord.carte.points || 0;
    if (j2) j2.points += accord.carte.points || 0;
    broadcast(session, { type: 'ACCORD_OUI', actionId: actionId, joueur1: j1 ? j1.nom : '', joueur2: j2 ? j2.nom : '', points: accord.carte.points });
  } else {
    broadcast(session, { type: 'ACCORD_NON', actionId: actionId, penalite: accord.carte.penalite_refus || 'shot chacun' });
  }
  delete session.accordsEnCours[actionId];
}

function resolveVote(session, voteId) {
  var vote = session.votesEnCours[voteId];
  if (!vote) return;
  var scores = {};
  Object.values(vote.votes).forEach(function(cibleId) {
    scores[cibleId] = (scores[cibleId] || 0) + 1;
  });
  var maxVotes = Math.max.apply(null, Object.values(scores).concat([0]));
  var finalistes = Object.entries(scores).filter(function(e) { return e[1] === maxVotes; }).map(function(e) { return e[0]; });
  if (finalistes.length === 0) {
    var j = getJoueurAleatoire(session);
    finalistes = j ? [j.id] : [];
  }
  var designeId;
  if (finalistes.length === 1) {
    designeId = finalistes[0];
  } else {
    var finalJoueurs = finalistes.map(function(id) { return session.joueurs[id]; }).filter(Boolean);
    finalJoueurs.sort(function(a, b) { return (a.points || 0) - (b.points || 0); });
    var minPoints = finalJoueurs[0].points || 0;
    var vraisExaequo = finalJoueurs.filter(function(j) { return (j.points || 0) === minPoints; });
    designeId = vraisExaequo[Math.floor(Math.random() * vraisExaequo.length)].id;
  }
  var designe = session.joueurs[designeId];
  if (!designe) { delete session.votesEnCours[voteId]; return; }
  designe.points += vote.carte.points || 0;
  var repliques = session.cartes.repliques_oracle;
  var isEgalite = finalistes.length > 1;
  var repliquesPool = isEgalite ? repliques.vote_egalite : repliques.vote_resultat;
  var replique = repliquesPool[Math.floor(Math.random() * repliquesPool.length)].replace(/{joueur}/g, designe.nom);
  broadcast(session, { type: 'VOTE_RESULTAT', voteId: voteId, designeId: designeId, designeNom: designe.nom, replique: replique, isEgalite: isEgalite });
  if (designe.ws) send(designe.ws, { type: 'ACTION_SOLO', texte: vote.carte.texte_joueur, points: vote.carte.points });
  delete session.votesEnCours[voteId];
}

function tirerCarte(session) {
  var joueurs = Object.values(session.joueurs);
  if (joueurs.length === 0) return null;
  var palierMin = Math.min.apply(null, joueurs.map(function(j) { return j.palier || 0; }));
  var paliers = ['tiede', 'chaud', 'brulant'];
  var palierNom = paliers[palierMin] || 'tiede';
  var cartesDisponibles = session.cartes.cartes[palierNom].filter(function(c) { return !session.cartesUtilisees.has(c.id); });
  var pool = cartesDisponibles.length > 0 ? cartesDisponibles : session.cartes.cartes[palierNom];
  if (pool.length === 0) return null;
  var carte = pool[Math.floor(Math.random() * pool.length)];
  session.cartesUtilisees.add(carte.id);
  return Object.assign({}, carte, { palierNom: palierNom });
}

function getJoueurAleatoire(session) {
  var joueurs = Object.values(session.joueurs).filter(function(j) { return j.ws; });
  if (joueurs.length === 0) return null;
  return joueurs[Math.floor(Math.random() * joueurs.length)];
}

/**
 * Determine si une paire est compatible pour un duo intime.
 * Regle : si l un des deux est hetero ET qu ils ont le meme sexe declare -> incompatible.
 * 'autre' est compatible avec tout le monde.
 * Pour les duos non intimes (tiede) : toujours compatible.
 */
function paireCompatible(j1, j2) {
  var s1 = j1.sexe || 'autre';
  var s2 = j2.sexe || 'autre';
  // Si l un est 'autre' -> toujours OK
  if (s1 === 'autre' || s2 === 'autre') return true;
  // Si meme sexe declare -> incompatible (on suppose heterosexualite par defaut)
  if (s1 === s2) return false;
  return true;
}

/**
 * Selectionne un duo aleatoire.
 * Si estIntime=true, tente de trouver une paire compatible (sexes differents).
 * Si aucune paire compatible n'existe, fallback sur paire aleatoire pour ne pas bloquer.
 */
function getDuoAleatoire(session, estIntime) {
  var joueurs = Object.values(session.joueurs).filter(function(j) { return j.ws; });
  if (joueurs.length < 2) return null;

  // Melanger
  joueurs.sort(function() { return Math.random() - 0.5; });

  if (!estIntime) {
    // Duo non intime : peu importe la compatibilite
    return [joueurs[0], joueurs[1]];
  }

  // Duo intime : chercher une paire compatible
  for (var i = 0; i < joueurs.length; i++) {
    for (var k = i + 1; k < joueurs.length; k++) {
      if (paireCompatible(joueurs[i], joueurs[k])) {
        return [joueurs[i], joueurs[k]];
      }
    }
  }

  // Aucune paire compatible trouvee (ex: groupe mono-sexe) -> fallback aleatoire
  return [joueurs[0], joueurs[1]];
}

function getJoueursList(session) {
  return Object.values(session.joueurs).map(function(j) { return { id: j.id, nom: j.nom, palier: j.palier, points: j.points }; });
}

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcast(session, data) {
  if (session.hostWs) send(session.hostWs, data);
  Object.values(session.joueurs).forEach(function(j) { if (j.ws) send(j.ws, data); });
}

var PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', function() {
  console.log('DIABLO en ligne sur port ' + PORT);
});
