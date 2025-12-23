
export interface Song {
  id: string;
  title: string;
  artist: string;
  albumArt: string;
  previewUrl?: string;
}

export interface Player {
  id: string;
  name: string;
  score: number;
  isHost: boolean;
  avatar: string;
}

export interface Submission {
  playerId: string;
  song: Song;
}

export interface Guess {
  voterId: string;
  submissionId: string; // The song ID being guessed
  targetPlayerId: string; // Who they think picked it
}

export enum GamePhase {
  LOBBY = 'LOBBY',
  PROMPT = 'PROMPT',
  SUBMITTING = 'SUBMITTING',
  LISTENING = 'LISTENING',
  VOTING = 'VOTING',
  REVEAL = 'REVEAL',
  SCOREBOARD = 'SCOREBOARD',
  FINAL = 'FINAL'
}

export interface GameState {
  roomId: string;
  phase: GamePhase;
  currentQuestionIndex: number;
  questions: string[];
  players: Player[];
  submissions: Submission[];
  guesses: Guess[];
  currentRevealIndex: number;
}
