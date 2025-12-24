import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Users,
  Music,
  Check,
  ChevronRight,
  Search,
  Trophy,
  RefreshCw,
  Settings,
  X,
  Copy,
  AlertCircle,
  Disc,
  Headphones,
  Eye,
  XCircle,
} from "lucide-react";

// --- FIREBASE IMPORTS ---
import { initializeApp } from "firebase/app";
import {
  getDatabase,
  ref,
  set,
  onValue,
  update,
  get,
  runTransaction,
} from "firebase/database";

import { GamePhase, GameState, Player, Song } from "./types";
import { MOCK_SONGS, INITIAL_QUESTIONS } from "./constants";
import {
  generateTriviaQuestions,
  searchMusicAI,
  generateAnnouncementAudio,
  decodeBase64,
  decodeAudioData,
} from "./services/geminiService";

/**
 * Extend GameState locally without changing your types.ts tonight.
 */
type GameStateExt = GameState & {
  listeningIndex?: number;
  hostToken?: string;
};

// ------------------------------------------------------------------
// PKCE HELPERS (Spotify requires this for SPAs)
// ------------------------------------------------------------------
const generateRandomString = (length: number) => {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const values = crypto.getRandomValues(new Uint8Array(length));
  values.forEach((v) => (result += chars[v % chars.length]));
  return result;
};

const sha256 = async (plain: string) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer);
};

const base64UrlEncode = (array: Uint8Array) =>
  btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const generateCodeChallenge = async (verifier: string) => {
  const hashed = await sha256(verifier);
  return base64UrlEncode(hashed);
};

// --- CONFIGURATION ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Initialize Firebase (Safely)
const app = firebaseConfig.apiKey ? initializeApp(firebaseConfig) : null;
const db = app ? getDatabase(app) : null;

// --- Utility Components ---
const Button: React.FC<{
  onClick?: () => void;
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger" | "outline" | "spotify";
  className?: string;
  disabled?: boolean;
}> = ({
  onClick,
  children,
  variant = "primary",
  className = "",
  disabled = false,
}) => {
  const variants = {
    primary: "bg-[#1DB954] hover:bg-[#1ed760] text-black font-bold",
    secondary: "bg-[#282828] hover:bg-[#3e3e3e] text-white font-medium",
    danger: "bg-red-600 hover:bg-red-700 text-white font-medium",
    outline:
      "border border-[#535353] hover:border-white text-white font-medium",
    spotify:
      "bg-[#1DB954] hover:scale-105 text-black font-bold flex items-center gap-2",
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-6 py-3 rounded-full transition-all duration-300 active:scale-95 disabled:opacity-50 disabled:scale-100 shadow-md hover:shadow-[#1DB954]/20 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
};

const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = "",
}) => (
  <div
    className={`bg-[#121212] bg-gradient-to-br from-[#181818] to-[#121212] rounded-2xl border border-[#282828] p-6 shadow-2xl ${className}`}
  >
    {children}
  </div>
);

type SpotifyDevice = {
  id: string;
  is_active: boolean;
  is_restricted: boolean;
  name: string;
  type: string;
  volume_percent?: number;
};

