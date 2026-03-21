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

// Nettoyage des sessions inactives toutes les heures (sessions > 12h)
setInterval(function() {
  var now = Date.now();
  Object.keys(sessions).forEach(function(id) {
    if (now - sessions[id].createdAt > 12 * 60 * 60 * 1000) {
      delete sessions[id];
      console.log('Session ' + id + ' nettoyee');
    }
  });
}, 60 * 60 * 1000);

function createSession(hostName) {
  var id = uuidv4().slice(0, 6).toUpperCase();
  sessions[id] = {
    id: id,
    host: hostName,
    joueurs: {},
    etat: 'lobby',
    tourActuel: null,
    accordsEnCours: {},
    votesEnCours: {},
    cartes: loadCartes(),
    cartesUtilisees: { tiede: new Set(), chaud: new Set(), brulant: new Set() },
    createdAt: Date.now()
  };
  return sessions[id];
}

function loadCartes() {
  var cartesPath = path.join(__dirname, 'contenu', 'cartes.json');
  return JSON.parse(fs.readFileSync(cartesPath, 'utf8'));
}

app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'oracle.html')); });
app.get('/joueur', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'joueur.html')); });

app.post('/api/session', function(req, res) {
  var session = createSession(req.body.hostName || 'Oracle');
  res.json({ sessionId: session.id });
});

