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

// Initialize Firebase (Safely)
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
  const [isAnnouncing, setIsAnnouncing] = useState(false);
  const [listeningIndex, setListeningIndex] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  
  // Spotify State
  const [spotifyToken, setSpotifyToken] = useState<string | null>(() => localStorage.getItem('spotify_access_token'));
  const [hostToken, setHostToken] = useState<string | null>(null); 
  
  // *** YOUR CLIENT ID HARDCODED HERE FOR SAFETY ***
  const [spotifyClientId, setSpotifyClientId] = useState(() => 
    import.meta.env.VITE_SPOTIFY_CLIENT_ID || localStorage.getItem('spotify_client_id') || '7f13d1d2909644368c6ce8eddac4b789'
  );
  
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

  // --- SPOTIFY AUTH LOGIC (FIXED) ---
  const currentOrigin = window.location.origin;
  
  // Force HTTPS if using the nip.io address
  let calculatedUri = currentOrigin.includes('nip.io') ? currentOrigin + '/' : currentOrigin.replace(/(\d+\.\d+\.\d+\.\d+)/, '$1.nip.io') + '/';
  if (calculatedUri.startsWith('http://')) {
      calculatedUri = calculatedUri.replace('http://', 'https://');
  }
  
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
    
    // *** REAL SPOTIFY ENDPOINT ***
    const AUTH_ENDPOINT = "https://accounts.spotify.com/authorize";
    const scopes = ['user-read-private', 'user-read-email'].join(' ');
    
    const finalUri = suggestedRedirectUri;
    
    window.location.href = `${AUTH_ENDPOINT}?client_id=${spotifyClientId}&redirect_uri=${encodeURIComponent(finalUri)}&scope=${encodeURIComponent(scopes)}&response_type=token&show_dialog=true`;
  };

  // --- SEARCH LOGIC (FIXED) ---
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchError(null);

    const activeToken = spotifyToken || hostToken;

    if (activeToken) {
        try {
            // *** REAL SPOTIFY SEARCH ENDPOINT ***
            const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=10`, {
                headers: { Authorization: `Bearer ${activeToken}` }
            });
            
            if (response.status === 401) {
                setSearchError("Spotify session expired. Host needs to Re-sync.");
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
        } catch (e) { console.error("Search error", e); }
    }
    // Fallback
    setSearchResults(MOCK_SONGS.filter(s => s.title.toLowerCase().includes(searchQuery.toLowerCase())));
    setIsSearching(false);
  };

  // --- GAME ACTIONS ---
  const syncUpdate = (updates: Partial<GameState>) => { if (db && gameState.roomId) update(ref(db, `rooms/${gameState.roomId}`), updates); };

  const createRoom = async () => {
    if (!db) { alert("Firebase Error! Check Env Variables."); return; }
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
    if (!db || !roomCodeInput || !playerName) return;
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

  const audioLoop = (song: Song) => {
      // Future audio implementation
  };

  // --- VIEWS ---
  if (!gameState.roomId) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-4">
        <Card className="max-w-md w-full text-center space-y-6">
          <Music size={48} className="text-[#1DB954] mx-auto animate-pulse" />
          <h1 className="text-4xl font-black italic">TUNE TRIVIA</h1>
          <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="NAME" className="w-full bg-[#282828] p-3 rounded-xl text-center font-bold" />
          <input value={roomCodeInput} onChange={e => setRoomCodeInput(e.target.value)} placeholder="ROOM CODE" className="w-full bg-[#282828] p-3 rounded-xl text-center uppercase font-black tracking-widest" />
          <Button onClick={createRoom} className="w-full">HOST PARTY</Button>
          <Button onClick={joinRoom} variant="outline" className="w-full">JOIN ROOM</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#121212] text-white flex flex-col">
        {/* HEADER WITH GEAR ICON */}
        <header className="p-4 border-b border-[#282828] flex justify-between items-center bg-black/50 backdrop-blur-md sticky top-0 z-50">
            <span className="font-black text-[#1DB954] italic flex items-center gap-2"><Music size={18}/> TUNE TRIVIA</span>
            <div className="flex items-center gap-3">
                <div className="bg-[#1DB954]/10 text-[#1DB954] px-3 py-1 rounded-full text-xs font-black">{gameState.roomId}</div>
                <button onClick={() => setShowSettings(true)} className="text-gray-400 hover:text-white transition-colors">
                    <Settings size={24} />
                </button>
            </div>
        </header>

        {/* SETTINGS MODAL */}
        {showSettings && (
            <div className="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-4 backdrop-blur-md animate-in fade-in">
                <Card className="max-w-md w-full space-y-6">
                    <div className="flex justify-between items-center">
                        <h2 className="text-xl font-bold text-[#1DB954]">Settings</h2>
                        <button onClick={() => setShowSettings(false)}><X/></button>
                    </div>
                    <div className="space-y-4">
                        <div>
                            <label className="text-[10px] font-bold uppercase text-gray-500">Spotify Client ID</label>
                            <input value={spotifyClientId} onChange={e => setSpotifyClientId(e.target.value)} placeholder="Paste Client ID" className="w-full bg-[#282828] p-2 rounded mt-1 font-mono text-xs" />
                        </div>
                        <div className="p-3 bg-black rounded-xl border border-white/5">
                            <p className="text-[10px] text-gray-500 uppercase font-bold mb-1">Redirect URI (Must match Dashboard)</p>
                            <code className="text-[10px] text-[#1DB954] break-all leading-none">{suggestedRedirectUri}</code>
                        </div>
                        <Button onClick={connectSpotify} className="w-full">Sync Spotify Account</Button>
                        {spotifyToken && <p className="text-center text-[10px] text-green-500 font-bold uppercase">✓ Host Linked</p>}
                    </div>
                    <Button onClick={() => setShowSettings(false)} variant="secondary" className="w-full">Close</Button>
                </Card>
            </div>
        )}

        <main className="flex-1 p-6 flex flex-col items-center overflow-y-auto">
            {gameState.phase === GamePhase.LOBBY && (
                <div className="text-center space-y-8 w-full max-w-lg animate-in slide-in-from-bottom-4">
                    <h2 className="text-5xl font-black italic">Lobby</h2>
                    <div className="grid grid-cols-2 gap-4">
                        {gameState.players.map(p => (
                            <div key={p.id} className="bg-[#181818] p-4 rounded-2xl border border-[#282828] flex items-center gap-3">
                                <img src={p.avatar} className="w-8 h-8 rounded-full" />
                                <span className="font-bold truncate">{p.name}</span>
                            </div>
                        ))}
                    </div>
                    {isHost ? (
                        <Button onClick={startGame} className="w-full py-6 text-xl">START SESSION</Button>
                    ) : (
                        <div className="text-[#1DB954] animate-pulse font-black uppercase tracking-widest">Waiting for host...</div>
                    )}
                </div>
            )}

            {gameState.phase === GamePhase.PROMPT && (
                <div className="text-center space-y-8 py-10 max-w-2xl">
                    <p className="text-[#1DB954] font-black uppercase tracking-[0.5em] text-xs">Round {gameState.currentQuestionIndex + 1}</p>
                    <h2 className="text-4xl sm:text-6xl font-black italic leading-tight">"{gameState.questions[gameState.currentQuestionIndex] || '...'}"</h2>
                    {isHost && <Button onClick={() => syncUpdate({ phase: GamePhase.SUBMITTING })}>OPEN SELECTION</Button>}
                </div>
            )}

            {gameState.phase === GamePhase.SUBMITTING && (
                <div className="w-full max-w-xl space-y-6 animate-in fade-in">
                    <div className="text-center bg-[#181818] p-6 rounded-3xl border border-[#1DB954]/10">
                        <h3 className="text-xl font-black italic">"{gameState.questions[gameState.currentQuestionIndex]}"</h3>
                    </div>
                    
                    {gameState.submissions.some(s => s.playerId === currentPlayerId) ? (
                        <div className="text-center py-20 space-y-4">
                            <Check size={80} className="text-[#1DB954] mx-auto animate-bounce" />
                            <h2 className="text-3xl font-black italic uppercase">Choice Locked</h2>
                            <p className="text-gray-500 font-bold uppercase tracking-widest">Waiting for friends...</p>
                        </div>
                    ) : (
                        <>
                            <div className="flex gap-2 bg-[#242424] p-2 rounded-full border-2 border-transparent focus-within:border-[#1DB954]">
                                <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} placeholder="Search Spotify library..." className="flex-1 bg-transparent px-4 outline-none font-bold" />
                                <Button onClick={handleSearch} className="px-6 py-2">Search</Button>
                            </div>
                            
                            {searchError && <div className="text-center text-xs text-red-500 font-bold bg-red-500/10 p-2 rounded-lg">{searchError}</div>}

                            <div className="space-y-2 max-h-[50vh] overflow-y-auto custom-scrollbar">
                                {isSearching ? (
                                    <div className="text-center py-10 animate-pulse text-gray-500 font-bold uppercase italic">Digging...</div>
                                ) : searchResults.map(s => (
                                    <div key={s.id} onClick={() => submitSong(s)} className="bg-[#181818] p-3 rounded-2xl flex items-center gap-4 hover:bg-[#282828] cursor-pointer border border-transparent hover:border-[#1DB954]">
                                        <img src={s.albumArt} className="w-14 h-14 rounded-lg shadow-lg" />
                                        <div className="overflow-hidden">
                                            <p className="font-black leading-none truncate">{s.title}</p>
                                            <p className="text-xs text-gray-500 font-bold mt-1 italic">{s.artist}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </div>
            )}

            {gameState.phase === GamePhase.LISTENING && (
                <div className="text-center space-y-10 w-full max-w-md animate-in zoom-in">
                    <h2 className="text-3xl font-black italic uppercase text-[#1DB954]">The Reveal</h2>
                    <div className="aspect-square bg-black border-[12px] border-[#181818] rounded-full flex items-center justify-center animate-[spin_10s_linear_infinite] shadow-2xl relative">
                        <div className="absolute inset-0 rounded-full border-2 border-white/5"></div>
                        {gameState.submissions[listeningIndex] && (
                            <img src={gameState.submissions[listeningIndex].song.albumArt} className="w-1/2 rounded-full border-4 border-black" />
                        )}
                    </div>
                    {gameState.submissions[listeningIndex] && (
                        <div>
                            <h3 className="text-3xl font-black italic tracking-tighter leading-none mb-2">{gameState.submissions[listeningIndex].song.title}</h3>
                            <p className="text-xl text-gray-500 font-bold italic">{gameState.submissions[listeningIndex].song.artist}</p>
                        </div>
                    )}
                    {isHost && (
                        <div className="flex gap-4 justify-center">
                            <Button onClick={() => setListeningIndex(i => Math.max(0, i - 1))} variant="secondary">PREV</Button>
                            {listeningIndex < gameState.submissions.length - 1 ? 
                                <Button onClick={() => setListeningIndex(i => i + 1)}>NEXT TRACK</Button> : 
                                <Button onClick={() => syncUpdate({ phase: GamePhase.VOTING })}>START VOTING</Button>
                            }
                        </div>
                    )}
                </div>
            )}

            {/* Voting View */}
            {gameState.phase === GamePhase.VOTING && (
                <div className="text-center py-20 w-full">
                    <h2 className="text-5xl font-black italic text-[#1DB954]">VOTING TIME</h2>
                    <p className="mt-4 text-gray-400 font-bold uppercase mb-8">Cast your votes on your devices!</p>
                    
                    {/* Voting Grid for Players */}
                    {!isHost && (
                        <div className="grid grid-cols-1 gap-4 max-w-lg mx-auto">
                            {gameState.submissions.filter(s => s.playerId !== currentPlayerId).map(sub => (
                                <div key={sub.song.id} className="bg-[#181818] p-4 rounded-2xl flex items-center gap-4">
                                    <img src={sub.song.albumArt} className="w-12 h-12 rounded-lg" />
                                    <div className="flex-1 text-left">
                                        <p className="font-bold">{sub.song.title}</p>
                                        <div className="flex flex-wrap gap-2 mt-2">
                                            {gameState.players.filter(p => !p.isHost && p.id !== currentPlayerId).map(p => (
                                                <button 
                                                    key={p.id}
                                                    onClick={() => {
                                                        const otherGuesses = gameState.guesses.filter(g => !(g.voterId === currentPlayerId && g.submissionId === sub.song.id));
                                                        syncUpdate({ guesses: [...otherGuesses, { voterId: currentPlayerId!, submissionId: sub.song.id, targetPlayerId: p.id }] });
                                                    }}
                                                    className={`text-xs px-3 py-1 rounded-full border ${gameState.guesses.find(g => g.voterId === currentPlayerId && g.submissionId === sub.song.id && g.targetPlayerId === p.id) ? 'bg-[#1DB954] text-black border-transparent' : 'border-gray-600'}`}
                                                >
                                                    {p.name}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {isHost && <Button onClick={() => syncUpdate({ phase: GamePhase.SCOREBOARD })} className="mt-8">GO TO RESULTS</Button>}
                </div>
            )}

            {/* Scoreboard View */}
            {gameState.phase === GamePhase.SCOREBOARD && (
                <div className="w-full max-w-lg text-center space-y-6">
                    <h1 className="text-6xl font-black italic">Leaderboard</h1>
                    <div className="space-y-4">
                        {gameState.players.sort((a,b) => b.score - a.score).map((p, i) => (
                            <div key={p.id} className="bg-[#181818] p-6 rounded-2xl flex items-center justify-between text-2xl font-bold">
                                <span>#{i+1} {p.name}</span>
                                <span className="text-[#1DB954]">{p.score}</span>
                            </div>
                        ))}
                    </div>
                    {isHost && <Button onClick={() => syncUpdate({ phase: GamePhase.PROMPT, currentQuestionIndex: gameState.currentQuestionIndex + 1, submissions: [], guesses: [] })}>Next Round</Button>}
                </div>
            )}
        </main>
    </div>
  );
}