export default function App() {
  // --- STATE ---
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(() =>
    sessionStorage.getItem("tune_player_id")
  );
  const [playerName, setPlayerName] = useState(
    () => sessionStorage.getItem("tune_player_name") || ""
  );

  const [gameState, setGameState] = useState<GameStateExt>({
    roomId: "",
    phase: GamePhase.LOBBY,
    currentQuestionIndex: 0,
    questions: INITIAL_QUESTIONS,
    players: [],
    submissions: [],
    guesses: [],
    currentRevealIndex: 0,
    listeningIndex: 0,
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Song[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isAnnouncing, setIsAnnouncing] = useState(false);

  const [showSettings, setShowSettings] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [spotifyConnected, setSpotifyConnected] = useState<boolean>(() => {
    return !!localStorage.getItem("spotify_access_token");
  });

  const [spotifyToken, setSpotifyToken] = useState<string | null>(() =>
    localStorage.getItem("spotify_access_token")
  );
  const [hostToken, setHostToken] = useState<string | null>(null);

  const [spotifyRefreshToken, setSpotifyRefreshToken] = useState<string | null>(
    () => localStorage.getItem("spotify_refresh_token")
  );
  const [spotifyExpiresAt, setSpotifyExpiresAt] = useState<number>(() => {
    const v = localStorage.getItem("spotify_expires_at");
    return v ? Number(v) : 0;
  });

  const spotifyTokenRef = useRef<string | null>(spotifyToken);
  useEffect(() => {
    spotifyTokenRef.current = spotifyToken;
  }, [spotifyToken]);

  const [spotifyClientId, setSpotifyClientId] = useState(() => {
    return (
      import.meta.env.VITE_SPOTIFY_CLIENT_ID ||
      localStorage.getItem("spotify_client_id") ||
      ""
    );
  });

  const [manualRedirectUri, setManualRedirectUri] = useState(() => {
    return localStorage.getItem("spotify_redirect_uri_override") || "";
  });

  const [detectedDevices, setDetectedDevices] = useState<SpotifyDevice[]>([]);
  const [preferredDeviceId, setPreferredDeviceId] = useState<string>(() => {
    return localStorage.getItem("spotify_preferred_device_id") || "";
  });

  const audioContextRef = useRef<AudioContext | null>(null);

  // --- FIREBASE SYNC EFFECT ---
  useEffect(() => {
    if (!gameState.roomId || !db) return;

    const roomRef = ref(db, `rooms/${gameState.roomId}`);

    const unsubscribe = onValue(roomRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        setGameState((prev) => ({ ...prev, ...data }));
        if (data.hostToken) setHostToken(data.hostToken);
      }
    });

    return () => unsubscribe();
  }, [gameState.roomId]);

  // --- HOST PROXY LOGIC ---
  const myPlayer = gameState.players.find((p) => p.id === currentPlayerId);
  const isHost = myPlayer?.isHost;

  useEffect(() => {
    if (isHost && spotifyToken && gameState.roomId && db) {
      update(ref(db, `rooms/${gameState.roomId}`), { hostToken: spotifyToken }).catch(
        () => {}
      );
    }
  }, [isHost, spotifyToken, gameState.roomId]);

  // --- REDIRECT URI (fix nip.io.nip.io) ---
  const origin =
    typeof window !== "undefined" ? window.location.origin : "";
  const hostname =
    typeof window !== "undefined" ? new URL(origin).hostname : "";
  const isBareIP = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);

  const suggestedRedirectUri =
    manualRedirectUri ||
    (isBareIP
      ? `${window.location.protocol}//${hostname}.nip.io/`
      : `${origin}/`);

  useEffect(() => {
    localStorage.setItem("spotify_client_id", spotifyClientId);
    localStorage.setItem("spotify_redirect_uri_override", manualRedirectUri);
  }, [spotifyClientId, manualRedirectUri]);

  // ------------------------------------------------------------------
  // SPOTIFY AUTH (PKCE)
  // ------------------------------------------------------------------
  const connectSpotify = async () => {
    if (!spotifyClientId) {
      setShowSettings(true);
      return;
    }

    const redirectUri = suggestedRedirectUri.endsWith("/")
      ? suggestedRedirectUri
      : suggestedRedirectUri + "/";

    const verifier = generateRandomString(128);
    const challenge = await generateCodeChallenge(verifier);
    sessionStorage.setItem("spotify_pkce_verifier", verifier);

    const scopes = [
      "user-read-playback-state",
      "user-modify-playback-state",
      "streaming",
      "user-read-currently-playing",
      "user-read-email",
      "user-read-private",
    ].join(" ");

    const authUrl =
      "https://accounts.spotify.com/authorize" +
      `?client_id=${encodeURIComponent(spotifyClientId)}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&code_challenge_method=S256` +
      `&code_challenge=${challenge}` +
      `&show_dialog=true`;

    window.location.href = authUrl;
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");

    if (error) {
      console.error("Spotify auth error:", error);
      return;
    }
    if (!code) return;

    const verifier = sessionStorage.getItem("spotify_pkce_verifier");
    if (!verifier) {
      console.error("Missing PKCE verifier in sessionStorage");
      return;
    }

    const redirectUri = suggestedRedirectUri.endsWith("/")
      ? suggestedRedirectUri
      : suggestedRedirectUri + "/";

    const body = new URLSearchParams({
      client_id: spotifyClientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });

    fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    })
      .then((res) => res.json())
      .then((data) => {
        if (!data?.access_token) {
          console.error("Spotify token exchange failed:", data);
          return;
        }

        const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;

        setSpotifyConnected(true);
        setSpotifyToken(data.access_token);
        setSpotifyRefreshToken(data.refresh_token || null);
        setSpotifyExpiresAt(expiresAt);

        localStorage.setItem("spotify_access_token", data.access_token);
        if (data.refresh_token) {
          localStorage.setItem("spotify_refresh_token", data.refresh_token);
        }
        localStorage.setItem("spotify_expires_at", String(expiresAt));

        window.history.replaceState({}, "", window.location.pathname);
      })
      .catch((e) => console.error("Spotify auth exchange error:", e));
  }, [spotifyClientId, suggestedRedirectUri]);

  // ------------------------------------------------------------------
  // TOKEN REFRESH
  // ------------------------------------------------------------------
  const refreshSpotifyToken = async () => {
    const refreshToken =
      spotifyRefreshToken || localStorage.getItem("spotify_refresh_token");
    if (!refreshToken) return;

    const body = new URLSearchParams({
      client_id: spotifyClientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    try {
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      const data = await res.json();
      if (!data?.access_token) {
        console.error("Spotify refresh failed:", data);
        return;
      }

      const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;

      setSpotifyToken(data.access_token);
      setSpotifyConnected(true);
      setSpotifyExpiresAt(expiresAt);

      localStorage.setItem("spotify_access_token", data.access_token);
      localStorage.setItem("spotify_expires_at", String(expiresAt));

      if (data.refresh_token) {
        setSpotifyRefreshToken(data.refresh_token);
        localStorage.setItem("spotify_refresh_token", data.refresh_token);
      }
    } catch (e) {
      console.error("Spotify refresh error:", e);
    }
  };

  useEffect(() => {
    const interval = window.setInterval(() => {
      const expiresAt =
        spotifyExpiresAt ||
        Number(localStorage.getItem("spotify_expires_at") || 0);
      if (!expiresAt) return;
      if (Date.now() > expiresAt - 120_000) {
        refreshSpotifyToken();
      }
    }, 30_000);

    return () => window.clearInterval(interval);
  }, [spotifyExpiresAt, spotifyClientId, spotifyRefreshToken]);

  // ------------------------------------------------------------------
  // SPOTIFY CONNECT PLAYBACK (EXTERNAL DEVICES ONLY)
  // This prevents Spotify from snapping playback to "Tune Trivia".
  // ------------------------------------------------------------------
  const spotifyApiFetch = async (url: string, init?: RequestInit) => {
    const token = spotifyTokenRef.current;
    if (!token) throw new Error("NoSpotifyToken");
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });

    if (res.status === 401) {
      // Try refresh once
      await refreshSpotifyToken();
      const token2 = spotifyTokenRef.current;
      if (!token2) return res;
      return fetch(url, {
        ...init,
        headers: {
          ...(init?.headers || {}),
          Authorization: `Bearer ${token2}`,
        },
      });
    }

    return res;
  };

  const fetchDevices = async () => {
    try {
      const res = await spotifyApiFetch(
        "https://api.spotify.com/v1/me/player/devices"
      );
      const data = await res.json();
      const devices: SpotifyDevice[] = data?.devices || [];
      setDetectedDevices(devices);
      return devices;
    } catch (e) {
      console.error("Fetch devices failed:", e);
      return [];
    }
  };

  const choosePlaybackDevice = async (): Promise<SpotifyDevice | null> => {
    const devices = await fetchDevices();
    if (!devices.length) return null;

    const filtered = devices.filter((d) => !d.is_restricted);

    // Prefer a user-selected device
    if (preferredDeviceId) {
      const preferred = filtered.find((d) => d.id === preferredDeviceId);
      if (preferred) return preferred;
    }

    // Prefer an active device that is NOT Tune Trivia / Web Player
    const activeNonWeb = filtered.find(
      (d) =>
        d.is_active &&
        !/tune trivia/i.test(d.name) &&
        d.type.toLowerCase() !== "computer" // optional; remove if you want laptop preferred
    );
    if (activeNonWeb) return activeNonWeb;

    const activeAny = filtered.find((d) => d.is_active);
    if (activeAny && !/tune trivia/i.test(activeAny.name)) return activeAny;

    // Otherwise pick the first non–Tune Trivia device
    const firstNonTune = filtered.find((d) => !/tune trivia/i.test(d.name));
    if (firstNonTune) return firstNonTune;

    // Worst case: only Tune Trivia device exists
    return filtered[0] || null;
  };

  const transferPlaybackTo = async (deviceId: string) => {
    try {
      const res = await spotifyApiFetch("https://api.spotify.com/v1/me/player", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_ids: [deviceId],
          play: false,
        }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.warn("Transfer playback failed:", res.status, txt);
      }
    } catch (e) {
      console.error("Transfer playback error:", e);
    }
  };

  const playOnSpotifyDevice = async (spotifyTrackId: string) => {
    const chosen = await choosePlaybackDevice();

    if (!chosen) {
      alert(
        "No Spotify playback device found.\n\nOpen Spotify on the iPad/phone/laptop and start any song once, then try again."
      );
      return;
    }

    // If Tune Trivia device is active, force transfer away from it
    if (/tune trivia/i.test(chosen.name)) {
      alert(
        "Spotify is currently connected to Tune Trivia.\n\nIn Spotify, open Devices and select your iPad/phone/laptop speaker, then try again."
      );
      return;
    }

    // Ensure chosen device becomes active
    if (!chosen.is_active) {
      await transferPlaybackTo(chosen.id);
    }

    // Now play (with device_id to be explicit)
    try {
      const res = await spotifyApiFetch(
        `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(
          chosen.id
        )}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uris: [`spotify:track:${spotifyTrackId}`],
          }),
        }
      );

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.warn("Play failed:", res.status, txt);

        if (res.status === 404) {
          alert(
            "Spotify couldn't find an active device.\n\nOpen Spotify on the host device and start any song once, then try again."
          );
        }
      }
    } catch (e) {
      console.error("Play track error:", e);
    }
  };

  // --- AUDIO (announcement) ---
  const initAudio = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === "suspended") {
      audioContextRef.current.resume().catch(() => {});
    }
  };

  const playAnnouncement = async (song: Song, pName: string) => {
    if (!isHost) return; // host only to avoid duplicates
    try {
      initAudio();
      setIsAnnouncing(true);
      const base64Data = await generateAnnouncementAudio(
        song.title,
        song.artist,
        pName
      );

      if (base64Data && audioContextRef.current) {
        const audioData = decodeBase64(base64Data);
        const audioBuffer = await decodeAudioData(
          audioData,
          audioContextRef.current
        );
        const source = audioContextRef.current.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContextRef.current.destination);
        source.onended = () => setIsAnnouncing(false);
        source.start();
      } else {
        setIsAnnouncing(false);
      }
    } catch (e) {
      console.error("Announcement failed:", e);
      setIsAnnouncing(false);
    }
  };

  useEffect(() => {
    if (gameState.phase === GamePhase.REVEAL) {
      const currentSub = gameState.submissions[gameState.currentRevealIndex];
      if (!currentSub) return;

      const player = gameState.players.find((p) => p.id === currentSub.playerId);
      if (player) playAnnouncement(currentSub.song, player.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.phase, gameState.currentRevealIndex]);

  // --- GAME ACTIONS ---
  const syncUpdate = async (updates: Partial<GameStateExt>) => {
    if (!db || !gameState.roomId) return;
    try {
      await update(ref(db, `rooms/${gameState.roomId}`), updates as any);
    } catch (e: any) {
      console.error("Firebase update failed:", e);
      alert(`Firebase error: ${e?.message || e}`);
    }
  };

  const createRoom = async () => {
    if (!db) {
      alert("Firebase not connected! Please check your Coolify env vars.");
      return;
    }
    initAudio();

    const newRoomId = Math.random().toString(36).substring(2, 6).toUpperCase();
    const hostId = "p1_host_" + Date.now();

    const host: Player = {
      id: hostId,
      name: "Host",
      score: 0,
      isHost: true,
      avatar: "https://picsum.photos/seed/host/100/100",
    };

    const initialGame: GameStateExt = {
      roomId: newRoomId,
      phase: GamePhase.LOBBY,
      currentQuestionIndex: 0,
      questions: INITIAL_QUESTIONS,
      players: [host],
      submissions: [],
      guesses: [],
      currentRevealIndex: 0,
      listeningIndex: 0,
      hostToken: "",
    };

    await set(ref(db, `rooms/${newRoomId}`), initialGame as any);
    setCurrentPlayerId(hostId);
    sessionStorage.setItem("tune_player_id", hostId);
    setGameState(initialGame);
  };

  const joinRoom = async () => {
    if (!db) return;
    if (!roomCodeInput) return alert("Please enter a room code");
    if (!playerName) return alert("Please enter your name");

    const code = roomCodeInput.toUpperCase().trim();
    const roomRef = ref(db, `rooms/${code}`);
    const snapshot = await get(roomRef);

    if (!snapshot.exists()) return alert("Room not found! Check the code.");

    const game = snapshot.val();
    const newPlayerId = currentPlayerId || `p_${Date.now()}`;

    const newPlayer: Player = {
      id: newPlayerId,
      name: playerName,
      score: 0,
      isHost: false,
      avatar: `https://picsum.photos/seed/${newPlayerId}/100/100`,
    };

    await runTransaction(roomRef, (room: any) => {
      if (!room) return room;
      room.players = room.players || [];
      if (!room.players.some((p: any) => p.id === newPlayerId)) {
        room.players.push(newPlayer);
      }
      return room;
    });

    sessionStorage.setItem("tune_player_id", newPlayerId);
    sessionStorage.setItem("tune_player_name", playerName);
    setCurrentPlayerId(newPlayerId);
    setGameState(game);
  };

  const startGame = async () => {
    if (gameState.players.length < 2) {
      alert("Need at least 2 players to start!");
      return;
    }

    let aiQuestions = INITIAL_QUESTIONS;
    try {
      const generated = await generateTriviaQuestions(10);
      if (generated.length > 0) aiQuestions = generated;
    } catch {
      console.log("AI Generation failed, using defaults");
    }

    syncUpdate({
      phase: GamePhase.PROMPT,
      questions: aiQuestions,
      currentQuestionIndex: 0,
      submissions: [],
      guesses: [],
      currentRevealIndex: 0,
      listeningIndex: 0,
    });
  };

  const handleNextPrompt = () => {
    setSearchQuery("");
    setSearchResults([]);
    setSearchError(null);

    syncUpdate({
      phase: GamePhase.SUBMITTING,
      submissions: [],
      guesses: [],
      currentRevealIndex: 0,
      listeningIndex: 0,
    });
  };

  const submitSong = async (song: Song) => {
    if (!currentPlayerId || !db || !gameState.roomId) return;

    setSearchQuery("");
    setSearchResults([]);
    setSearchError(null);

    const roomRef = ref(db, `rooms/${gameState.roomId}`);

    await runTransaction(roomRef, (room: any) => {
      if (!room) return room;

      const currentSubs = room.submissions || [];
      if (currentSubs.find((s: any) => s.playerId === currentPlayerId)) return room;

      const updatedSubs = [...currentSubs, { playerId: currentPlayerId, song }];

      const playingPlayers = (room.players || []).filter((p: any) => !p.isHost);
      const hasEveryoneSubmitted = updatedSubs.length >= playingPlayers.length;

      room.submissions = updatedSubs;

      if (hasEveryoneSubmitted) {
        room.phase = GamePhase.LISTENING;
        room.listeningIndex = 0;
      }

      return room;
    });
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchError(null);

    const tokenToUse = spotifyToken || hostToken;

    if (tokenToUse) {
      try {
        const response = await fetch(
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(
            searchQuery
          )}&type=track&limit=10`,
          { headers: { Authorization: `Bearer ${tokenToUse}` } }
        );

        if (response.status === 401) {
          setSearchError(
            spotifyToken
              ? "Your Spotify token expired. Reconnect in Settings."
              : "Host Spotify token expired. Host needs to reconnect."
          );
          throw new Error("Token expired");
        }

        if (!response.ok) {
          const txt = await response.text().catch(() => "");
          throw new Error(`Spotify search failed: ${response.status} ${txt}`);
        }

        const data = await response.json();
        if (data.tracks?.items) {
          const spotifyResults: Song[] = data.tracks.items.map((t: any) => ({
            id: t.id,
            title: t.name,
            artist: t.artists?.[0]?.name || "Unknown",
            albumArt: t.album?.images?.[0]?.url || "https://picsum.photos/300/300",
          }));
          setSearchResults(spotifyResults);
          setIsSearching(false);
          return;
        }
      } catch (e) {
        console.error("Spotify search failed, falling back...", e);
      }
    }

    try {
      const aiMatched = await searchMusicAI(searchQuery);
      const results: Song[] =
        aiMatched.length > 0
          ? aiMatched.map((s, idx) => ({
              id: `ai-${idx}-${Date.now()}`,
              title: s.title,
              artist: s.artist,
              albumArt: `https://picsum.photos/seed/${encodeURIComponent(
                s.title
              )}/300/300`,
            }))
          : MOCK_SONGS.filter(
              (s) =>
                s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                s.artist.toLowerCase().includes(searchQuery.toLowerCase())
            );

      setSearchResults(results);
    } finally {
      setIsSearching(false);
    }
  };

  const startVoting = () => syncUpdate({ phase: GamePhase.VOTING });

  const submitGuess = async (submissionId: string, targetPlayerId: string) => {
    if (!currentPlayerId || !db || !gameState.roomId) return;
    const roomRef = ref(db, `rooms/${gameState.roomId}`);

    await runTransaction(roomRef, (room: any) => {
      if (!room) return room;
      room.guesses = room.guesses || [];
      room.guesses = room.guesses.filter(
        (g: any) =>
          !(g.voterId === currentPlayerId && g.submissionId === submissionId)
      );
      room.guesses.push({ voterId: currentPlayerId, submissionId, targetPlayerId });
      return room;
    });
  };

  const finalizeGuesses = () => syncUpdate({ phase: GamePhase.REVEAL });

  const nextReveal = () => {
    const isLast =
      gameState.currentRevealIndex >= (gameState.submissions?.length || 0) - 1;

    if (isLast) {
      const updatedPlayers = gameState.players.map((p) => {
        const correctGuessesCount = gameState.guesses
          ? (gameState.guesses as any[]).filter((g) => {
              if (g.voterId !== p.id) return false;
              const ownerId = gameState.submissions.find(
                (s: any) => s.song.id === g.submissionId
              )?.playerId;
              return ownerId === g.targetPlayerId;
            }).length
          : 0;
        return { ...p, score: p.score + correctGuessesCount * 10 };
      });
      syncUpdate({ players: updatedPlayers, phase: GamePhase.SCOREBOARD });
    } else {
      syncUpdate({ currentRevealIndex: gameState.currentRevealIndex + 1 });
    }
  };

  const nextQuestion = () => {
    setSearchQuery("");
    setSearchResults([]);
    const isGameEnd = gameState.currentQuestionIndex >= 9;
    if (isGameEnd) {
      syncUpdate({ phase: GamePhase.FINAL });
    } else {
      syncUpdate({
        currentQuestionIndex: gameState.currentQuestionIndex + 1,
        phase: GamePhase.PROMPT,
        submissions: [],
        guesses: [],
        currentRevealIndex: 0,
        listeningIndex: 0,
      });
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert("Copied to clipboard!");
  };

  // ------------------------------------------------------------------
  // Listening index sync
  // ------------------------------------------------------------------
  const listeningIndex = gameState.listeningIndex ?? 0;

  const setListeningIndexSynced = (idx: number) => {
    if (!isHost) return;
    syncUpdate({ listeningIndex: idx });
  };

  // Auto-play when host changes listeningIndex (external device playback)
  useEffect(() => {
    if (!isHost) return;
    if (gameState.phase !== GamePhase.LISTENING) return;

    const sub = gameState.submissions?.[listeningIndex] as any;
    if (!sub?.song?.id) return;

    if (sub.song.id.startsWith("ai-")) {
      console.warn("Skipping non-Spotify track (ai-)");
      return;
    }

    // Attempt to play on an external device
    playOnSpotifyDevice(sub.song.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, gameState.phase, listeningIndex]);

  // ------------------------------------------------------------------
  // Derived variables (NO hooks below early returns!)
  // ------------------------------------------------------------------
  const hasSubmitted = gameState.submissions?.some(
    (s: any) => s.playerId === currentPlayerId
  );
  const mysterySubmissions =
    gameState.submissions?.filter((s: any) => s.playerId !== currentPlayerId) ||
    [];
  const playerGuessesForRound =
    (gameState.guesses as any[])?.filter((g) => g.voterId === currentPlayerId) ||
    [];
  const allGuessesCompleted =
    mysterySubmissions.length > 0 &&
    mysterySubmissions.every((s: any) =>
      playerGuessesForRound.some((g: any) => g.submissionId === s.song.id)
    );

  const sortedPlayers = [...gameState.players].sort((a, b) => b.score - a.score);

  // --- VIEWS ---

  if (!gameState.roomId) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-[#121212] bg-[radial-gradient(circle_at_50%_0%,#1DB9541a_0%,transparent_50%)]">
        <Card className="max-w-md w-full text-center space-y-8 animate-in fade-in zoom-in duration-300">
          <div className="flex justify-center">
            <div className="p-4 bg-[#1DB954] rounded-2xl shadow-lg shadow-[#1DB954]/20 animate-pulse">
              <Music size={48} className="text-black" />
            </div>
          </div>

          <div>
            <h1 className="text-4xl font-black tracking-tight mb-2 uppercase italic">
              Tune Trivia
            </h1>
            <p className="text-gray-400 font-medium">
              The social music guessing game.
            </p>
          </div>

          <div className="space-y-3">
            {!spotifyConnected ? (
              <Button
                onClick={connectSpotify}
                className="w-full py-4 text-lg uppercase tracking-widest"
              >
                Connect Spotify
              </Button>
            ) : (
              <div className="p-3 rounded-xl border border-[#1DB954]/30 bg-[#1DB954]/10 text-[#1DB954] font-bold text-sm">
                Spotify connected ✅
              </div>
            )}

            <Button
              onClick={createRoom}
              className="w-full py-4 text-lg uppercase tracking-widest"
              disabled={!spotifyConnected}
            >
              Host a Party
            </Button>
          </div>

          <div className="relative py-2">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-[#282828]"></span>
            </div>
            <div className="relative flex justify-center text-xs uppercase font-bold">
              <span className="bg-[#181818] px-3 text-gray-500">Or Join</span>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <input
              type="text"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="YOUR NAME"
              className="w-full bg-[#282828] border-2 border-transparent focus:border-[#1DB954] outline-none rounded-full px-6 py-3 text-center font-bold text-white placeholder:text-gray-500"
            />
            <input
              type="text"
              value={roomCodeInput}
              onChange={(e) => setRoomCodeInput(e.target.value)}
              placeholder="ROOM CODE (e.g. AB12)"
              className="w-full bg-[#282828] border-2 border-transparent focus:border-[#1DB954] outline-none rounded-full px-6 py-3 text-center font-black tracking-[0.3em] uppercase text-xl placeholder:tracking-normal placeholder:font-bold"
            />
            <Button variant="outline" onClick={joinRoom}>
              Join Room
            </Button>
          </div>

          {!db && (
            <div className="p-4 bg-red-900/20 border border-red-500/50 rounded-xl flex items-center gap-2 text-xs text-red-400">
              <AlertCircle size={16} />
              <span>Database not connected. Add API Keys in Coolify.</span>
            </div>
          )}
        </Card>
      </div>
    );
  }

  if (gameState.phase === GamePhase.LOBBY) {
    return (
      <div className="min-h-screen bg-[#121212] text-white flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-4xl space-y-12 animate-in slide-in-from-bottom-6 duration-700">
          <div className="text-center space-y-4">
            <div className="inline-block bg-[#1DB954] text-black px-8 py-2 rounded-full font-black uppercase tracking-widest text-sm mb-4">
              Lobby
            </div>
            <h2 className="text-6xl font-black uppercase italic tracking-tighter">
              Room: {gameState.roomId}
            </h2>
            <p className="text-gray-400">Share this code with your friends!</p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
            {gameState.players.map((p) => (
              <div
                key={p.id}
                className="bg-[#181818] p-6 rounded-3xl border border-[#282828] flex flex-col items-center gap-4 animate-in zoom-in"
              >
                <img
                  src={p.avatar}
                  className="w-20 h-20 rounded-full border-4 border-[#282828]"
                />
                <span className="font-bold text-xl">{p.name}</span>
                {p.isHost && (
                  <span className="text-[10px] bg-[#1DB954] text-black px-2 py-1 rounded font-black uppercase">
                    HOST
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-center pt-8">
            {isHost ? (
              <Button
                onClick={startGame}
                className="py-6 px-12 text-2xl uppercase tracking-widest"
              >
                Start the Party
              </Button>
            ) : (
              <div className="flex items-center gap-3 text-[#1DB954] animate-pulse">
                <RefreshCw className="animate-spin" />
                <span className="font-bold uppercase tracking-widest">
                  Waiting for host to start...
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // --- Main game shell ---
  return (
    <div className="min-h-screen bg-[#121212] text-white flex flex-col selection:bg-[#1DB954] selection:text-black">
      <header className="sticky top-0 z-50 bg-[#000000]/90 backdrop-blur-xl border-b border-[#282828] px-4 sm:px-6 py-4 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="bg-[#1DB954] p-1.5 rounded-full shadow-lg shadow-[#1DB954]/20">
            <Music size={18} className="text-black" />
          </div>
          <span className="font-black text-xl italic hidden sm:block">
            Tune Trivia
          </span>
          {hostToken && (
            <span className="text-[10px] bg-[#1DB954]/20 text-[#1DB954] px-2 py-1 rounded font-bold uppercase">
              Spotify Linked
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 sm:gap-4">
          <div className="px-3 sm:px-4 py-1.5 sm:py-2 bg-[#1DB954]/10 text-[#1DB954] rounded-full text-xs sm:text-sm font-black border border-[#1DB954]/20 flex items-center gap-2">
            <Users size={14} />
            {gameState.players.length}
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className="p-1.5 text-gray-400 hover:text-white transition-colors"
          >
            <Settings size={22} />
          </button>
        </div>
      </header>

      {showSettings && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/90 backdrop-blur-xl animate-in fade-in">
          <Card className="max-w-2xl w-full relative space-y-6 overflow-hidden border-[#1DB954]/40">
            <button
              onClick={() => setShowSettings(false)}
              className="absolute top-4 right-4 p-2 text-gray-400 hover:text-white transition-colors"
            >
              <X size={24} />
            </button>

            <div className="flex items-center gap-3 text-[#1DB954]">
              <Settings size={28} />
              <h2 className="text-2xl font-black uppercase tracking-tight italic">
                Dev Dashboard
              </h2>
            </div>

            <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-2 custom-scrollbar">
              <div className="p-6 bg-black rounded-3xl border border-[#282828] space-y-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-gray-300">
                    <Music size={18} className="text-[#1DB954]" />
                    <span className="text-sm font-black uppercase tracking-widest">
                      Spotify (External Device Playback)
                    </span>
                  </div>

                  <button
                    onClick={() => {
                      setSpotifyToken(null);
                      setSpotifyRefreshToken(null);
                      setSpotifyExpiresAt(0);
                      setSpotifyConnected(false);

                      localStorage.removeItem("spotify_access_token");
                      localStorage.removeItem("spotify_refresh_token");
                      localStorage.removeItem("spotify_expires_at");
                    }}
                    className="text-xs text-red-500 underline uppercase font-bold"
                  >
                    Unlink Account
                  </button>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">
                    Redirect URI
                  </label>
                  <div className="flex gap-2">
                    <code className="flex-1 bg-[#121212] px-4 py-3 rounded-xl text-[#1DB954] text-xs font-mono truncate border border-white/5">
                      {suggestedRedirectUri}
                    </code>
                    <button
                      onClick={() => copyToClipboard(suggestedRedirectUri)}
                      className="p-3 bg-[#282828] rounded-xl hover:bg-[#3e3e3e] transition-colors"
                    >
                      <Copy size={18} />
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">
                    Client ID
                  </label>
                  <input
                    type="text"
                    value={spotifyClientId}
                    onChange={(e) => setSpotifyClientId(e.target.value)}
                    placeholder="Enter ID"
                    className="w-full bg-[#121212] border border-[#282828] focus:border-[#1DB954] outline-none rounded-xl px-4 py-3 text-sm font-mono text-[#1DB954]"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">
                    Manual Redirect URI Override (optional)
                  </label>
                  <input
                    type="text"
                    value={manualRedirectUri}
                    onChange={(e) => setManualRedirectUri(e.target.value)}
                    placeholder="e.g. https://tune-trivia.46.224.36.5.nip.io/"
                    className="w-full bg-[#121212] border border-[#282828] focus:border-[#1DB954] outline-none rounded-xl px-4 py-3 text-sm font-mono text-[#1DB954]"
                  />
                </div>

                {isHost && (
                  <div className="space-y-3 pt-2">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">
                        Playback Device (host)
                      </label>
                      <button
                        onClick={async () => {
                          const devices = await fetchDevices();
                          if (!devices.length) {
                            alert(
                              "No devices found. Open Spotify on your iPad/phone/laptop and play a song once."
                            );
                          }
                        }}
                        className="text-xs text-[#1DB954] underline uppercase font-bold"
                      >
                        Refresh devices
                      </button>
                    </div>

                    <select
                      value={preferredDeviceId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setPreferredDeviceId(id);
                        localStorage.setItem("spotify_preferred_device_id", id);
                      }}
                      className="w-full bg-[#121212] border border-[#282828] focus:border-[#1DB954] outline-none rounded-xl px-4 py-3 text-sm text-white"
                    >
                      <option value="">Auto (recommended)</option>
                      {detectedDevices
                        .filter((d) => !d.is_restricted)
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name} {d.is_active ? "(active)" : ""}
                          </option>
                        ))}
                    </select>

                    <p className="text-xs text-gray-500">
                      Tip: keep Spotify playing on your iPad/laptop speaker. If it
                      connects to “Tune Trivia”, open Spotify Devices and select your
                      real speaker device again.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <Button
                  onClick={connectSpotify}
                  className="flex-1 py-4 flex items-center justify-center gap-2"
                >
                  <Music size={18} />
                  Sync Spotify
                </Button>
                <Button
                  onClick={() => setShowSettings(false)}
                  variant="secondary"
                  className="flex-1"
                >
                  Close
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      <main className="flex-1 overflow-y-auto p-4 sm:p-8 md:p-12 flex flex-col items-center">
        <div className="w-full max-w-5xl">
          {/* PROMPT */}
          {gameState.phase === GamePhase.PROMPT && (
            <div className="text-center space-y-8 sm:space-y-12 animate-in zoom-in-95 duration-500 py-10 sm:py-16">
              <div className="space-y-4 sm:space-y-6 max-w-4xl mx-auto">
                <p className="text-[#1DB954] font-black tracking-[0.6em] text-xs sm:text-sm uppercase">
                  Round {gameState.currentQuestionIndex + 1}
                </p>
                <h2 className="text-4xl sm:text-6xl md:text-8xl font-black leading-tight tracking-tighter italic text-white drop-shadow-[0_10px_40px_rgba(29,185,84,0.3)] px-4">
                  "{gameState.questions[gameState.currentQuestionIndex]}"
                </h2>
              </div>
              {isHost ? (
                <Button
                  onClick={handleNextPrompt}
                  className="py-5 sm:py-6 px-16 sm:px-24 text-2xl sm:text-3xl font-black rounded-full hover:scale-110 uppercase italic tracking-tighter"
                >
                  Open Submissions
                </Button>
              ) : (
                <p className="animate-pulse text-gray-500 font-bold uppercase tracking-widest">
                  Waiting for host...
                </p>
              )}
            </div>
          )}

          {/* SUBMITTING */}
          {gameState.phase === GamePhase.SUBMITTING && (
            <div className="space-y-8 sm:space-y-10 animate-in fade-in duration-300">
              <div className="text-center bg-[#181818] p-6 sm:p-12 rounded-[2.5rem] border border-[#1DB954]/10">
                <p className="text-[#1DB954] font-black text-[10px] uppercase tracking-[0.5em] mb-2 sm:mb-4">
                  Current Prompt
                </p>
                <h3 className="text-2xl sm:text-4xl md:text-5xl font-black tracking-tighter leading-tight italic px-4">
                  "{gameState.questions[gameState.currentQuestionIndex]}"
                </h3>
              </div>

              {hasSubmitted ? (
                <div className="flex flex-col items-center justify-center py-20 space-y-6">
                  <Check size={80} className="text-[#1DB954] mx-auto animate-bounce" />
                  <h2 className="text-3xl font-black italic">TUNE LOCKED</h2>
                  <p className="text-gray-500 font-bold uppercase tracking-widest">
                    Waiting for other players...
                  </p>
                </div>
              ) : (
                <>
                  <div className="relative group max-w-4xl mx-auto w-full">
                    <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-0 bg-[#242424] border-2 border-transparent focus-within:border-[#1DB954] rounded-[2rem] sm:rounded-full p-2 transition-all shadow-2xl">
                      <div className="flex items-center flex-1 px-4 sm:px-6 w-full">
                        <Search
                          className="text-gray-500 group-focus-within:text-[#1DB954] transition-colors shrink-0"
                          size={24}
                        />
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                          placeholder="Songs or artists..."
                          className="w-full bg-transparent outline-none px-4 py-3 sm:py-5 text-lg sm:text-2xl font-bold placeholder:text-gray-700 text-white"
                        />
                      </div>
                      <button
                        onClick={handleSearch}
                        className="w-full sm:w-auto bg-[#1DB954] text-black font-black px-8 sm:px-12 py-4 rounded-2xl sm:rounded-full hover:scale-105 active:scale-95 transition-all shadow-lg text-lg uppercase whitespace-nowrap"
                      >
                        Search
                      </button>
                    </div>
                  </div>

                  {searchError && (
                    <div className="text-center p-4 bg-red-900/20 text-red-400 rounded-xl border border-red-500/50">
                      {searchError}
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 sm:gap-8 max-h-[50vh] overflow-y-auto pr-2 custom-scrollbar">
                    {isSearching ? (
                      <div className="col-span-full flex flex-col items-center justify-center py-24 gap-6 text-gray-500">
                        <RefreshCw className="animate-spin text-[#1DB954]" size={64} />
                        <p className="font-black text-xl animate-pulse tracking-widest uppercase italic">
                          Digging Crates...
                        </p>
                      </div>
                    ) : searchResults.length > 0 ? (
                      searchResults.map((song) => (
                        <div
                          key={song.id}
                          onClick={() => submitSong(song)}
                          className="bg-[#181818] p-5 sm:p-6 rounded-[2.5rem] flex items-center gap-6 hover:bg-[#282828] cursor-pointer group transition-all border border-transparent hover:border-[#1DB954]/40"
                        >
                          <img
                            src={song.albumArt}
                            className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl shadow-2xl group-hover:scale-105 transition-transform"
                          />
                          <div className="flex-1 overflow-hidden">
                            <h4 className="font-black text-xl sm:text-2xl truncate group-hover:text-[#1DB954] transition-colors tracking-tight leading-none mb-1">
                              {song.title}
                            </h4>
                            <p className="text-sm sm:text-lg text-gray-500 font-bold truncate italic">
                              {song.artist}
                            </p>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="col-span-full text-center py-24 text-gray-800 bg-[#181818]/30 rounded-[4rem] border-2 border-dashed border-[#282828]">
                        <Music size={100} className="mx-auto mb-8 opacity-5" />
                        <p className="text-3xl font-black uppercase tracking-tighter opacity-20 italic px-4">
                          Find the perfect sound
                        </p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* LISTENING */}
          {gameState.phase === GamePhase.LISTENING && (
            <div className="space-y-12 animate-in slide-in-from-right duration-700 py-10">
              <div className="text-center space-y-6">
                <div className="inline-flex items-center gap-4 bg-[#1DB954]/10 px-8 py-3 rounded-full border border-[#1DB954]/20">
                  <Headphones size={20} className="text-[#1DB954]" />
                  <span className="font-black uppercase tracking-[0.5em] text-xs">
                    The Listening Lounge
                  </span>
                </div>
                <h2 className="text-5xl sm:text-7xl font-black tracking-tighter uppercase italic leading-none">
                  Party Mix
                </h2>

                {isHost && (
                  <p className="text-xs text-gray-500 max-w-2xl mx-auto">
                    Host plays music on your selected Spotify device (iPad/desktop/speaker).
                    If Spotify ever switches to “Tune Trivia”, open Spotify → Devices and
                    pick your real speaker device again.
                  </p>
                )}
              </div>

              <div className="relative max-w-4xl mx-auto">
                <div className="bg-[#181818] border border-[#282828] rounded-[4rem] p-10 sm:p-16 flex flex-col md:flex-row items-center gap-12 shadow-[0_40px_100px_rgba(0,0,0,0.8)] relative overflow-hidden group">
                  <div className="absolute inset-0 bg-gradient-to-br from-[#1DB954]/5 to-transparent opacity-50"></div>

                  <div className="relative shrink-0">
                    <div className="w-48 h-48 sm:w-64 sm:h-64 rounded-full bg-black border-[10px] border-[#181818] shadow-2xl relative flex items-center justify-center animate-[spin_6s_linear_infinite]">
                      <div className="absolute inset-4 rounded-full border-2 border-white/5"></div>
                      <div className="absolute inset-10 rounded-full border-2 border-white/5"></div>
                      {gameState.submissions[listeningIndex] && (
                        <img
                          src={gameState.submissions[listeningIndex].song.albumArt}
                          className="w-20 h-20 sm:w-32 sm:h-32 rounded-full border-4 border-black"
                        />
                      )}
                    </div>
                  </div>

                  <div className="flex-1 text-center md:text-left space-y-4 relative z-10">
                    {gameState.submissions[listeningIndex] && (
                      <>
                        <p className="text-[#1DB954] font-black uppercase tracking-[0.4em] text-xs italic">
                          Track {listeningIndex + 1} of {gameState.submissions.length}
                        </p>
                        <h3 className="text-4xl sm:text-6xl font-black tracking-tighter leading-tight italic">
                          {gameState.submissions[listeningIndex].song.title}
                        </h3>
                        <p className="text-2xl sm:text-3xl text-gray-500 font-bold italic">
                          {gameState.submissions[listeningIndex].song.artist}
                        </p>

                        {isHost && !gameState.submissions[listeningIndex].song.id.startsWith("ai-") && (
                          <div className="pt-4">
                            <Button
                              onClick={() =>
                                playOnSpotifyDevice(gameState.submissions[listeningIndex].song.id)
                              }
                              className="py-4 px-10 text-lg uppercase tracking-widest"
                            >
                              Play on Spotify
                            </Button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {isHost ? (
                  <div className="flex justify-between items-center mt-12 gap-8 px-4">
                    <button
                      onClick={() => setListeningIndexSynced(Math.max(0, listeningIndex - 1))}
                      disabled={listeningIndex === 0}
                      className="p-6 bg-[#282828] hover:bg-[#3e3e3e] rounded-full text-white disabled:opacity-20 transition-all"
                    >
                      <ChevronRight size={32} className="rotate-180" />
                    </button>

                    {listeningIndex < gameState.submissions.length - 1 ? (
                      <Button
                        onClick={() => setListeningIndexSynced(listeningIndex + 1)}
                        className="flex-1 py-6 text-2xl"
                      >
                        Next Track
                      </Button>
                    ) : (
                      <Button
                        onClick={startVoting}
                        className="flex-1 py-6 text-2xl uppercase italic tracking-tighter animate-pulse"
                      >
                        Start Matching
                      </Button>
                    )}

                    <button
                      onClick={() =>
                        setListeningIndexSynced(
                          Math.min(gameState.submissions.length - 1, listeningIndex + 1)
                        )
                      }
                      disabled={listeningIndex === gameState.submissions.length - 1}
                      className="p-6 bg-[#282828] hover:bg-[#3e3e3e] rounded-full text-white disabled:opacity-20 transition-all"
                    >
                      <ChevronRight size={32} />
                    </button>
                  </div>
                ) : (
                  <div className="text-center mt-8 text-gray-500 font-bold uppercase tracking-widest animate-pulse">
                    Host is controlling playback...
                  </div>
                )}
              </div>
            </div>
          )}

          {/* VOTING / REVEAL / SCOREBOARD / FINAL */}
          {/* Keep your existing blocks here if you want – your earlier UI works.
              For brevity, I’m leaving them out since your issue is playback.
              If you want, I can paste your exact remaining UI blocks into this file too. */}
          {gameState.phase === GamePhase.VOTING && (
            <div className="text-center text-gray-500 font-bold uppercase tracking-widest py-20">
              Voting screen unchanged (use your existing block).
            </div>
          )}

          {gameState.phase === GamePhase.REVEAL && (
            <div className="text-center text-gray-500 font-bold uppercase tracking-widest py-20">
              Reveal screen unchanged (use your existing block).
            </div>
          )}

          {gameState.phase === GamePhase.SCOREBOARD && (
            <div className="text-center text-gray-500 font-bold uppercase tracking-widest py-20">
              Scoreboard screen unchanged (use your existing block).
              <div className="mt-6 text-white">
                Current leader: {sortedPlayers[0]?.name} ({sortedPlayers[0]?.score})
              </div>
              {isHost && (
                <div className="mt-8">
                  <Button onClick={nextQuestion}>Next Round</Button>
                </div>
              )}
            </div>
          )}

          {gameState.phase === GamePhase.FINAL && (
            <div className="text-center text-gray-500 font-bold uppercase tracking-widest py-20">
              Final screen unchanged (use your existing block).
              <div className="mt-6 text-white">
                Winner: {sortedPlayers[0]?.name} ({sortedPlayers[0]?.score})
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
