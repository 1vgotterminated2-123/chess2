
/*
 * Chess 2 Firebase Multiplayer
 * Requires Firebase compat App, Auth, and Firestore SDKs
 * to be loaded before this file.
 */
(function (global) {
  "use strict";

  class Chess2FirestoreMultiplayer {
    constructor(options) {
      options = options || {};
      if (!options.db || !options.auth || !options.matchId) {
        throw new Error("Missing db, auth, or matchId.");
      }

      this.db = options.db;
      this.auth = options.auth;
      this.matchId = String(options.matchId);
      this.matchRef = this.db.collection("matches").doc(this.matchId);
      this.onState = options.onState || function () {};
      this.onPresence = options.onPresence || function () {};
      this.onError = options.onError || console.error;
      this.lastVersion = -1;
      this.myTeam = null;
      this.stopped = false;
    }

    static requireUser(auth) {
      if (!auth || !auth.currentUser) {
        throw new Error("Please sign in first.");
      }
      return auth.currentUser;
    }

    static async initializeMatch(options) {
      const db = options.db;
      const auth = options.auth;
      const lobbyId = String(options.lobbyId || "");
      const seats = options.seats || {};
      const user = this.requireUser(auth);

      if (!lobbyId) throw new Error("Missing lobby ID.");

      const teams = Object.keys(seats);
      if (teams.length < 2 || teams.length > 4) {
        throw new Error("A match needs 2 to 4 players.");
      }

      if (!teams.some(team => seats[team] === user.uid)) {
        throw new Error("You are not seated in this match.");
      }

      const lobbyRef = db.collection("lobbies").doc(lobbyId);
      const lobbySnap = await lobbyRef.get();

      if (!lobbySnap.exists || lobbySnap.data().status !== "started") {
        throw new Error("The lobby has not started.");
      }

      if (lobbySnap.data().hostUid !== user.uid) {
        throw new Error("Only the host can create the match.");
      }

      const matchRef = db.collection("matches").doc(lobbyId);

      await db.runTransaction(async transaction => {
        const existing = await transaction.get(matchRef);
        if (existing.exists) {
          throw new Error("Match already exists.");
        }

        transaction.set(matchRef, {
          lobbyId: lobbyId,
          roomCode: lobbyId,
          hostUid: user.uid,
          seats: seats,
          config: options.config || {},
          state: options.initialState || {},
          status: "active",
          turn: options.initialTurn || teams[0],
          version: 0,
          lastAction: {
            type: "match-created",
            by: user.uid,
            team: options.initialTurn || teams[0]
          },
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });

      return lobbyId;
    }

    findMyTeam(seats, uid) {
      return Object.keys(seats).find(
        team => seats[team] === uid
      ) || null;
    }

    async connect() {
      const user = Chess2FirestoreMultiplayer.requireUser(this.auth);
      const snapshot = await this.matchRef.get();

      if (!snapshot.exists) throw new Error("Match not found.");

      const match = snapshot.data();
      this.myTeam = this.findMyTeam(match.seats || {}, user.uid);

      if (!this.myTeam) {
        throw new Error("You are not a player in this match.");
      }

      this.stopped = false;

      this.unsubscribeMatch = this.matchRef.onSnapshot(
        snapshot => {
          if (this.stopped || !snapshot.exists) return;

          const data = snapshot.data();

          if (data.version === this.lastVersion) return;

          this.lastVersion = data.version;
          this.onState(data, { team: this.myTeam });
        },
        error => this.onError(error)
      );

      await this.setPresence(true);

      this.unsubscribePresence =
        this.matchRef.collection("presence").onSnapshot(
          snapshot => {
            const players = {};
            snapshot.forEach(doc => {
              players[doc.id] = doc.data();
            });
            this.onPresence(players);
          },
          error => this.onError(error)
        );

      return { team: this.myTeam, match: match };
    }

    async submit(options) {
      options = options || {};

      const user = Chess2FirestoreMultiplayer.requireUser(this.auth);

      if (!this.myTeam) {
        throw new Error("Connect to the match first.");
      }

      const expectedVersion =
        options.expectedVersion ?? this.lastVersion;

      await this.db.runTransaction(async transaction => {
        const snapshot = await transaction.get(this.matchRef);

        if (!snapshot.exists) throw new Error("Match not found.");

        const match = snapshot.data();

        if (match.status !== "active") {
          throw new Error("Match is not active.");
        }

        if (match.version !== expectedVersion) {
          throw new Error("Match changed. Please try again.");
        }

        if (match.turn !== this.myTeam) {
          throw new Error("It is not your turn.");
        }

        if (match.seats[this.myTeam] !== user.uid) {
          throw new Error("Seat verification failed.");
        }

        transaction.update(this.matchRef, {
          state: options.state,
          turn: options.nextTurn || this.myTeam,
          status: options.status || "active",
          version: match.version + 1,
          lastAction: {
            type: options.actionType || "state-update",
            by: user.uid,
            team: this.myTeam
          },
          updatedAt:
            firebase.firestore.FieldValue.serverTimestamp()
        });
      });
    }

    async setPresence(online) {
      const user = Chess2FirestoreMultiplayer.requireUser(this.auth);

      if (!this.myTeam) {
        const snapshot = await this.matchRef.get();
        if (!snapshot.exists) return;

        this.myTeam = this.findMyTeam(
          snapshot.data().seats || {},
          user.uid
        );
      }

      if (!this.myTeam) return;

      await this.matchRef
        .collection("presence")
        .doc(user.uid)
        .set({
          online: !!online,
          team: this.myTeam,
          updatedAt:
            firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }

    async disconnect() {
      try {
        await this.setPresence(false);
      } catch (error) {
        this.onError(error);
      }
      this.stop();
    }

    stop() {
      this.stopped = true;

      if (this.unsubscribeMatch) this.unsubscribeMatch();
      if (this.unsubscribePresence) this.unsubscribePresence();

      this.unsubscribeMatch = null;
      this.unsubscribePresence = null;
    }
  }

  global.Chess2FirestoreMultiplayer =
    Chess2FirestoreMultiplayer;

})(typeof window !== "undefined" ? window : this);