app.get('/api/qr/:sessionId', async function(req, res) {
  var sessionId = req.params.sessionId;
  var host = req.headers['x-forwarded-host'] || req.headers.host;
  var proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  var url = proto + '://' + host + '/joueur?s=' + sessionId;
  try {
    var qr = await QRCode.toDataURL(url, { width: 300, color: { dark: '#ff2d55', light: '#1a1a2e' } });
    res.json({ qr: qr, url: url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/session/:id', function(req, res) {
  var s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Session introuvable' });
  res.json({
    id: s.id, host: s.host, etat: s.etat,
    joueurs: Object.values(s.joueurs).map(function(j) {
      return { id: j.id, nom: j.nom, palier: j.palier, points: j.points };
    }),
    nbJoueurs: Object.keys(s.joueurs).length
  });
});

// Ping WebSocket toutes les 25s pour eviter timeout Railway
setInterval(function() {
  wss.clients.forEach(function(ws) {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('connection', function(ws) {
  ws.id = uuidv4();
  ws.isAlive = true;
  ws.on('pong', function() { ws.isAlive = true; });

  ws.on('message', function(raw) {
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
          // Reconnexion : mettre a jour le ws et le sexe si fourni
          session.joueurs[joueurId].ws = ws;
          if (msg.sexe) session.joueurs[joueurId].sexe = msg.sexe;
          isReconnect = true;
        } else {
          joueurId = uuidv4().slice(0, 8);
          session.joueurs[joueurId] = {
            id: joueurId,
            nom: msg.nom || ('Joueur' + (Object.keys(session.joueurs).length + 1)),
            sexe: msg.sexe || 'autre',
            palier: 0,
            points: 0,
            ws: ws
          };
        }
        ws.joueurId = joueurId;
        ws.sessionId = msg.sessionId;
        ws.role = 'joueur';
        var joueur = session.joueurs[joueurId];
        send(ws, {
          type: 'JOIN_OK',
          joueurId: joueurId,
          nom: joueur.nom,
          sexe: joueur.sexe,
          palier: joueur.palier,
          points: joueur.points,
          etatSession: session.etat,
          isReconnect: isReconnect
        });
        broadcast(session, {
          type: isReconnect ? 'JOUEUR_RECONNECTED' : 'JOUEUR_JOINED',
          joueurId: joueurId,
          nom: joueur.nom,
          totalJoueurs: Object.keys(session.joueurs).length
        });
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
        // Replique d intro aleatoire
        var introPool = session.cartes.repliques_oracle.intro;
        var introMsg = introPool[Math.floor(Math.random() * introPool.length)];
        broadcast(session, { type: 'GAME_STARTED', introMsg: introMsg });
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
          var joueur2 = getJoueurAleatoireSauf(session, joueurCible.id);
          var texte = carte.texte
            .replace(/{joueur}/g, joueurCible.nom)
            .replace(/{joueur2}/g, joueur2 ? joueur2.nom : '');
          broadcast(session, { type: 'NOUVELLE_CARTE', carte: Object.assign({}, carte, { texte: texte, joueurCible: joueurCible.nom, joueurCibleId: joueurCible.id }) });
          if (joueurCible.ws) send(joueurCible.ws, { type: 'ACTION_SOLO', texte: carte.texte_joueur, points: carte.points });
        }

        else if (carte.type === 'duo') {
          var estIntime = (carte.palierNom === 'chaud' || carte.palierNom === 'brulant');
          var duoResult = getDuoAleatoire(session, estIntime);
          if (!duoResult) return;
          var j1 = duoResult[0];
          var j2 = duoResult[1];
          var fallback = duoResult[2];
          var texte2 = carte.texte.replace(/{joueur1}/g, j1.nom).replace(/{joueur2}/g, j2.nom);
          broadcast(session, { type: 'NOUVELLE_CARTE', carte: Object.assign({}, carte, { texte: texte2, joueur1: j1.nom, joueur1Id: j1.id, joueur2: j2.nom, joueur2Id: j2.id, duoFallback: fallback || false }) });
          var actionId = uuidv4().slice(0, 8);
          session.accordsEnCours[actionId] = {
            actionId: actionId, carte: carte, joueur1Id: j1.id, joueur2Id: j2.id, reponses: {},
            timeout: setTimeout(function() { resolveAccord(session, actionId, 'timeout'); }, 30000)
          };
          if (j1.ws) send(j1.ws, { type: 'ACCORD_REQUIS', actionId: actionId, texte: carte.texte_joueur, partenaire: j2.nom });
          if (j2.ws) send(j2.ws, { type: 'ACCORD_REQUIS', actionId: actionId, texte: carte.texte_joueur, partenaire: j1.nom });
          send(ws, { type: 'ACCORD_EN_ATTENTE', actionId: actionId, duoFallback: fallback || false });
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
          var texteGroupe = carte.texte.replace(/{joueur}/g, cible.nom);
          // Replique de lancement groupe
          var grpPool = session.cartes.repliques_oracle.groupe_lancement;
          var grpMsg = grpPool[Math.floor(Math.random() * grpPool.length)].replace(/{joueur}/g, cible.nom);
          broadcast(session, { type: 'NOUVELLE_CARTE', carte: Object.assign({}, carte, { texte: texteGroupe, joueurCible: cible.nom, joueurCibleId: cible.id, groupeMsg: grpMsg }) });
          if (cible.ws) send(cible.ws, { type: 'ACTION_GROUPE_CIBLE', texte: carte.texte_joueur, duree: 30 });
          send(ws, { type: 'GROUPE_EN_ATTENTE', cibleNom: cible.nom, cibleId: cible.id, duree: 30, groupeMsg: grpMsg });
        }

        else if (carte.type === 'shot') {
          // Notifier les joueurs concernes sur leur telephone
          broadcast(session, { type: 'NOUVELLE_CARTE', carte: carte });
          // Envoyer un ping shot a tous les joueurs (chacun voit si ca le concerne)
          Object.values(session.joueurs).forEach(function(j) {
            if (j.ws) send(j.ws, { type: 'SHOT_NOTIF', texte: carte.texte });
          });
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
        var repPool;
        if (msg.succes) {
          repPool = session.cartes.repliques_oracle.groupe_succes;
          var repMsg = repPool[Math.floor(Math.random() * repPool.length)].replace(/{joueur}/g, msg.cibleNom);
          broadcast(session, { type: 'GROUPE_SUCCES', cibleNom: msg.cibleNom, cibleId: msg.cibleId, replique: repMsg });
        } else {
          repPool = session.cartes.repliques_oracle.groupe_echec;
          var repMsgE = repPool[Math.floor(Math.random() * repPool.length)].replace(/{joueur}/g, msg.cibleNom);
          // Shot collectif : notifier tous les joueurs sauf la cible
          Object.values(session.joueurs).forEach(function(j) {
            if (j.ws && j.id !== msg.cibleId) {
              send(j.ws, { type: 'SHOT_NOTIF', texte: 'Le groupe a echoue. Tu bois.' });
            }
          });
          broadcast(session, { type: 'GROUPE_ECHEC', cibleNom: msg.cibleNom, replique: repMsgE });
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
          // Replique de felicitations
          var felPool = session.cartes.repliques_oracle.felicitations;
          var felMsg = felPool[Math.floor(Math.random() * felPool.length)];
          broadcast(session, { type: 'ACTION_ACCOMPLIE', joueurId: ws.joueurId, nom: joueurAct.nom, points: joueurAct.points, replique: felMsg });
        } else {
          // Shot au refus : notifier le joueur
          var refPool = session.cartes.repliques_oracle.refus;
          var refMsg = refPool[Math.floor(Math.random() * refPool.length)];
          if (joueurAct.ws) send(joueurAct.ws, { type: 'SHOT_NOTIF', texte: carteAct.penalite_refus || 'shot' });
          broadcast(session, { type: 'ACTION_REFUSEE', joueurId: ws.joueurId, nom: joueurAct.nom, penalite: carteAct.penalite_refus || 'shot', replique: refMsg });
        }
        break;
      }

      case 'MONTER_PALIER': {
        var joueurPal = session.joueurs[ws.joueurId];
        if (!joueurPal || joueurPal.palier >= 2) return;
        joueurPal.palier++;
        send(ws, { type: 'PALIER_UPDATE', palier: joueurPal.palier });
        // Replique de transition si tout le groupe monte
        var palierMin = Math.min.apply(null, Object.values(session.joueurs).map(function(j) { return j.palier || 0; }));
        var transitionMsg = null;
        if (palierMin === 1) {
          var pool1 = session.cartes.repliques_oracle.transition_chaud;
          transitionMsg = pool1[Math.floor(Math.random() * pool1.length)];
        } else if (palierMin === 2) {
          var pool2 = session.cartes.repliques_oracle.transition_brulant;
          transitionMsg = pool2[Math.floor(Math.random() * pool2.length)];
        }
        broadcast(session, { type: 'JOUEUR_PALIER_UP', joueurId: ws.joueurId, nom: joueurPal.nom, palier: joueurPal.palier, palierMinGroupe: palierMin, transitionMsg: transitionMsg });
        break;
      }

      case 'END_GAME': {
        if (ws.role !== 'host') return;
        session.etat = 'fin';
        var joueursFinaux = Object.values(session.joueurs).sort(function(a, b) { return b.points - a.points; });
        var jugements = session.cartes.repliques_oracle.jugement_final;
        // Melanger les jugements pour eviter les repetitions
        var jugsCopy = jugements.slice();
        jugsCopy.sort(function() { return Math.random() - 0.5; });
        var verdicts = joueursFinaux.map(function(j, i) {
          return {
            id: j.id,
            nom: j.nom,
            points: j.points,
            palier: j.palier,
            verdict: jugsCopy[i % jugsCopy.length].replace(/{joueur}/g, j.nom)
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveAccord(session, actionId, raison) {
  var accord = session.accordsEnCours[actionId];
  if (!accord) return;
  var tousAccepte = Object.keys(accord.reponses).length >= 2 &&
    Object.values(accord.reponses).every(function(r) { return r === true; });
  var j1 = session.joueurs[accord.joueur1Id];
  var j2 = session.joueurs[accord.joueur2Id];
  if (tousAccepte) {
    if (j1) j1.points += accord.carte.points || 0;
    if (j2) j2.points += accord.carte.points || 0;
    var oui = session.cartes.repliques_oracle.double_accord_oui;
    var ouiMsg = oui[Math.floor(Math.random() * oui.length)];
    broadcast(session, {
      type: 'ACCORD_OUI',
      actionId: actionId,
      joueur1Id: accord.joueur1Id,
      joueur2Id: accord.joueur2Id,
      joueur1: j1 ? j1.nom : '',
      joueur2: j2 ? j2.nom : '',
      joueur1Points: j1 ? j1.points : 0,
      joueur2Points: j2 ? j2.points : 0,
      points: accord.carte.points || 0,
      replique: ouiMsg
    });
  } else {
    var non = session.cartes.repliques_oracle.double_accord_non;
    var nonMsg = non[Math.floor(Math.random() * non.length)];
    // Shot au refus pour les deux
    if (j1 && j1.ws) send(j1.ws, { type: 'SHOT_NOTIF', texte: accord.carte.penalite_refus || 'shot' });
    if (j2 && j2.ws) send(j2.ws, { type: 'SHOT_NOTIF', texte: accord.carte.penalite_refus || 'shot' });
    broadcast(session, { type: 'ACCORD_NON', actionId: actionId, penalite: accord.carte.penalite_refus || 'shot chacun', replique: nonMsg });
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

  var maxVotes = Object.values(scores).length > 0 ? Math.max.apply(null, Object.values(scores)) : 0;
  var finalistes = Object.entries(scores).filter(function(e) { return e[1] === maxVotes; }).map(function(e) { return e[0]; });

  if (finalistes.length === 0) {
    var jRand = getJoueurAleatoire(session);
    finalistes = jRand ? [jRand.id] : [];
  }

  var designeId;
  var isEgalite = finalistes.length > 1;
  if (!isEgalite) {
    designeId = finalistes[0];
  } else {
    var finalJoueurs = finalistes.map(function(id) { return session.joueurs[id]; }).filter(Boolean);
    finalJoueurs.sort(function(a, b) { return (a.points || 0) - (b.points || 0); });
    var minPoints = finalJoueurs[0].points || 0;
    var exaequo = finalJoueurs.filter(function(j) { return (j.points || 0) === minPoints; });
    designeId = exaequo[Math.floor(Math.random() * exaequo.length)].id;
  }

  var designe = session.joueurs[designeId];
  if (!designe) { delete session.votesEnCours[voteId]; return; }

  designe.points += vote.carte.points || 0;

  var repliques = session.cartes.repliques_oracle;
  var pool = isEgalite ? repliques.vote_egalite : repliques.vote_resultat;
  var replique = pool[Math.floor(Math.random() * pool.length)].replace(/{joueur}/g, designe.nom);

  broadcast(session, {
    type: 'VOTE_RESULTAT',
    voteId: voteId,
    designeId: designeId,
    designeNom: designe.nom,
    designePoints: designe.points,
    replique: replique,
    isEgalite: isEgalite
  });

  // Envoyer l action au designe avec le label correct
  if (designe.ws) send(designe.ws, { type: 'ACTION_VOTE_DESIGNE', texte: vote.carte.texte_joueur, points: vote.carte.points });
  delete session.votesEnCours[voteId];
}

function tirerCarte(session) {
  var joueurs = Object.values(session.joueurs);
  if (joueurs.length === 0) return null;

  var palierMin = Math.min.apply(null, joueurs.map(function(j) { return j.palier || 0; }));
  var paliers = ['tiede', 'chaud', 'brulant'];
  var palierNom = paliers[Math.min(palierMin, 2)];

  var used = session.cartesUtilisees[palierNom];
  var cartesDisponibles = session.cartes.cartes[palierNom].filter(function(c) { return !used.has(c.id); });

  if (cartesDisponibles.length === 0) {
    session.cartesUtilisees[palierNom] = new Set();
    cartesDisponibles = session.cartes.cartes[palierNom];
  }

  if (cartesDisponibles.length === 0) return null;

  var carte = cartesDisponibles[Math.floor(Math.random() * cartesDisponibles.length)];
  session.cartesUtilisees[palierNom].add(carte.id);
  return Object.assign({}, carte, { palierNom: palierNom });
}

function getJoueurAleatoire(session) {
  var joueurs = Object.values(session.joueurs).filter(function(j) { return j.ws; });
  if (joueurs.length === 0) return null;
  return joueurs[Math.floor(Math.random() * joueurs.length)];
}

function getJoueurAleatoireSauf(session, excludeId) {
  var joueurs = Object.values(session.joueurs).filter(function(j) { return j.ws && j.id !== excludeId; });
  if (joueurs.length === 0) return null;
  return joueurs[Math.floor(Math.random() * joueurs.length)];
}

function paireCompatible(j1, j2) {
  var s1 = j1.sexe || 'autre';
  var s2 = j2.sexe || 'autre';
  if (s1 === 'autre' || s2 === 'autre') return true;
  return s1 !== s2;
}

// Retourne [j1, j2, fallback]
function getDuoAleatoire(session, estIntime) {
  var joueurs = Object.values(session.joueurs).filter(function(j) { return j.ws; });
  if (joueurs.length < 2) return null;
  joueurs.sort(function() { return Math.random() - 0.5; });
  if (!estIntime) return [joueurs[0], joueurs[1], false];
  for (var i = 0; i < joueurs.length; i++) {
    for (var k = i + 1; k < joueurs.length; k++) {
      if (paireCompatible(joueurs[i], joueurs[k])) return [joueurs[i], joueurs[k], false];
    }
  }
  return [joueurs[0], joueurs[1], true];
}

function getJoueursList(session) {
  return Object.values(session.joueurs).map(function(j) {
    return { id: j.id, nom: j.nom, palier: j.palier, points: j.points };
  });
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
