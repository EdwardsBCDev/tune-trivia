
import React from 'react';
import { Song } from './types';

export const MOCK_SONGS: Song[] = [
  { id: '1', title: 'Blinding Lights', artist: 'The Weeknd', albumArt: 'https://picsum.photos/seed/weeknd/300/300' },
  { id: '2', title: 'Bohemian Rhapsody', artist: 'Queen', albumArt: 'https://picsum.photos/seed/queen/300/300' },
  { id: '3', title: 'Stay', artist: 'The Kid LAROI & Justin Bieber', albumArt: 'https://picsum.photos/seed/stay/300/300' },
  { id: '4', title: 'Flowers', artist: 'Miley Cyrus', albumArt: 'https://picsum.photos/seed/miley/300/300' },
  { id: '5', title: 'As It Was', artist: 'Harry Styles', albumArt: 'https://picsum.photos/seed/harry/300/300' },
  { id: '6', title: 'Cruel Summer', artist: 'Taylor Swift', albumArt: 'https://picsum.photos/seed/taylor/300/300' },
  { id: '7', title: 'Lose Yourself', artist: 'Eminem', albumArt: 'https://picsum.photos/seed/eminem/300/300' },
  { id: '8', title: 'Dreams', artist: 'Fleetwood Mac', albumArt: 'https://picsum.photos/seed/dreams/300/300' },
  { id: '9', title: 'Billie Jean', artist: 'Michael Jackson', albumArt: 'https://picsum.photos/seed/mj/300/300' },
  { id: '10', title: 'Levitating', artist: 'Dua Lipa', albumArt: 'https://picsum.photos/seed/dua/300/300' },
  { id: '11', title: 'Superstition', artist: 'Stevie Wonder', albumArt: 'https://picsum.photos/seed/stevie/300/300' },
  { id: '12', title: 'Good 4 U', artist: 'Olivia Rodrigo', albumArt: 'https://picsum.photos/seed/olivia/300/300' },
];

export const INITIAL_QUESTIONS = [
  "The perfect song for a Sunday Roast session.",
  "Your ultimate 'Guilty Pleasure' track.",
  "The song you want playing when you walk into a crowded room.",
  "The track that always makes you want to speed while driving.",
  "A song that reminds you of your first heartbreak.",
  "The best song to clean the whole house to.",
  "A song that describes your current mood perfectly.",
  "The track you'd choose for a karaoke deathmatch.",
  "A song that always makes you think of your best friend.",
  "The song you want played at your funeral (ironically or not)."
];
