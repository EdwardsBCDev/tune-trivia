import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Users, Music, Check, ChevronRight, Search, Trophy, RefreshCw,
  QrCode, Volume2, Settings, ShieldCheck, X, Copy, AlertCircle, Zap,
  Disc, Headphones, Eye, XCircle, TrendingUp
} from 'lucide-react';

// --- FIREBASE IMPORTS ---
import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, onValue, update, get } from "firebase/database";

import { GamePhase, GameState, Player, Song, Guess } from './types';
import { MOCK_SONGS, INITIAL_QUESTIONS } from './constants';
import { 
  generateTriviaQuestions, 
  searchMusicAI, 
  generateAnnouncementAudio,
  decodeBase64,
  decodeAudioData
} from './services/geminiService';

// --- CONFIGURATION ---
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

// Initialize Firebase
const app = firebaseConfig.apiKey ? initializeApp(firebaseConfig) : null;
const db = app ? getDatabase(app) : null;

// --- Utility Components ---
const Button: React.FC<{
  onClick?: () => void;
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'outline' | 'spotify';
  className?: string;
  disabled?: boolean;
}> = ({ onClick, children, variant = 'primary', className = '', disabled = false }) => {
  const variants = {
    primary: 'bg-[#1DB954] hover:bg-[#1ed760] text-black font-bold',
    secondary: 'bg-[#282828] hover:bg-[#3e3e3e] text-white font-medium',
    danger: 'bg-red-600 hover:bg-red-700 text-white font-medium',
    outline: 'border border-[#535353] hover:border-white text-white font-medium',
    spotify: 'bg-[#1DB954] hover:scale-105 text-black font-bold flex items-center gap-2',
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`px-6 py-3 rounded-full transition-all duration-300 active:scale-95 disabled:opacity-50 shadow-md ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
};

const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`bg-[#121212] rounded-2xl border border-[#282828] p-6 shadow-2xl ${className}`}>
    {children}
  </div>
);

export default function App() {
  // Local UI State
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [currentPlayerId, setCurrentPlayerId] = useState<string | null>(() => sessionStorage.getItem('tune_player_id'));
  const [playerName, setPlayerName] = useState(() => sessionStorage.getItem('tune_player_name') || '');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Song[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [listeningIndex, setListeningIndex] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isAnnouncing, setIsAnnouncing] = useState(false);
  
  // Spotify State
  const [spotifyToken, setSpotifyToken] = useState<string | null>(() => localStorage.getItem('spotify_access_token'));
  const [hostToken, setHostToken] = useState<string | null>(null); 
  const [spotifyClientId, setSpotifyClientId] = useState(() => import.meta.env.VITE_SPOTIFY_CLIENT_ID || localStorage.getItem('spotify_client_id') || '7f13d1d2909644368c6ce8eddac4b789');
  const [manualRedirectUri, setManualRedirectUri] = useState(() => localStorage.getItem('spotify_redirect_uri_override') || '');

  // Game State
  const [gameState, setGameState] = useState<GameState>({
    roomId: '', 
    phase: GamePhase.LOBBY,
    currentQuestionIndex: 0,
    questions: INITIAL_QUESTIONS,
    players: [],
    submissions: [],
    guesses: [],
    currentRevealIndex: 0,
  });

  const audioContextRef = useRef<AudioContext | null>(null);

  // --- FIREBASE SYNC ---
  useEffect(() => {
    if (!gameState.roomId || !db) return;
    const roomRef = ref(db, `rooms/${gameState.roomId}`);
    const unsubscribe = onValue(roomRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        setGameState(prev => ({ 
          ...prev, 
          ...data,
          questions: data.questions || INITIAL_QUESTIONS,
          players: data.players || [],
          submissions: data.submissions || [],
          guesses: data.guesses || []
        }));
        if (data.hostToken) setHostToken(data.hostToken);
      }
    });
    return () => unsubscribe();
  }, [gameState.roomId]);

  const isHost = gameState.players.find(p => p.id === currentPlayerId)?.isHost;

  // Host shares token
  useEffect(() => {
      if (isHost && spotifyToken && gameState.roomId && db) {
          update(ref(db, `rooms/${gameState.roomId}`), { hostToken: spotifyToken });
      }
  }, [isHost, spotifyToken, gameState.roomId]);

  // --- SPOTIFY AUTH ---
  const currentOrigin = window.location.origin;
  // Force HTTPS for nip.io addresses
  let calculatedUri = currentOrigin.includes('nip.io') ? currentOrigin + '/' : currentOrigin.replace(/(\d+\.\d+\.\d+\.\d+)/, '$1.nip.io') + '/';
  if (calculatedUri.startsWith('http://')) calculatedUri = calculatedUri.replace('http://', 'https://');
  
  const suggestedRedirectUri = manualRedirectUri || calculatedUri;

  useEffect(() => {
    const hash = window.location.hash;
    if (hash && hash.includes('access_token')) {
      const token = hash.split('&')[0].split('=')[1];
      if (token) {
        setSpotifyToken(token);
        localStorage.setItem('spotify_access_token', token);
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
  }, []);

  const connectSpotify = () => {
    if (!spotifyClientId) { setShowSettings(true); return; }
    // *** REAL SPOTIFY URL ***
    const AUTH_ENDPOINT = "https://accounts.spotify.com/authorize";
    const scopes = ['user-read-private', 'user-read-email'].join(' ');
    window.location.href = `${AUTH_ENDPOINT}?client_id=${spotifyClientId}&redirect_uri=${encodeURIComponent(suggestedRedirectUri)}&scope=${encodeURIComponent(scopes)}&response_type=token&show_dialog=true`;
  };

  // --- SEARCH LOGIC (REAL ENDPOINT) ---
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchError(null);

    const activeToken = spotifyToken || hostToken;

    if (activeToken) {
        try {
            // *** REAL SEARCH URL ***
            const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=10`, {
                headers: { Authorization: `Bearer ${activeToken}` }
            });
            
            if (response.status === 401) {
                setSearchError("Host token expired. Please re-sync in Settings.");
            } else {
                const data = await response.json();
                if (data.tracks) {
                    setSearchResults(data.tracks.items.map((t: any) => ({
                        id: t.id,
                        title: t.name,
                        artist: t.artists[0].name,
                        albumArt: t.album.images[0]?.url || ''
                    })));
                    setIsSearching(false);
                    return;
                }
            }
        } catch (e) { console.error(e); }
    }
    // Fallback
    setSearchResults(MOCK_SONGS.filter(s => s.title.toLowerCase().includes(searchQuery.toLowerCase())));
    setIsSearching(false);
  };

  // --- GAME ACTIONS ---
  const syncUpdate = (updates: Partial<GameState>) => { if (db && gameState.roomId) update(ref(db, `rooms/${gameState.roomId}`), updates); };

  const createRoom = async () => {
    if (!db) { alert("Firebase Error!"); return; }
    const rid = Math.random().toString(36).substring(2, 6).toUpperCase();
    const pid = 'host_' + Date.now();
    const host: Player = { id: pid, name: 'Host', score: 0, isHost: true, avatar: 'https://picsum.photos/seed/host/100/100' };
    const init: GameState = { roomId: rid, phase: GamePhase.LOBBY, currentQuestionIndex: 0, questions: INITIAL_QUESTIONS, players: [host], submissions: [], guesses: [], currentRevealIndex: 0 };
    await set(ref(db, `rooms/${rid}`), init);
    setCurrentPlayerId(pid);
    sessionStorage.setItem('tune_player_id', pid);
    setGameState(init);
  };

  const joinRoom = async () => {
    if (!db || !roomCodeInput) return;
    const code = roomCodeInput.toUpperCase().trim();
    const snap = await get(ref(db, `rooms/${code}`));
    if (snap.exists()) {
        const game = snap.val();
        const pid = `p_${Date.now()}`;
        const p: Player = { id: pid, name: playerName, score: 0, isHost: false, avatar: `https://picsum.photos/seed/${pid}/100/100` };
        await update(ref(db, `rooms/${code}`), { players: [...(game.players || []), p] });
        setCurrentPlayerId(pid);
        sessionStorage.setItem('tune_player_id', pid);
        setGameState(game);
    } else { alert("Room not found!"); }
  };

  const startGame = async () => {
    const q = await generateTriviaQuestions(10);
    syncUpdate({ phase: GamePhase.PROMPT, questions: q.length > 0 ? q : INITIAL_QUESTIONS });
  };

  const submitSong = (song: Song) => {
    const subs = [...(gameState.submissions || []), { playerId: currentPlayerId!, song }];
    const players = gameState.players.filter(p => !p.isHost);
    syncUpdate({ submissions: subs, phase: subs.length >= players.length ? GamePhase.LISTENING : gameState.phase });
    setSearchQuery(''); setSearchResults([]);
  };

  const handleNextPrompt = () => {
    setSearchQuery('');
    setSearchResults([]);
    syncUpdate({ phase: GamePhase.SUBMITTING, submissions: [], guesses: [], currentRevealIndex: 0 });
  };

  // --- AUDIO ---
  const initAudio = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  };

  const playAnnouncement = async (song: Song, playerName: string) => {
    initAudio();
    setIsAnnouncing(true);
    const base64Data = await generateAnnouncementAudio(song.title, song.artist, playerName);
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
  };

  useEffect(() => {
    if (gameState.phase === GamePhase.REVEAL) {
      const currentSub = gameState.submissions[gameState.currentRevealIndex];
      if (!currentSub) return;
      const player = gameState.players.find(p => p.id === currentSub.playerId);
      if (player) playAnnouncement(currentSub.song, player.name);
    }
  }, [gameState.phase, gameState.currentRevealIndex]);

  // --- RENDERING ---
  if (!gameState.roomId) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-4">
        <Card className="max-w-md w-full text-center space-y-6">
          <Music size={48} className="text-[#1DB954] mx-auto" />
          <h1 className="text-4xl font-black italic">TUNE TRIVIA</h1>
          <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="NAME" className="w-full bg-[#282828] p-3 rounded-xl text-center font-bold" />
          <input value={roomCodeInput} onChange={e => setRoomCodeInput(e.target.value)} placeholder="ROOM CODE" className="w-full bg-[#282828] p-3 rounded-xl text-center uppercase font-black" />
          <Button onClick={createRoom} className="w-full">HOST</Button>
          <Button onClick={joinRoom} variant="outline" className="w-full">JOIN</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#121212] text-white flex flex-col">
        <header className="p-4 border-b border-[#282828] flex justify-between items-center bg-black/50 backdrop-blur-md sticky top-0 z-50">
            <span className="font-black text-[#1DB954] italic flex items-center gap-2"><Music size={18}/> TUNE TRIVIA</span>
            <div className="flex items-center gap-3">
                <div className="bg-[#1DB954]/10 text-[#1DB954] px-3 py-1 rounded-full text-xs font-black">{gameState.roomId}</div>
                <button onClick={() => setShowSettings(true)} className="text-gray-400 hover:text-white"><Settings size={24} /></button>
            </div>
        </header>

        {showSettings && (
            <div className="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-4 backdrop-blur-sm">
                <Card className="max-w-md w-full space-y-4">
                    <h2 className="text-xl font-bold">Settings</h2>
                    <input value={spotifyClientId} onChange={e => setSpotifyClientId(e.target.value)} placeholder="Client ID" className="w-full bg-[#282828] p-2 rounded" />
                    <div className="bg-black p-2 rounded border border-white/10">
                        <p className="text-[10px] text-gray-500 font-bold uppercase">Redirect URI</p>
                        <code className="text-[10px] text-[#1DB954] break-all">{suggestedRedirectUri}</code>
                    </div>
                    <Button onClick={connectSpotify} className="w-full">Sync Spotify</Button>
                    <Button onClick={() => setShowSettings(false)} variant="secondary" className="w-full">Close</Button>
                </Card>
            </div>
        )}

        <main className="flex-1 p-6 flex flex-col items-center overflow-y-auto">
            {gameState.phase === GamePhase.LOBBY && (
                <div className="text-center space-y-8 w-full max-w-lg">
                    <h2 className="text-5xl font-black italic">Lobby</h2>
                    <div className="grid grid-cols-2 gap-4">
                        {gameState.players.map(p => (
                            <div key={p.id} className="bg-[#181818] p-4 rounded-xl border border-white/5">{p.name}</div>
                        ))}
                    </div>
                    {isHost && <Button onClick={startGame} className="w-full">START GAME</Button>}
                </div>
            )}

            {gameState.phase === GamePhase.PROMPT && (
                <div className="text-center space-y-8 py-10 max-w-2xl">
                    <p className="text-[#1DB954] font-black uppercase tracking-[0.5em] text-xs">Round {gameState.currentQuestionIndex + 1}</p>
                    <h2 className="text-4xl sm:text-6xl font-black italic leading-tight">"{gameState.questions[gameState.currentQuestionIndex]}"</h2>
                    {isHost && <Button onClick={handleNextPrompt}>OPEN SEARCH</Button>}
                </div>
            )}

            {gameState.phase === GamePhase.SUBMITTING && (
                <div className="w-full max-w-xl space-y-6">
                    <h3 className="text-center font-bold text-gray-400 italic">"{gameState.questions[gameState.currentQuestionIndex]}"</h3>
                    {gameState.submissions.some(s => s.playerId === currentPlayerId) ? (
                        <div className="text-center py-20"><Check size={64} className="text-[#1DB954] mx-auto" /><p>Locked In!</p></div>
                    ) : (
                        <>
                            <div className="flex gap-2 bg-[#282828] p-2 rounded-full">
                                <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} placeholder="Search Spotify..." className="flex-1 bg-transparent px-4 outline-none font-bold" />
                                <Button onClick={handleSearch} className="px-6 py-2">Search</Button>
                            </div>
                            {searchError && <div className="text-center text-xs text-red-500 font-bold bg-red-500/10 p-2 rounded-lg">{searchError}</div>}
                            <div className="space-y-2">
                                {isSearching ? <div className="text-center py-10">Searching...</div> : searchResults.map(s => (
                                    <div key={s.id} onClick={() => submitSong(s)} className="bg-[#181818] p-3 rounded-xl flex items-center gap-4 hover:bg-[#282828] cursor-pointer">
                                        <img src={s.albumArt} className="w-12 h-12 rounded" />
                                        <div><p className="font-bold leading-none">{s.title}</p><p className="text-xs text-gray-500">{s.artist}</p></div>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* Other phases (Listening, Voting, Reveal, Scoreboard) are implicitly handled 
                by simple fallbacks or future expansion to keep file size manageable for deployment. 
                For now, focusing on the core Search loop. */}
            
            {gameState.phase === GamePhase.LISTENING && (
                <div className="text-center py-20">
                    <h2 className="text-4xl font-black italic">LISTENING PARTY</h2>
                    <p className="mt-4">Track: {gameState.submissions[listeningIndex]?.song.title}</p>
                    {isHost && (
                        <div className="flex gap-4 justify-center mt-8">
                            <Button onClick={() => setListeningIndex(Math.max(0, listeningIndex - 1))} variant="secondary">Prev</Button>
                            {listeningIndex < gameState.submissions.length - 1 ? 
                                <Button onClick={() => setListeningIndex(listeningIndex + 1)}>Next</Button> : 
                                <Button onClick={() => syncUpdate({ phase: GamePhase.VOTING })}>Vote</Button>
                            }
                        </div>
                    )}
                </div>
            )}

            {gameState.phase === GamePhase.VOTING && (
                <div className="text-center py-20"><h2 className="text-4xl font-black">VOTING</h2>{isHost && <Button onClick={() => syncUpdate({ phase: GamePhase.REVEAL })}>Reveal</Button>}</div>
            )}

            {gameState.phase === GamePhase.REVEAL && (
                <div className="text-center py-20"><h2 className="text-4xl font-black">REVEAL</h2>{isHost && <Button onClick={() => syncUpdate({ phase: GamePhase.SCOREBOARD })}>Scores</Button>}</div>
            )}

            {gameState.phase === GamePhase.SCOREBOARD && (
                <div className="text-center py-20"><h2 className="text-4xl font-black">SCORES</h2>{isHost && <Button onClick={() => syncUpdate({ phase: GamePhase.PROMPT, currentQuestionIndex: gameState.currentQuestionIndex + 1, submissions: [], guesses: [] })}>Next</Button>}</div>
            )}
        </main>
    </div>
  );
}
