/**
 * LanCouch room logic — seats, tokens, lobby/round phase, CTF teams, roster broadcasting.
 *
 * Transport-agnostic: this file never touches a socket. The caller hands in how to deliver a JSON
 * object or an 8-byte input frame to a "conn" (any object the caller likes; this module only adds
 * `role` and `seat` fields to it). Two callers exist:
 *
 *   - tools/lancouch/server.js — the LAN relay; conns wrap a `ws` WebSocket.
 *   - Assets/WebGLTemplates/LanCouch/index.html — the hosted-WebGL game tab; conns wrap a WebRTC
 *     DataChannel pair, and the tab itself plays the part of the server (see the "Hosted WebGL"
 *     section of README.md).
 *
 * Wire protocol: see the doc comment at the top of server.js. Unchanged by this extraction.
 *
 * Loadable as a Node module (`require('./room')`) or a plain browser <script> (`window.LanCouchRoom`).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LanCouchRoom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_SEATS = 6; // matches CouchController's fixed-array cap (Assets/CollapseGame/CouchController.cs)

  // Must stay mutually distinct — ship ownership in-game is exact Color equality on this value.
  // The Unity-side palette (Assets/CollapseGame/LanCouch/LanCouchPlayer.cs) uses the same RGB triples.
  const PALETTE = [
    { hex: '#3B82F6', name: 'Blue' },
    { hex: '#EF4444', name: 'Red' },
    { hex: '#22C55E', name: 'Green' },
    { hex: '#EAB308', name: 'Yellow' },
    { hex: '#A855F7', name: 'Purple' },
    { hex: '#EC4899', name: 'Pink' },
  ];

  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easy to read off a TV

  /**
   * @param {object} opts
   * @param {string} opts.code                       initial room code
   * @param {(conn, obj) => void} opts.sendJson      deliver a JSON object to conn (no-op if it's closed)
   * @param {(conn, bytes: Uint8Array) => void} opts.sendBinary   deliver an input frame to conn (no-op if closed)
   * @param {() => string} opts.randomToken          reconnect-token generator (crypto.randomUUID)
   */
  function createRoom(opts) {
    const { sendJson, sendBinary, randomToken } = opts;

    const room = {
      code: opts.code,
      phase: 'lobby', // 'lobby' | 'started'
      ctf: false, // the level about to be played is capture-the-flag (set by the host via "mode")
      seats: new Array(MAX_SEATS).fill(null), // each: { token, name, color, connected, conn, team, lastPrimaryReleases, lastSecondaryReleases }
      hostConn: null, // the ONE real game connection — input frames relay here
      spectators: new Set(), // any number of view-only debug/monitoring connections (public/debug.html) — see 'spectator' role below
    };

    function publicSeats() {
      // Never emits null for an empty seat (see the protocol doc comment in server.js) — always
      // MAX_SEATS entries so both the HTML overlay and Unity's JsonUtility can rely on a fixed,
      // fully-populated array shape.
      return room.seats.map((s, i) =>
        s
          ? { seat: i, occupied: true, name: s.name, color: s.color, connected: s.connected, team: s.team || 0 }
          : { seat: i, occupied: false, name: '', color: '', connected: false, team: 0 }
      );
    }

    function sendToHostAndSpectators(payload) {
      if (room.hostConn) sendJson(room.hostConn, payload);
      for (const spectator of room.spectators) sendJson(spectator, payload);
    }

    function broadcastRoster() {
      sendToHostAndSpectators({ type: 'roster', phase: room.phase, ctf: room.ctf, seats: publicSeats() });
    }

    function broadcastStarted() {
      const payload = { type: 'started', ctf: room.ctf, seats: publicSeats() };
      sendToHostAndSpectators(payload);
      for (const seat of room.seats) {
        if (seat && seat.conn) sendJson(seat.conn, payload);
      }
    }

    function zeroInputFrame(seatIndex) {
      // Stop the ship immediately on disconnect rather than waiting out the staleness timeout.
      // Buttons/stick go to 0, but the release counters are left EXACTLY as last seen (not
      // incremented, not reset to 0) — nothing on the phone actually closed the press, it just
      // stopped reporting. LanCouchInputSource's edge machine handles this deliberately: a held
      // button whose wire level drops to false while its release counter stays put is exactly the
      // "disconnect/staleness" fallback case, not a counted release.
      const seat = room.seats[seatIndex];
      const buf = new Uint8Array(8);
      buf[0] = seatIndex;
      buf[6] = seat ? seat.lastPrimaryReleases || 0 : 0;
      buf[7] = seat ? seat.lastSecondaryReleases || 0 : 0;
      return buf;
    }

    function attachPhone(conn, seatIndex) {
      const seat = room.seats[seatIndex];
      conn.role = 'phone';
      conn.seat = seatIndex;
      seat.connected = true;
      seat.conn = conn;
      sendJson(conn, {
        type: 'seated',
        seat: seatIndex,
        color: seat.color,
        name: seat.name,
        token: seat.token,
        // Reconnecting phones must resume counting from here, not from 0, or the Unity-side edge
        // machine's wrap-safe subtraction sees a large spurious backlog of "unconsumed" releases.
        primaryReleases: seat.lastPrimaryReleases || 0,
        secondaryReleases: seat.lastSecondaryReleases || 0,
        ctf: room.ctf,
        team: seat.team || 0,
      });
      // A phone that reconnects mid-round (token reconnect) would otherwise stay on c.html's "wait"
      // screen forever: 'seated' puts it back in the lobby UI and nothing else tells it the round is
      // already running. Re-send 'started' so it resumes the controls.
      if (room.phase === 'started') sendJson(conn, { type: 'started', ctf: room.ctf, seats: publicSeats() });
      broadcastRoster();
    }

    function handleHello(conn, msg) {
      if (conn.role === 'host') return;

      const code = String(msg.code || '').toUpperCase();
      if (code !== room.code) {
        sendJson(conn, { type: 'rejected', reason: 'bad-code' });
        return;
      }

      // Reconnect by token — allowed in any phase, since the seat already exists and this never
      // resizes CouchController's fixed player array.
      if (msg.token) {
        const seatIndex = room.seats.findIndex((s) => s && s.token === msg.token);
        if (seatIndex !== -1) {
          attachPhone(conn, seatIndex);
          return;
        }
      }

      if (room.phase !== 'lobby') {
        sendJson(conn, { type: 'rejected', reason: 'started' });
        return;
      }

      const seatIndex = room.seats.findIndex((s) => s === null);
      if (seatIndex === -1) {
        sendJson(conn, { type: 'rejected', reason: 'full' });
        return;
      }

      const name = (msg.name && String(msg.name).slice(0, 16)) || `Player ${seatIndex + 1}`;
      room.seats[seatIndex] = {
        token: randomToken(),
        name,
        color: PALETTE[seatIndex].hex,
        connected: true,
        conn: null,
        team: 0, // capture-the-flag team: 0 = not picked, 1 = Blue, 2 = Red
        lastPrimaryReleases: 0,
        lastSecondaryReleases: 0,
      };
      attachPhone(conn, seatIndex);
    }

    function handleRename(conn, msg) {
      if (conn.role !== 'phone' || conn.seat === null) return;
      const seat = room.seats[conn.seat];
      if (!seat) return;

      const name = (msg.name && String(msg.name).trim().slice(0, 16)) || `Player ${conn.seat + 1}`;
      seat.name = name;
      sendJson(conn, { type: 'renamed', name });
      broadcastRoster();
    }

    function canControlRoom(conn) {
      // The real game connection or a view-only spectator (debug.html). Phones can NOT start (or
      // reset) the round any more: the game picks the level on its own level-select screen and starts
      // it from there, so a phone-side "Start" would have no level to start.
      return conn.role === 'host' || conn.role === 'spectator';
    }

    function handleStart(conn) {
      if (!canControlRoom(conn)) return;
      if (room.phase === 'started') return;
      // A level can't be started without controllers connected.
      if (!room.seats.some((s) => s !== null && s.connected)) {
        sendJson(conn, { type: 'startBlocked', reason: 'no-controllers' });
        return;
      }
      // Capture the flag: every connected phone must have picked a team first.
      if (room.ctf && room.seats.some((s) => s !== null && s.connected && !s.team)) {
        sendJson(conn, { type: 'startBlocked', reason: 'teams' });
        return;
      }
      room.phase = 'started';
      broadcastStarted();
    }

    function handleMode(conn, msg) {
      if (conn.role !== 'host') return;
      const ctf = !!msg.ctf;
      if (room.ctf === ctf) return;
      room.ctf = ctf;
      if (!ctf) for (const seat of room.seats) if (seat) seat.team = 0; // teams only mean something in CTF
      for (const seat of room.seats) {
        if (seat && seat.conn) sendJson(seat.conn, { type: 'mode', ctf: room.ctf, team: seat.team || 0 });
      }
      broadcastRoster();
    }

    function handleTeam(conn, msg) {
      if (conn.role !== 'phone' || conn.seat === null) return;
      if (room.phase !== 'lobby' || !room.ctf) return;
      const seat = room.seats[conn.seat];
      if (!seat) return;
      const team = msg.team === 1 || msg.team === 2 ? msg.team : 0;
      seat.team = team;
      sendJson(conn, { type: 'teamSet', team });
      broadcastRoster();
    }

    function returnToLobby() {
      // Seats/tokens/colors are kept so returning players land in the same seat/color — mirrors the
      // game's own GotoNextLevel flow, which reuses the roster.
      room.phase = 'lobby';
      broadcastRoster();
      for (const seat of room.seats) {
        if (seat && seat.conn) sendJson(seat.conn, { type: 'lobby' });
      }
    }

    function handleReset(conn) {
      if (!canControlRoom(conn)) return;
      returnToLobby();
    }

    function handleControlMessage(conn, msg) {
      switch (msg.type) {
        case 'host':
          conn.role = 'host';
          room.hostConn = conn;
          // A new host connection means the game (or the Editor test transport) just (re)started —
          // any round that was "started" belonged to a Unity instance that no longer exists, so
          // there is nothing left to preserve by staying in that phase. Without this, restarting
          // Play mode against a still-running server leaves "Start" silently no-op'ing forever
          // until someone manually sends "reset" first.
          if (room.phase === 'started') returnToLobby();
          sendJson(conn, { type: 'roster', phase: room.phase, ctf: room.ctf, seats: publicSeats() });
          break;
        case 'mode':
          handleMode(conn, msg);
          break;
        case 'team':
          handleTeam(conn, msg);
          break;
        case 'spectator':
          // A view-only monitoring connection (public/debug.html) — deliberately NOT the same as
          // 'host'. Only one connection is ever room.hostConn (the real game); an unbounded number
          // of spectators can watch alongside it without any of them displacing it. Before this
          // distinction existed, opening debug.html registered as 'host' too, silently STEALING
          // room.hostConn from Unity's LanCouchEditorClient — every subsequent "started"/"roster"
          // broadcast went only to whichever one connected last, and the other side saw nothing at
          // all with no error anywhere. That exact failure mode is why this role exists.
          conn.role = 'spectator';
          room.spectators.add(conn);
          sendJson(conn, { type: 'roster', phase: room.phase, ctf: room.ctf, seats: publicSeats() });
          break;
        case 'hello':
          handleHello(conn, msg);
          break;
        case 'rename':
          handleRename(conn, msg);
          break;
        case 'ping':
          // App-level liveness probe from the phone (c.html) — the WebSocket protocol-level ping
          // only runs every 15 s, far too slow to notice a few-second Wi-Fi stall.
          sendJson(conn, { type: 'pong' });
          break;
        case 'start':
          handleStart(conn);
          break;
        case 'reset':
          handleReset(conn);
          break;
        default:
          break;
      }
    }

    function handleInputFrame(conn, data) {
      if (conn.role !== 'phone' || conn.seat === null) return;
      if (data.length !== 8) return;

      const buf = new Uint8Array(data); // copy — never mutate the buffer the transport handed us in place
      buf[0] = conn.seat; // never trust the client's own seat claim

      const seat = room.seats[conn.seat];
      if (seat) {
        seat.lastPrimaryReleases = buf[6];
        seat.lastSecondaryReleases = buf[7];
      }

      // Spectators (debug.html) see the same raw frames the host does — "spectator" means "view
      // everything", not "everything except the fast-path data".
      if (room.hostConn) sendBinary(room.hostConn, buf);
      for (const spectator of room.spectators) sendBinary(spectator, buf);
    }

    function handleClose(conn) {
      if (conn.role === 'host') {
        if (room.hostConn === conn) room.hostConn = null;
        return;
      }
      if (conn.role === 'spectator') {
        room.spectators.delete(conn);
        return;
      }
      if (conn.role === 'phone' && conn.seat !== null) {
        const seat = room.seats[conn.seat];
        if (seat && seat.conn === conn) {
          seat.connected = false;
          seat.conn = null;
          if (room.hostConn) {
            sendBinary(room.hostConn, zeroInputFrame(conn.seat));
            sendJson(room.hostConn, { type: 'seatLeft', seat: conn.seat });
          }
          broadcastRoster();
        }
      }
    }

    return { room, handleControlMessage, handleInputFrame, handleClose };
  }

  function generateRoomCode(randomInt, length = 4) {
    let out = '';
    for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return out;
  }

  return { MAX_SEATS, PALETTE, CODE_ALPHABET, createRoom, generateRoomCode };
});
