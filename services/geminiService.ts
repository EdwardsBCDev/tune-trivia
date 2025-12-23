
import { GoogleGenAI, Type, Modality } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

export const generateTriviaQuestions = async (count: number = 10): Promise<string[]> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Generate ${count} creative and fun prompts for a music trivia game where players choose a song that fits a specific vibe or scenario. Examples: 'Song for a Sunday Roast', 'Song to walk down the aisle to', 'Guilty pleasure track'. Make them varied and social.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.STRING
          }
        }
      }
    });

    if (response.text) {
      return JSON.parse(response.text);
    }
  } catch (error) {
    console.error("Error generating questions:", error);
  }
  return []; 
};

export const searchMusicAI = async (query: string): Promise<any[]> => {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: `The user is searching for music. Query: "${query}". Return a JSON list of 5 real songs with their title and artist that match this search. Format: [{"title": "...", "artist": "..."}]`,
            config: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            title: { type: Type.STRING },
                            artist: { type: Type.STRING }
                        },
                        required: ["title", "artist"]
                    }
                }
            }
        });
        if (response.text) {
            return JSON.parse(response.text);
        }
    } catch (e) {
        console.error(e);
    }
    return [];
}

/**
 * Generates an energetic DJ announcement for the revealed song.
 */
export const generateAnnouncementAudio = async (songTitle: string, artist: string, playerName: string): Promise<string | undefined> => {
  try {
    const prompt = `Say enthusiastically: "And the selection for this round... chosen by ${playerName}... is the classic track ${songTitle} by ${artist}! Let's see who guessed it right!"`;
    
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Puck' }, // Energetic male voice
          },
        },
      },
    });

    return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  } catch (error) {
    console.error("TTS Error:", error);
    return undefined;
  }
};

// Audio Decoding Utilities
export function decodeBase64(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}
