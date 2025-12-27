import React, { useEffect, useMemo, useRef, useState } from "react";
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

// --- UI Components ---
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

// --- Spotify PKCE helpers ---
const SPOTIFY_AUTH_ENDPOINT = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";

const base64UrlEncode = (arrayBuffer: ArrayBuffer) => {
  const bytes = new Uint8Array(arrayBuffer);
  let str = "";
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const sha256 = async (plain: string) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return await crypto.subtle.digest("SHA-256", data);
};

const randomString = (length = 64) => {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values)
    .map((v) => possible[v % possible.length])
    .join("");
};

type SpotifyDevice = {
  id: string;
  is_active: boolean;
  is_restricted: boolean;
  name: string;
  type: string;
};

type Submission = { playerId: string; song: Song; roundId: number };
type Guess = { voterId: string; submissionId: string; targetPlayerId: string; roundId: number };

export default function App() {
  // --- Local UI State ---
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(() =>
    sessionStorage.getItem("tune_player_id")
  );
  const [playerName, setPlayerName] = useState(
    () => sessionStorage.getItem("tune_player_name") || ""
  );

  // --- Game State ---
  const [gameState, setGameState] = useState<GameState & { roundId?: number }>({
    roomId: "",
    phase: GamePhase.LOBBY,
    currentQuestionIndex: 0,
    questions: INITIAL_QUESTIONS,
    players: [],
    submissions: [],
    guesses: [],
    currentRevealIndex: 0,
    roundId: 0,
  });

  const roundId = gameState.roundId ?? 0;

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Song[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isAnnouncing, setIsAnnouncing] = useState(false);

  // Listening UI
  const [listeningIndex, setListeningIndex] = useState(0);

  // Settings
  const [showSettings, setShowSettings] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Spotify config + tokens
  const [spotifyClientId, setSpotifyClientId] = useState(() =>
    import.meta.env.VITE_SPOTIFY_CLIENT_ID ||
    localStorage.getItem("spotify_client_id") ||
    ""
  );
  const [manualRedirectUri, setManualRedirectUri] = useState(
    () => localStorage.getItem("spotify_redirect_uri_override") || ""
  );

  const [spotifyToken, setSpotifyToken] = useState<string | null>(() =>
    localStorage.getItem("spotify_access_token")
  );
  const [hostToken, setHostToken] = useState<string | null>(null);

  // Device selection
  const [detectedDevices, setDetectedDevices] = useState<SpotifyDevice[]>([]);
  const [preferredDeviceId, setPreferredDeviceId] = useState(
    () => localStorage.getItem("spotify_preferred_device_id") || ""
  );

  // Refs
  const spotifyTokenRef = useRef<string | null>(spotifyToken);
  const spotifyClientIdRef = useRef<string>(spotifyClientId);
  const lastUsedDeviceIdRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    spotifyTokenRef.current = spotifyToken;
  }, [spotifyToken]);

  useEffect(() => {
    spotifyClientIdRef.current = spotifyClientId;
    localStorage.setItem("spotify_client_id", spotifyClientId);
  }, [spotifyClientId]);

  useEffect(() => {
    localStorage.setItem("spotify_redirect_uri_override", manualRedirectUri);
  }, [manualRedirectUri]);

  // --- Redirect URI logic ---
  const suggestedRedirectUri = useMemo(() => {
    if (typeof window === "undefined") return manualRedirectUri || "";
    if (manualRedirectUri) return manualRedirectUri;

    const currentOrigin = window.location.origin;
    const hostname = window.location.hostname;
    const isBareIP = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);

    return isBareIP
      ? `${window.location.protocol}//${hostname}.nip.io/`
      : `${currentOrigin}/`;
  }, [manualRedirectUri]);

  // --- Helpers ---
  const shuffle = <T,>(arr: T[]) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // ✅ round-scoped submission key
  const submissionKey = (songId: string, rid = roundId) => `${rid}:${songId}`;

  // --- Firebase sync ---
  useEffect(() => {
    if (!gameState.roomId || !db) return;

    const roomRef = ref(db, `rooms/${gameState.roomId}`);
    const unsub = onValue(roomRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;

      // ✅ IMPORTANT: replace, don’t “merge arrays and keep stale ones”
      setGameState((prev) => ({
        ...prev,
        ...data,
        submissions: Array.isArray(data.submissions) ? data.submissions : [],
        guesses: Array.isArray(data.guesses) ? data.guesses : [],
        players: Array.isArray(data.players) ? data.players : [],
        questions: Array.isArray(data.questions) ? data.questions : INITIAL_QUESTIONS,
        roundId: typeof data.roundId === "number" ? data.roundId : (prev.roundId ?? 0),
      }));

      if (data.hostToken) setHostToken(data.hostToken);
    });

    return () => unsub();
  }, [gameState.roomId]);

  const myPlayer = gameState.players.find((p) => p.id === currentPlayerId);
  const isHost = myPlayer?.isHost;

  useEffect(() => {
    // local UI reset when round changes
    setSearchQuery("");
    setSearchResults([]);
    setSearchError(null);
    setListeningIndex(0);
  }, [roundId]);

  // Share host token to guests
  useEffect(() => {
    if (isHost && spotifyToken && gameState.roomId && db) {
      update(ref(db, `rooms/${gameState.roomId}`), { hostToken: spotifyToken }).catch(() => {});
    }
  }, [isHost, spotifyToken, gameState.roomId]);

  // --- Audio announcements (Gemini) ---
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
    if (!isHost) return;
    initAudio();
    setIsAnnouncing(true);

    try {
      const base64Data = await generateAnnouncementAudio(song.title, song.artist, pName);

      if (base64Data && audioContextRef.current) {
        const audioData = decodeBase64(base64Data);
        const audioBuffer = await decodeAudioData(audioData, audioContextRef.current);
        const source = audioContextRef.current.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContextRef.current.destination);
        source.onended = () => setIsAnnouncing(false);
        source.start();
      } else {
        setIsAnnouncing(false);
      }
    } catch {
      setIsAnnouncing(false);
    }
  };

  useEffect(() => {
    if (gameState.phase === GamePhase.REVEAL) {
      const currentSub = (gameState.submissions as any[])[gameState.currentRevealIndex] as Submission | undefined;
      if (!currentSub) return;

      const player = gameState.players.find((p) => p.id === currentSub.playerId);
      if (player) playAnnouncement(currentSub.song, player.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.phase, gameState.currentRevealIndex]);

  // ---------------------------
  // ✅ SPOTIFY AUTH (PKCE)
  // ---------------------------
  const connectSpotify = async () => {
    if (!spotifyClientIdRef.current) {
      setShowSettings(true);
      return;
    }

    const finalUri = suggestedRedirectUri.endsWith("/")
      ? suggestedRedirectUri
      : suggestedRedirectUri + "/";

    const verifier = randomString(64);
    const challenge = base64UrlEncode(await sha256(verifier));

    localStorage.setItem("spotify_pkce_verifier", verifier);
    localStorage.setItem("spotify_redirect_uri_used", finalUri);
    localStorage.setItem(
      "spotify_post_auth_path",
      window.location.pathname + window.location.search
    );

    const scopes = [
      "user-read-playback-state",
      "user-modify-playback-state",
      "user-read-currently-playing",
      "user-read-private",
      "user-read-email",
    ].join(" ");

    const authUrl =
      `${SPOTIFY_AUTH_ENDPOINT}?client_id=${encodeURIComponent(
        spotifyClientIdRef.current
      )}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(finalUri)}` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&code_challenge_method=S256` +
      `&code_challenge=${encodeURIComponent(challenge)}` +
      `&show_dialog=true`;

    window.location.href = authUrl;
  };

  const refreshSpotifyToken = async () => {
    const refreshToken = localStorage.getItem("spotify_refresh_token");
    if (!refreshToken) return null;

    const clientIdToUse =
      spotifyClientIdRef.current || localStorage.getItem("spotify_client_id") || "";
    if (!clientIdToUse) return null;

    const body = new URLSearchParams();
    body.set("client_id", clientIdToUse);
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refreshToken);

    const res = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Spotify refresh failed:", data);
      return null;
    }

    const accessToken = data.access_token as string;
    const expiresIn = data.expires_in as number;

    localStorage.setItem("spotify_access_token", accessToken);
    localStorage.setItem("spotify_token_expiry", String(Date.now() + expiresIn * 1000));
    setSpotifyToken(accessToken);
    return accessToken;
  };

  const ensureValidSpotifyToken = async () => {
    const token = spotifyTokenRef.current || hostToken;
    if (!token) return null;

    const isOurToken = !!spotifyTokenRef.current;
    const expiryStr = localStorage.getItem("spotify_token_expiry");
    const expiry = expiryStr ? Number(expiryStr) : 0;

    if (isOurToken && expiry && Date.now() > expiry - 60_000) {
      const refreshed = await refreshSpotifyToken();
      return refreshed || spotifyTokenRef.current;
    }
    return token;
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");

    if (error) {
      alert(`Spotify auth error: ${error}`);
      return;
    }
    if (!code) return;

    const exchange = async () => {
      const verifier = localStorage.getItem("spotify_pkce_verifier");
      const redirectUriUsed = localStorage.getItem("spotify_redirect_uri_used");
      const clientIdToUse =
        spotifyClientIdRef.current || localStorage.getItem("spotify_client_id") || "";

      if (!clientIdToUse || !verifier || !redirectUriUsed) {
        alert("Spotify auth missing verifier/client id. Click Sync again.");
        return;
      }

      const body = new URLSearchParams();
      body.set("client_id", clientIdToUse);
      body.set("grant_type", "authorization_code");
      body.set("code", code);
      body.set("redirect_uri", redirectUriUsed);
      body.set("code_verifier", verifier);

      const res = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      const data = await res.json();
      if (!res.ok) {
        console.error("Spotify token exchange failed:", data);
        alert("Spotify token exchange failed. Redirect URI must match EXACTLY.");
        return;
      }

      const accessToken = data.access_token as string;
      const refreshToken = data.refresh_token as string | undefined;
      const expiresIn = data.expires_in as number;

      localStorage.setItem("spotify_access_token", accessToken);
      if (refreshToken) localStorage.setItem("spotify_refresh_token", refreshToken);
      localStorage.setItem("spotify_token_expiry", String(Date.now() + expiresIn * 1000));
      setSpotifyToken(accessToken);

      const postAuthPath = localStorage.getItem("spotify_post_auth_path") || "/";
      window.history.replaceState(null, "", postAuthPath);
    };

    exchange();
  }, []);

  // ---------------------------
  // ✅ Spotify Web API helpers
  // ---------------------------
  const spotifyFetch = async (url: string, init?: RequestInit) => {
    const token = await ensureValidSpotifyToken();
    if (!token) throw new Error("NoSpotifyToken");
    return fetch(url, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
  };

  const fetchDevices = async () => {
    try {
      const res = await spotifyFetch("https://api.spotify.com/v1/me/player/devices");
      const data = await res.json();
      const devices: SpotifyDevice[] = data?.devices || [];
      setDetectedDevices(devices);
      return devices;
    } catch (e) {
      console.error("Fetch devices failed:", e);
      return [];
    }
  };

  const chooseDevice = async (): Promise<SpotifyDevice | null> => {
    const devices = await fetchDevices();
    const usable = devices.filter((d) => !d.is_restricted);
    if (!usable.length) return null;

    if (preferredDeviceId) {
      const preferred = usable.find((d) => d.id === preferredDeviceId);
      if (preferred) return preferred;
    }

    const activeNonTune = usable.find((d) => d.is_active && !/tune trivia/i.test(d.name));
    if (activeNonTune) return activeNonTune;

    const firstNonTune = usable.find((d) => !/tune trivia/i.test(d.name));
    return firstNonTune || usable[0];
  };

  const transferPlayback = async (deviceId: string, play = false) => {
    const res = await spotifyFetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_ids: [deviceId], play }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("transferPlayback failed:", res.status, txt);
    }
  };

  const playOnDevice = async (spotifyTrackId: string) => {
    const device = await chooseDevice();
    if (!device) {
      alert("No Spotify device found. Open Spotify and play any song once, then try again.");
      return;
    }
    if (/tune trivia/i.test(device.name)) {
      alert("Spotify is connected to Tune Trivia. In Spotify → Devices, select your iPad/laptop device, then try again.");
      return;
    }
    if (!device.is_active) await transferPlayback(device.id, false);

    lastUsedDeviceIdRef.current = device.id;

    const res = await spotifyFetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(device.id)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uris: [`spotify:track:${spotifyTrackId}`] }),
      }
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn("play failed:", res.status, txt);
      if (res.status === 401) alert("Spotify expired. Re-sync in settings.");
      if (res.status === 404) alert("No active device. Start a song in Spotify once, then retry.");
    }
  };

  const pausePlayback = async () => {
    try {
      const deviceId = lastUsedDeviceIdRef.current || undefined;
      const url = deviceId
        ? `https://api.spotify.com/v1/me/player/pause?device_id=${encodeURIComponent(deviceId)}`
        : "https://api.spotify.com/v1/me/player/pause";

      const res = await spotifyFetch(url, { method: "PUT" });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.warn("pause failed:", res.status, txt);
      }
    } catch (e) {
      console.warn("pausePlayback error:", e);
    }
  };

  // auto play in listening (host only)
  useEffect(() => {
    if (!isHost) return;
    if (gameState.phase !== GamePhase.LISTENING) return;

    const subs = (gameState.submissions as any[]).filter((s: any) => (s.roundId ?? 0) === roundId) as Submission[];
    const sub = subs[listeningIndex];
    if (!sub) return;
    if (sub.song.id.startsWith("ai-")) return;

    playOnDevice(sub.song.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, gameState.phase, listeningIndex, roundId]);

  // ---------------------------
  // ✅ GAME ACTIONS (transaction-safe)
  // ---------------------------
  const roomRef = useMemo(() => {
    if (!db || !gameState.roomId) return null;
    return ref(db, `rooms/${gameState.roomId}`);
  }, [db, gameState.roomId]);

  const hardResetRoundState = async (targetPhase: GamePhase, rid: number) => {
    if (!roomRef) return;
    // ✅ Always write arrays explicitly
    await update(roomRef, {
      phase: targetPhase,
      submissions: [],
      guesses: [],
      currentRevealIndex: 0,
      roundId: rid,
    });
  };

  const createRoom = async () => {
    if (!db) {
      alert("Firebase not connected! Please check your environment variables.");
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

    const initialGame: GameState & { roundId: number; hostToken?: string } = {
      roomId: newRoomId,
      phase: GamePhase.LOBBY,
      currentQuestionIndex: 0,
      questions: INITIAL_QUESTIONS,
      players: [host],
      submissions: [],
      guesses: [],
      currentRevealIndex: 0,
      roundId: 0,
      hostToken: spotifyToken || "",
    };

    await set(ref(db, `rooms/${newRoomId}`), initialGame);
    setCurrentPlayerId(hostId);
    sessionStorage.setItem("tune_player_id", hostId);
    setGameState(initialGame);
  };

  const joinRoom = async () => {
    if (!db) return;
    if (!roomCodeInput) return alert("Please enter a room code");
    if (!playerName) return alert("Please enter your name");

    const code = roomCodeInput.toUpperCase().trim();
    const rRef = ref(db, `rooms/${code}`);
    const snapshot = await get(rRef);

    if (!snapshot.exists()) return alert("Room not found!");

    const game = snapshot.val();
    const newPlayerId = currentPlayerId || `p_${Date.now()}`;

    const newPlayer: Player = {
      id: newPlayerId,
      name: playerName,
      score: 0,
      isHost: false,
      avatar: `https://picsum.photos/seed/${newPlayerId}/100/100`,
    };

    await runTransaction(rRef, (room: any) => {
      if (!room) return room;
      room.players = room.players || [];
      if (!room.players.some((p: any) => p.id === newPlayerId)) room.players.push(newPlayer);
      return room;
    });

    sessionStorage.setItem("tune_player_id", newPlayerId);
    sessionStorage.setItem("tune_player_name", playerName);
    setCurrentPlayerId(newPlayerId);
    setGameState(game);
  };

  const startGame = async () => {
    if (!isHost || !roomRef) return;

    const nonHostCount = gameState.players.filter((p) => !p.isHost).length;
    if (nonHostCount < 2) {
      alert("Need at least 2 players (excluding host) to start!");
      return;
    }

    let questions = INITIAL_QUESTIONS;
    try {
      const generated = await generateTriviaQuestions(10);
      if (generated.length > 0) questions = generated;
    } catch {}

    let shuffled = shuffle(questions);
    const lastFirst = localStorage.getItem("last_first_question") || "";
    if (shuffled.length > 1 && shuffled[0] === lastFirst) {
      [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
    }
    localStorage.setItem("last_first_question", shuffled[0] || "");

    // ✅ atomic: set questions + reset round state
    await update(roomRef, {
      questions: shuffled,
      currentQuestionIndex: 0,
      roundId: 0,
    });
    await hardResetRoundState(GamePhase.PROMPT, 0);
    setListeningIndex(0);
  };

  const openSubmissions = async () => {
    if (!isHost) return;
    setSearchQuery("");
    setSearchResults([]);
    setSearchError(null);
    setListeningIndex(0);
    await hardResetRoundState(GamePhase.SUBMITTING, roundId);
  };

  // ✅ submitSong transaction-safe and round-safe (host cannot submit)
  const submitSong = async (song: Song) => {
    if (!roomRef || !currentPlayerId) return;
    if (isHost) return;

    setSearchQuery("");
    setSearchResults([]);
    setSearchError(null);

    await runTransaction(roomRef, (room: any) => {
      if (!room) return room;

      const rid = typeof room.roundId === "number" ? room.roundId : 0;
      room.submissions = Array.isArray(room.submissions) ? room.submissions : [];
      room.players = Array.isArray(room.players) ? room.players : [];

      // only submissions for this round count
      const subsThisRound = room.submissions.filter((s: any) => (s.roundId ?? 0) === rid);

      // prevent double-submit
      if (subsThisRound.some((s: any) => s.playerId === currentPlayerId)) return room;

      const newSub = { playerId: currentPlayerId, song, roundId: rid };
      room.submissions = [...subsThisRound, newSub];

      const playingPlayers = room.players.filter((p: any) => !p.isHost);
      if (room.submissions.length >= playingPlayers.length) {
        room.phase = GamePhase.LISTENING;
        room.currentRevealIndex = 0;
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
          `https://api.spotify.com/v1/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=10`,
          { headers: { Authorization: `Bearer ${tokenToUse}` } }
        );

        if (response.status === 401) {
          setSearchError("Spotify token expired. Reconnect in Settings.");
          setIsSearching(false);
          return;
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

    const aiMatched = await searchMusicAI(searchQuery);
    const results: Song[] =
      aiMatched.length > 0
        ? aiMatched.map((s, idx) => ({
            id: `ai-${idx}-${Date.now()}`,
            title: s.title,
            artist: s.artist,
            albumArt: `https://picsum.photos/seed/${encodeURIComponent(s.title)}/300/300`,
          }))
        : MOCK_SONGS.filter(
            (s) =>
              s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
              s.artist.toLowerCase().includes(searchQuery.toLowerCase())
          );

    setSearchResults(results);
    setIsSearching(false);
  };

  const startVoting = async () => {
    if (!isHost) return;
    await pausePlayback();
    if (!roomRef) return;
    await update(roomRef, { phase: GamePhase.VOTING });
  };

  // ✅ guess transaction-safe (prevents overwriting someone else's guess)
  const submitGuess = async (songId: string, targetPlayerId: string) => {
    if (!roomRef || !currentPlayerId) return;
    if (isHost) return;

    const key = submissionKey(songId, roundId);

    await runTransaction(roomRef, (room: any) => {
      if (!room) return room;

      const rid = typeof room.roundId === "number" ? room.roundId : 0;
      room.guesses = Array.isArray(room.guesses) ? room.guesses : [];
      const guessesThisRound = room.guesses.filter((g: any) => (g.roundId ?? 0) === rid);

      // upsert per voter + submissionId
      const filtered = guessesThisRound.filter(
        (g: any) => !(g.voterId === currentPlayerId && g.submissionId === key)
      );

      const newGuess = { voterId: currentPlayerId, submissionId: key, targetPlayerId, roundId: rid };
      room.guesses = [...filtered, newGuess];
      return room;
    });
  };

  const finalizeGuesses = async () => {
    if (!isHost || !roomRef) return;
    await pausePlayback();
    await update(roomRef, { phase: GamePhase.REVEAL, currentRevealIndex: 0 });
  };

  // ✅ scoring uses round-scoped keys and reads from round-scoped submissions
  const nextReveal = async () => {
    if (!isHost || !roomRef) return;

    const subsAll = (gameState.submissions as any[]) as Submission[];
    const subs = subsAll.filter((s) => (s.roundId ?? 0) === roundId);

    const isLast = gameState.currentRevealIndex >= subs.length - 1;

    if (!isLast) {
      await update(roomRef, { currentRevealIndex: gameState.currentRevealIndex + 1 });
      return;
    }

    // End of reveal: calculate scores
    const guessesAll = (gameState.guesses as any[]) as Guess[];
    const guesses = guessesAll.filter((g) => (g.roundId ?? 0) === roundId);

    const ownerByKey = new Map<string, string>();
    subs.forEach((s) => ownerByKey.set(submissionKey(s.song.id, roundId), s.playerId));

    const updatedPlayers = gameState.players.map((p) => {
      if (p.isHost) return p;

      const myGuesses = guesses.filter((g) => g.voterId === p.id);
      let correct = 0;
      for (const g of myGuesses) {
        const actualOwner = ownerByKey.get(g.submissionId);
        if (actualOwner && actualOwner === g.targetPlayerId) correct += 1;
      }

      return { ...p, score: p.score + correct * 10 };
    });

    await update(roomRef, { players: updatedPlayers, phase: GamePhase.SCOREBOARD });
  };

  const nextQuestion = async () => {
    if (!isHost || !roomRef) return;

    setSearchQuery("");
    setSearchResults([]);
    setListeningIndex(0);
    await pausePlayback();

    const isGameEnd = gameState.currentQuestionIndex >= 9;
    if (isGameEnd) {
      await update(roomRef, { phase: GamePhase.FINAL });
      return;
    }

    const newRoundId = roundId + 1;

    await update(roomRef, {
      currentQuestionIndex: gameState.currentQuestionIndex + 1,
      roundId: newRoundId,
    });

    // ✅ this is the key: hard reset arrays for the new round
    await hardResetRoundState(GamePhase.PROMPT, newRoundId);
  };

  const forceStartListening = async () => {
    if (!isHost || !roomRef) return;
    await update(roomRef, { phase: GamePhase.LISTENING, currentRevealIndex: 0 });
    setListeningIndex(0);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert("Copied to clipboard!");
  };

  // ---------------------------
  // Derived round-scoped views
  // ---------------------------
  const submissionsAll = (gameState.submissions as any[]) as Submission[];
  const submissions = submissionsAll.filter((s) => (s.roundId ?? 0) === roundId);

  const guessesAll = (gameState.guesses as any[]) as Guess[];
  const guesses = guessesAll.filter((g) => (g.roundId ?? 0) === roundId);

  const hasSubmitted = !!currentPlayerId && submissions.some((s) => s.playerId === currentPlayerId);

  const nonHostPlayers = gameState.players.filter((p) => !p.isHost);
  const submittedIds = new Set(submissions.map((s) => s.playerId));
  const remainingPlayers = nonHostPlayers.filter((p) => !submittedIds.has(p.id));

  const mysterySubmissions = submissions.filter((s) => s.playerId !== currentPlayerId);
  const myGuesses = guesses.filter((g) => g.voterId === currentPlayerId);
  const allGuessesCompleted =
    mysterySubmissions.length > 0 &&
    mysterySubmissions.every((s) =>
      myGuesses.some((g) => g.submissionId === submissionKey(s.song.id, roundId))
    );

  // ---------------------------
  // Render start / join
  // ---------------------------
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
            <p className="text-gray-400 font-medium">The social music guessing game.</p>
          </div>

          <div className="space-y-4">
            <Button onClick={createRoom} className="w-full py-4 text-lg uppercase tracking-widest">
              Host a Party
            </Button>

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

  // ---------------------------
  // Lobby
  // ---------------------------
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
                <img src={p.avatar} className="w-20 h-20 rounded-full border-4 border-[#282828]" />
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
              <Button onClick={startGame} className="py-6 px-12 text-2xl uppercase tracking-widest">
                Start the Party
              </Button>
            ) : (
              <div className="flex items-center gap-3 text-[#1DB954] animate-pulse">
                <RefreshCw className="animate-spin" />
                <span className="font-bold uppercase tracking-widest">Waiting for host to start...</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------
  // Main shell + settings
  // ---------------------------
  return (
    <div className="min-h-screen bg-[#121212] text-white flex flex-col selection:bg-[#1DB954] selection:text-black">
      <header className="sticky top-0 z-50 bg-[#000000]/90 backdrop-blur-xl border-b border-[#282828] px-4 sm:px-6 py-4 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="bg-[#1DB954] p-1.5 rounded-full shadow-lg shadow-[#1DB954]/20">
            <Music size={18} className="text-black" />
          </div>
          <span className="font-black text-xl italic hidden sm:block">Tune Trivia</span>
          {(spotifyToken || hostToken) && (
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
          <button onClick={() => setShowSettings(true)} className="p-1.5 text-gray-400 hover:text-white transition-colors">
            <Settings size={22} />
          </button>
        </div>
      </header>

      {showSettings && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/90 backdrop-blur-xl animate-in fade-in">
          <Card className="max-w-2xl w-full relative space-y-6 overflow-hidden border-[#1DB954]/40">
            <button onClick={() => setShowSettings(false)} className="absolute top-4 right-4 p-2 text-gray-400 hover:text-white transition-colors">
              <X size={24} />
            </button>

            <div className="flex items-center gap-3 text-[#1DB954]">
              <Settings size={28} />
              <h2 className="text-2xl font-black uppercase tracking-tight italic">Dev Dashboard</h2>
            </div>

            <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-2 custom-scrollbar">
              <div className="p-6 bg-black rounded-3xl border border-[#282828] space-y-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-gray-300">
                    <Music size={18} className="text-[#1DB954]" />
                    <span className="text-sm font-black uppercase tracking-widest">Spotify (PKCE)</span>
                  </div>
                  <button
                    onClick={() => {
                      setSpotifyToken(null);
                      localStorage.removeItem("spotify_access_token");
                      localStorage.removeItem("spotify_refresh_token");
                      localStorage.removeItem("spotify_token_expiry");
                      alert("Spotify unlinked.");
                    }}
                    className="text-xs text-red-500 underline uppercase font-bold"
                  >
                    Unlink
                  </button>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">
                    Redirect URI
                  </label>
                  <div className="flex gap-2">
                    <code className="flex-1 bg-[#121212] px-4 py-3 rounded-xl text-[#1DB954] text-xs font-mono truncate border border-white/5">
                      {suggestedRedirectUri.endsWith("/") ? suggestedRedirectUri : suggestedRedirectUri + "/"}
                    </code>
                    <button
                      onClick={() =>
                        copyToClipboard(
                          suggestedRedirectUri.endsWith("/") ? suggestedRedirectUri : suggestedRedirectUri + "/"
                        )
                      }
                      className="p-3 bg-[#282828] rounded-xl hover:bg-[#3e3e3e] transition-colors"
                    >
                      <Copy size={18} />
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">Client ID</label>
                  <input
                    type="text"
                    value={spotifyClientId}
                    onChange={(e) => setSpotifyClientId(e.target.value)}
                    placeholder="Enter Spotify Client ID"
                    className="w-full bg-[#121212] border border-[#282828] focus:border-[#1DB954] outline-none rounded-xl px-4 py-3 text-sm font-mono text-[#1DB954]"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500">
                    Preferred Playback Device (Host)
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={preferredDeviceId}
                      onChange={(e) => {
                        setPreferredDeviceId(e.target.value);
                        localStorage.setItem("spotify_preferred_device_id", e.target.value);
                      }}
                      className="flex-1 bg-[#121212] border border-[#282828] focus:border-[#1DB954] outline-none rounded-xl px-4 py-3 text-sm text-white"
                    >
                      <option value="">Auto</option>
                      {detectedDevices.filter((d) => !d.is_restricted).map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} {d.is_active ? "(active)" : ""}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={async () => {
                        await fetchDevices();
                      }}
                      className="px-4 py-3 bg-[#282828] rounded-xl hover:bg-[#3e3e3e] transition-colors text-sm font-bold"
                    >
                      Refresh
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <Button onClick={connectSpotify} className="flex-1 py-4 flex items-center justify-center gap-2">
                  <Music size={18} />
                  Sync Spotify
                </Button>
                <Button onClick={() => setShowSettings(false)} variant="secondary" className="flex-1">
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
                <h2 className="text-4xl sm:text-6xl md:text-8xl font-black leading-tight tracking-tighter italic text-white px-4">
                  "{gameState.questions[gameState.currentQuestionIndex]}"
                </h2>
              </div>

              {isHost ? (
                <Button
                  onClick={openSubmissions}
                  className="py-5 sm:py-6 px-16 sm:px-24 text-2xl sm:text-3xl font-black rounded-full hover:scale-110 uppercase italic tracking-tighter"
                >
                  Open Submissions
                </Button>
              ) : (
                <p className="animate-pulse text-gray-500 font-bold uppercase tracking-widest">Waiting for host...</p>
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

              {isHost ? (
                <div className="bg-[#181818] border border-[#282828] rounded-[2.5rem] p-8 sm:p-10 space-y-6 text-center">
                  <h3 className="text-3xl font-black italic">Collecting songs…</h3>
                  <p className="text-gray-500 font-bold uppercase tracking-widest">
                    Waiting for players to submit
                  </p>

                  <div className="text-sm text-gray-400">
                    {remainingPlayers.length === 0 ? (
                      <span>All players have submitted ✅</span>
                    ) : (
                      <span>
                        Still waiting on:{" "}
                        <span className="text-white font-bold">
                          {remainingPlayers.map((p) => p.name).join(", ")}
                        </span>
                      </span>
                    )}
                  </div>

                  <div className="flex justify-center pt-2">
                    <Button onClick={forceStartListening} variant="outline" className="px-10">
                      Force Start Listening
                    </Button>
                  </div>
                </div>
              ) : hasSubmitted ? (
                <div className="flex flex-col items-center justify-center py-20 space-y-6">
                  <Check size={80} className="text-[#1DB954] mx-auto animate-bounce" />
                  <h2 className="text-3xl font-black italic">TUNE LOCKED</h2>
                  <p className="text-gray-500 font-bold uppercase tracking-widest">Waiting for other players...</p>
                </div>
              ) : (
                <>
                  <div className="relative group max-w-4xl mx-auto w-full">
                    <div className="flex flex-col sm:flex-row items-center gap-3 sm:gap-0 bg-[#242424] border-2 border-transparent focus-within:border-[#1DB954] rounded-[2rem] sm:rounded-full p-2 transition-all shadow-2xl">
                      <div className="flex items-center flex-1 px-4 sm:px-6 w-full">
                        <Search className="text-gray-500 group-focus-within:text-[#1DB954] transition-colors shrink-0" size={24} />
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
                        <p className="font-black text-xl animate-pulse tracking-widest uppercase italic">Digging Crates...</p>
                      </div>
                    ) : searchResults.length > 0 ? (
                      searchResults.map((song) => (
                        <div
                          key={song.id}
                          onClick={() => submitSong(song)}
                          className="bg-[#181818] p-5 sm:p-6 rounded-[2.5rem] flex items-center gap-6 hover:bg-[#282828] cursor-pointer group transition-all border border-transparent hover:border-[#1DB954]/40"
                        >
                          <img src={song.albumArt} className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl shadow-2xl group-hover:scale-105 transition-transform" />
                          <div className="flex-1 overflow-hidden">
                            <h4 className="font-black text-xl sm:text-2xl truncate group-hover:text-[#1DB954] transition-colors tracking-tight leading-none mb-1">
                              {song.title}
                            </h4>
                            <p className="text-sm sm:text-lg text-gray-500 font-bold truncate italic">{song.artist}</p>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="col-span-full text-center py-24 text-gray-800 bg-[#181818]/30 rounded-[4rem] border-2 border-dashed border-[#282828]">
                        <Music size={100} className="mx-auto mb-8 opacity-5" />
                        <p className="text-3xl font-black uppercase tracking-tighter opacity-20 italic px-4">Find the perfect sound</p>
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
                  <span className="font-black uppercase tracking-[0.5em] text-xs">The Listening Lounge</span>
                </div>
                <h2 className="text-5xl sm:text-7xl font-black tracking-tighter uppercase italic leading-none">Party Mix</h2>
              </div>

              <div className="relative max-w-4xl mx-auto">
                <div className="bg-[#181818] border border-[#282828] rounded-[4rem] p-10 sm:p-16 flex flex-col md:flex-row items-center gap-12 shadow-[0_40px_100px_rgba(0,0,0,0.8)] relative overflow-hidden group">
                  <div className="absolute inset-0 bg-gradient-to-br from-[#1DB954]/5 to-transparent opacity-50"></div>

                  <div className="relative shrink-0">
                    <div className="w-48 h-48 sm:w-64 sm:h-64 rounded-full bg-black border-[10px] border-[#181818] shadow-2xl relative flex items-center justify-center animate-[spin_6s_linear_infinite]">
                      <div className="absolute inset-4 rounded-full border-2 border-white/5"></div>
                      <div className="absolute inset-10 rounded-full border-2 border-white/5"></div>
                      {submissions[listeningIndex] && (
                        <img
                          src={submissions[listeningIndex].song.albumArt}
                          className="w-20 h-20 sm:w-32 sm:h-32 rounded-full border-4 border-black"
                        />
                      )}
                    </div>
                  </div>

                  <div className="flex-1 text-center md:text-left space-y-4 relative z-10">
                    {submissions[listeningIndex] && (
                      <>
                        <p className="text-[#1DB954] font-black uppercase tracking-[0.4em] text-xs italic">
                          Track {listeningIndex + 1} of {submissions.length}
                        </p>
                        <h3 className="text-4xl sm:text-6xl font-black tracking-tighter leading-tight italic">
                          {submissions[listeningIndex].song.title}
                        </h3>
                        <p className="text-2xl sm:text-3xl text-gray-500 font-bold italic">{submissions[listeningIndex].song.artist}</p>

                        {isHost && !submissions[listeningIndex].song.id.startsWith("ai-") && (
                          <div className="pt-3 flex gap-3 flex-wrap">
                            <Button
                              onClick={() => playOnDevice(submissions[listeningIndex].song.id)}
                              className="px-10 py-4 text-lg uppercase tracking-widest"
                            >
                              Play on Spotify
                            </Button>
                            <Button onClick={pausePlayback} variant="outline" className="px-10 py-4 text-lg uppercase tracking-widest">
                              Pause
                            </Button>
                          </div>
                        )}

                        {isAnnouncing && (
                          <div className="text-xs text-gray-500 font-bold uppercase tracking-widest">Announcing…</div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {isHost ? (
                  <div className="flex justify-between items-center mt-12 gap-8 px-4">
                    <button
                      onClick={() => setListeningIndex((prev) => Math.max(0, prev - 1))}
                      disabled={listeningIndex === 0}
                      className="p-6 bg-[#282828] hover:bg-[#3e3e3e] rounded-full text-white disabled:opacity-20 transition-all"
                    >
                      <ChevronRight size={32} className="rotate-180" />
                    </button>

                    {listeningIndex < submissions.length - 1 ? (
                      <Button onClick={() => setListeningIndex((prev) => prev + 1)} className="flex-1 py-6 text-2xl">
                        Next Track
                      </Button>
                    ) : (
                      <Button onClick={startVoting} className="flex-1 py-6 text-2xl uppercase italic tracking-tighter animate-pulse">
                        Start Matching
                      </Button>
                    )}

                    <button
                      onClick={() => setListeningIndex((prev) => Math.min(submissions.length - 1, prev + 1))}
                      disabled={listeningIndex === submissions.length - 1}
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

          {/* VOTING */}
          {gameState.phase === GamePhase.VOTING && (
            <div className="space-y-12 animate-in fade-in duration-500 pb-20">
              <div className="text-center space-y-4">
                <h2 className="text-4xl sm:text-6xl md:text-8xl font-black tracking-tighter uppercase italic">The Mixup</h2>
                <p className="text-gray-400 font-medium text-xl sm:text-2xl">Who curated these selections?</p>
              </div>

              {isHost ? (
                <div className="text-center p-8 bg-[#181818] border border-[#282828] rounded-[2.5rem]">
                  <p className="text-gray-400 font-bold uppercase tracking-widest">Host is running the round (no voting)</p>
                  <div className="pt-6">
                    <Button onClick={finalizeGuesses} className="px-16 py-6 text-2xl font-black rounded-full uppercase italic tracking-tighter">
                      Reveal Results
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid lg:grid-cols-2 gap-8">
                    {submissions.map((sub) => {
                      if (sub.playerId === currentPlayerId) return null;

                      const key = submissionKey(sub.song.id, roundId);
                      const currentGuess = guesses.find(
                        (g) => g.voterId === currentPlayerId && g.submissionId === key
                      );

                      return (
                        <div
                          key={sub.song.id}
                          className={`bg-[#181818] border rounded-[2.5rem] overflow-hidden flex flex-col sm:flex-row shadow-2xl transition-all group ${
                            currentGuess ? "border-[#1DB954]/40 bg-[#1DB954]/5" : "border-[#282828]"
                          }`}
                        >
                          <div className="w-full sm:w-48 h-48 sm:h-auto bg-[#282828] flex-shrink-0 relative overflow-hidden">
                            <img src={sub.song.albumArt} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-1000" />
                          </div>

                          <div className="flex-1 p-6 sm:p-8 flex flex-col justify-between">
                            <div>
                              <h4 className="text-2xl sm:text-3xl font-black mb-1 leading-tight tracking-tight">{sub.song.title}</h4>
                              <p className="text-lg sm:text-xl text-gray-500 font-bold mb-6 italic">{sub.song.artist}</p>
                            </div>

                            <div className="space-y-4">
                              <p className="text-[10px] font-black uppercase tracking-[0.5em] text-[#1DB954]">Pick a Player</p>
                              <div className="flex flex-wrap gap-2">
                                {gameState.players
                                  .filter((p) => p.id !== currentPlayerId && !p.isHost)
                                  .map((p) => {
                                    const isSelected = currentGuess?.targetPlayerId === p.id;
                                    return (
                                      <button
                                        key={p.id}
                                        onClick={() => submitGuess(sub.song.id, p.id)}
                                        className={`px-4 py-2 rounded-full text-xs font-black border transition-all flex items-center gap-2 ${
                                          isSelected
                                            ? "bg-[#1DB954] border-transparent text-black"
                                            : "border-[#3e3e3e] hover:border-[#1DB954] hover:bg-[#1DB954]/10"
                                        }`}
                                      >
                                        {isSelected && <Check size={14} />}
                                        {p.name}
                                      </button>
                                    );
                                  })}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex justify-center pt-12">
                    <p className="text-gray-500 font-bold uppercase tracking-widest animate-pulse">
                      {allGuessesCompleted ? "Waiting for host to reveal..." : "Cast your votes!"}
                    </p>
                  </div>
                </>
              )}
            </div>
          )}

          {/* REVEAL */}
          {gameState.phase === GamePhase.REVEAL &&
            (() => {
              const currentSub = submissions[gameState.currentRevealIndex];
              if (!currentSub) return <div>Loading reveal...</div>;

              const owner = gameState.players.find((p) => p.id === currentSub.playerId);
              const key = submissionKey(currentSub.song.id, roundId);

              const guessesForSub = guesses.filter((g) => g.submissionId === key);
              const correctDetectives = guessesForSub.filter((g) => g.targetPlayerId === currentSub.playerId);
              const bamboozled = guessesForSub.filter((g) => g.targetPlayerId !== currentSub.playerId);

              return (
                <div className="space-y-16 py-10 animate-in fade-in duration-1000">
                  <div className="text-center space-y-10 px-4">
                    <div className="inline-flex items-center gap-4 bg-[#1DB954]/10 px-8 py-3 rounded-full border border-[#1DB954]/20">
                      <span className="font-black uppercase tracking-[0.5em] text-xs">Reveal #{gameState.currentRevealIndex + 1}</span>
                    </div>

                    <div className="flex flex-col items-center">
                      <div className="relative group mb-10">
                        <div className="absolute inset-0 bg-[#1DB954] blur-[80px] opacity-20 rounded-full animate-pulse"></div>
                        <img src={currentSub.song.albumArt} className="w-48 h-48 sm:w-64 sm:h-64 rounded-[2.5rem] shadow-2xl border-[10px] border-[#181818] relative z-10" />
                      </div>
                      <h2 className="text-4xl sm:text-7xl font-black leading-tight tracking-tighter text-white italic drop-shadow-2xl">"{currentSub.song.title}"</h2>
                      <p className="text-2xl sm:text-4xl text-gray-500 font-black italic tracking-tighter">— {currentSub.song.artist}</p>
                    </div>
                  </div>

                  <div className="grid lg:grid-cols-3 gap-8 items-start">
                    <div className="space-y-6 animate-in slide-in-from-left delay-300 duration-700">
                      <div className="flex items-center gap-3 px-6 text-[#1DB954]"><Eye size={22} /><h4 className="font-black uppercase tracking-widest text-sm">Correct Detectives (+10 pts)</h4></div>
                      <div className="grid gap-3">
                        {correctDetectives.length > 0 ? (
                          correctDetectives.map((g) => {
                            const player = gameState.players.find((p) => p.id === g.voterId);
                            return (
                              <div key={g.voterId} className="bg-[#1DB954]/10 border border-[#1DB954]/30 p-4 rounded-2xl flex items-center gap-4 animate-in zoom-in">
                                <img src={player?.avatar} className="w-10 h-10 rounded-full border-2 border-[#1DB954]" />
                                <span className="font-bold text-lg">{player?.name}</span>
                                <Check className="ml-auto text-[#1DB954]" size={20} />
                              </div>
                            );
                          })
                        ) : (
                          <div className="bg-[#181818] border border-[#282828] p-6 rounded-2xl text-center text-gray-600 font-bold italic">
                            No one spotted it!
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="bg-[#1DB954] text-black p-10 rounded-[3rem] shadow-[0_0_100px_rgba(29,185,84,0.3)] text-center space-y-6 order-first lg:order-none animate-in zoom-in duration-500">
                      <p className="font-black uppercase tracking-[0.3em] text-xs">The Choice Of</p>
                      <div className="relative inline-block">
                        <img src={owner?.avatar} className="w-40 h-40 rounded-full border-[12px] border-black/10 shadow-xl mx-auto" />
                        <div className="absolute -bottom-4 -right-4 bg-black text-white p-4 rounded-full shadow-2xl scale-125"><Disc className="animate-spin" size={24} /></div>
                      </div>
                      <h3 className="text-4xl sm:text-6xl font-black tracking-tighter uppercase italic">{owner?.name}</h3>
                    </div>

                    <div className="space-y-6 animate-in slide-in-from-right delay-300 duration-700">
                      <div className="flex items-center gap-3 px-6 text-red-500"><XCircle size={22} /><h4 className="font-black uppercase tracking-widest text-sm">Bamboozled Players</h4></div>
                      <div className="grid gap-3">
                        {bamboozled.length > 0 ? (
                          bamboozled.map((g) => {
                            const player = gameState.players.find((p) => p.id === g.voterId);
                            const mistakenIdentity = gameState.players.find((p) => p.id === g.targetPlayerId);
                            return (
                              <div key={g.voterId} className="bg-red-500/5 border border-red-500/20 p-4 rounded-2xl flex items-center gap-4 animate-in zoom-in">
                                <img src={player?.avatar} className="w-10 h-10 rounded-full border-2 border-red-500/30 opacity-50" />
                                <div className="flex flex-col">
                                  <span className="font-bold">{player?.name}</span>
                                  <span className="text-[10px] uppercase font-black text-gray-500">Guessed {mistakenIdentity?.name}</span>
                                </div>
                              </div>
                            );
                          })
                        ) : (
                          <div className="bg-[#181818] border border-[#282828] p-6 rounded-2xl text-center text-gray-600 font-bold italic">
                            Everyone knew it!
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {isHost && (
                    <div className="flex justify-center pt-10">
                      <Button
                        onClick={nextReveal}
                        className="px-32 py-8 text-3xl font-black rounded-full bg-white text-black hover:bg-gray-100 transition-all hover:scale-105 shadow-2xl uppercase italic tracking-tighter"
                      >
                        {gameState.currentRevealIndex < submissions.length - 1 ? "NEXT REVEAL" : "FINAL SCORES"}{" "}
                        <ChevronRight size={48} className="inline-block ml-4" />
                      </Button>
                    </div>
                  )}
                </div>
              );
            })()}

          {/* SCOREBOARD */}
          {gameState.phase === GamePhase.SCOREBOARD && (
            <div className="space-y-12 sm:space-y-20 py-6 sm:py-10">
              <div className="text-center space-y-4">
                <h2 className="text-6xl sm:text-8xl md:text-[9rem] font-black tracking-tighter uppercase italic drop-shadow-lg leading-none">
                  The Ranks
                </h2>
                <p className="text-gray-500 text-xl sm:text-3xl font-black uppercase tracking-[0.4em]">Who has the vision?</p>
              </div>

              <Card className="max-w-4xl mx-auto p-0 overflow-hidden rounded-[3rem] sm:rounded-[5rem] border-[#282828] bg-black/70 backdrop-blur-3xl shadow-2xl">
                <div className="divide-y divide-white/5">
                  {[...gameState.players]
                    .filter((p) => !p.isHost)
                    .sort((a, b) => b.score - a.score)
                    .map((player, idx) => (
                      <div
                        key={player.id}
                        className={`px-8 sm:px-20 py-8 sm:py-12 flex items-center justify-between transition-all hover:bg-white/10 ${
                          idx === 0 ? "bg-gradient-to-r from-[#1DB954]/20 via-transparent to-transparent" : ""
                        }`}
                      >
                        <div className="flex items-center gap-6 sm:gap-12">
                          <div className={`w-12 h-12 sm:w-20 sm:h-20 rounded-full flex items-center justify-center font-black text-xl sm:text-4xl ${idx === 0 ? "bg-[#1DB954] text-black shadow-xl" : "bg-[#282828] text-gray-500"}`}>{idx + 1}</div>
                          <img src={player.avatar} className="w-12 h-12 sm:w-24 sm:h-24 rounded-full border-4 sm:border-[8px] border-transparent" />
                          <span className="font-black text-2xl sm:text-5xl tracking-tighter uppercase italic">{player.name}</span>
                        </div>
                        <div className="text-4xl sm:text-7xl md:text-[8rem] font-black text-[#1DB954] tracking-tighter drop-shadow-lg">{player.score}</div>
                      </div>
                    ))}
                </div>
              </Card>

              {isHost && (
                <div className="flex justify-center pt-8 sm:pt-16">
                  <Button onClick={nextQuestion} className="w-full md:w-[40rem] py-6 sm:py-8 text-2xl sm:text-4xl font-black rounded-full bg-white text-black shadow-2xl uppercase italic tracking-tighter">
                    {gameState.currentQuestionIndex < 9 ? "Next Round" : "Finale"}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* FINAL */}
          {gameState.phase === GamePhase.FINAL && (
            <div className="text-center space-y-16 sm:space-y-24 py-16 sm:py-24 animate-in fade-in zoom-in duration-1000">
              <div className="space-y-8">
                <div className="flex justify-center mb-10 sm:mb-16"><Trophy size={180} className="text-[#1DB954] animate-bounce sm:size-[240px]" /></div>
                <h2 className="text-8xl sm:text-[12rem] md:text-[18rem] font-black tracking-tighter leading-none uppercase italic text-[#1DB954] drop-shadow-2xl">KING</h2>
                <p className="text-2xl sm:text-5xl text-gray-600 font-black uppercase tracking-[0.5em] italic px-4">Master Curator</p>
              </div>

              <div className="flex flex-col sm:flex-row gap-8 sm:gap-12 justify-center pt-12 sm:pt-24 px-4">
                <Button onClick={() => window.location.reload()} variant="primary" className="px-16 sm:px-32 py-8 text-3xl sm:text-5xl font-black uppercase italic">
                  New Session
                </Button>
                <Button variant="outline" onClick={() => window.location.reload()} className="px-12 text-2xl uppercase tracking-widest font-black">
                  Quit Game
                </Button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
