const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const SpotifyWebApi = require('spotify-web-api-node');
require('dotenv').config(); 

const app = express();

const corsOptions = {
  origin: ['http://localhost:5174', 'http://localhost:3000', 'https://moodtunes-frontend.onrender.com'],
  methods: 'GET,POST,PUT,DELETE,OPTIONS',
  allowedHeaders: 'Content-Type,Authorization',
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY, { apiVersion: 'v1' });
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID, 
  clientSecret: process.env.SPOTIFY_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'https://moodtunes-backend.onrender.com/callback',
});

const chatSessions = new Map();
const trackCache = new Map();
const usedTracks = new Set();
let spotifyTokens = { accessToken: null, refreshToken: null, expiresAt: 0 };

const normalizeText = (text) => {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '');
};

const searchTrack = async (track) => {
  if (trackCache.has(track)) {
    return trackCache.get(track);
  }

  try {
    const [title, artist] = track.split(/ - (.*)/s).map(s => s.trim());

    if (!title || !artist) {
      console.warn(`Formato inválido: ${track}`);
      return null;
    }

    const normalizedTitle = normalizeText(title);
    const normalizedArtist = normalizeText(artist);

    const queries = [
      `track:"${title}" artist:"${artist}"`,
      `track:"${title}"`,
      `artist:"${artist}"`,
      `${title} ${artist}`,
      `${normalizedTitle} ${normalizedArtist}`,
    ];

    for (const query of queries) {
      try {
        const results = await spotifyApi.search(query, ['track'], { limit: 5, market: 'BR' });

        const match = results.body.tracks.items.find(item => {
          const itemTitle = normalizeText(item.name);
          const itemArtist = item.artists.map(a => normalizeText(a.name)).join(' ');

          const titleMatch = itemTitle.includes(normalizedTitle) || normalizedTitle.includes(itemTitle);
          const artistMatch = itemArtist.includes(normalizedArtist) || normalizedArtist.includes(itemArtist);
          const popularity = item.popularity > 30;

          return titleMatch && artistMatch && popularity;
        });

        if (match && !usedTracks.has(match.uri)) {
          usedTracks.add(match.uri);
          trackCache.set(track, match.uri);
          return match.uri;
        }
      } catch (error) {
        console.warn(`Erro na consulta "${query}":`, error.message);
      }
    }

    console.warn(`Música não encontrada: ${track}`);
    return null;
  } catch (error) {
    console.error(`Erro ao buscar música "${track}":`, error.message);
    return null;
  }
};

const createPlaylist = async (mood, tracks) => {
  try {
    if (typeof mood !== 'string' || mood.trim().length === 0) throw new Error('Campo mood ausente ou inválido');
    if (!Array.isArray(tracks) || tracks.length === 0) throw new Error('Formato inválido para tracks. Deve ser um array de strings.');

    const uris = (await Promise.all(tracks.map(searchTrack))).filter(uri => uri);

    if (uris.length < 3) {
      return { success: false, message: 'Não foi possível encontrar músicas suficientes para criar a playlist.' };
    }

    const playlistName = `MoodTunes: ${new Date().toLocaleDateString('pt-BR')}`;
    const playlist = await spotifyApi.createPlaylist(playlistName, { public: true, description: `Playlist gerada automaticamente pelo MoodTunes para o humor: ${mood}` });
    await spotifyApi.addTracksToPlaylist(playlist.body.id, uris);

    return {
      success: true,
      playlist: {
        name: playlistName,
        url: playlist.body.external_urls.spotify,
        id: playlist.body.id,
        trackCount: uris.length,
        mood,
      },
    };
  } catch (error) {
    console.error('Erro crítico:', error.stack);
    throw error;
  }
};

app.get('/', (req, res) => res.status(200).json({ status: 'online', message: '🎵 MoodTunes API está rodando!', version: '1.0.0' }));

app.post('/chat', async (req, res) => {
  const { userId, message } = req.body;
  if (!userId || !message) return res.status(400).json({ error: 'Dados inválidos' });

  try {
    if (!chatSessions.has(userId)) {
      const initialPrompt = `
        Você é um DJ terapêutico especializado em criar playlists personalizadas com base no humor das pessoas. 
        Sua tarefa é:
        1. Iniciar a conversa se apresentando como um DJ terapêutico e explicando que vai criar uma playlist personalizada com base no humor do usuário.
        2. Conversar com o usuário para entender como ele está se sentindo hoje. Faça perguntas detalhadas para entender o humor e as preferências musicais do usuário, busque sempre ser muito empático.
        3. Após 4 interações, **não exiba nada no chat**. Em vez disso, retorne **apenas** um JSON com o humor e uma lista de 10 músicas que existam no Spotify. O formato deve ser:
           {
             "mood": "humor do usuário",
             "tracks": ["Música 1", "Música 2", "Música 3", ...]
           }
           **Não inclua nenhum texto adicional além do JSON.**
      `;
      chatSessions.set(userId, { 
        chat: model.startChat({ history: [{ role: 'user', parts: [{ text: initialPrompt }] }] }), 
        interactionCount: 0 
      });
    }

    const session = chatSessions.get(userId);
    const result = await session.chat.sendMessage(message);
    const responseText = await result.response.text();
    session.interactionCount++;

    if (session.interactionCount >= 4) {
      const jsonMatch = responseText.match(/\{.*\}/s);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);

          if (parsed.mood && Array.isArray(parsed.tracks) && parsed.tracks.length === 10) {
            chatSessions.delete(userId);

            const playlistResponse = await createPlaylist(parsed.mood, parsed.tracks);

            if (playlistResponse.success) {
              return res.json({ 
                action: 'playlist_created', 
                isFinished: true,
                message: 'Obrigado por usar o MoodTunes! Sua playlist foi criada com sucesso. 🎵',
                data: { 
                  playlist: playlistResponse.playlist 
                } 
              });
            } else {
              return res.status(404).json({ error: 'Não foi possível criar a playlist.' });
            }
          }
        } catch (error) {
          console.error('Erro ao processar JSON:', error);
          return res.status(400).json({ error: 'Erro ao processar a resposta do Gemini.' });
        }
      }
    }

    res.json({ action: 'continue_chat', response: responseText });
  } catch (error) {
    console.error('Erro no chat:', error);
    res.status(500).json({ error: 'Erro na conversação' });
  }
});

app.get('/auth', (req, res) => {
  const scopes = ['playlist-modify-public', 'user-read-private'];
  const state = 'state'; t, ja está tudo ok e funcionando, vamos faze
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI || 'https://moodtunes-backend.onrender.com/callback';

  const authorizeURL = `https://accounts.spotify.com/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes.join(' '))}&state=${state}`;
  
  console.log('Authorize URL:', authorizeURL);
  res.redirect(authorizeURL);
});
app.get('/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const data = await spotifyApi.authorizationCodeGrant(code);

    spotifyTokens = {
      accessToken: data.body.access_token,
      refreshToken: data.body.refresh_token,
      expiresAt: Date.now() + (data.body.expires_in * 1000),
    };

    spotifyApi.setAccessToken(spotifyTokens.accessToken);

    res.redirect('https://moodtunes-frontend.onrender.com');
  } catch (error) {
    console.error('Erro na autenticação:', error);
    res.status(500).send('Erro na autenticação');
  }
});
app.get('/check', (req, res) => {
  if (spotifyTokens.accessToken) {
    res.json({ isAuthenticated: true });
  } else {
    res.status(401).json({ isAuthenticated: false });
  }
});
const checkSpotifyAuth = async (req, res, next) => {
  try {
    if (Date.now() >= spotifyTokens.expiresAt) {
      const data = await spotifyApi.refreshAccessToken();
      spotifyApi.setAccessToken(data.body.access_token);
      spotifyTokens = { 
        accessToken: data.body.access_token, 
        refreshToken: spotifyTokens.refreshToken,
        expiresAt: Date.now() + (data.body.expires_in * 1000) 
      };
    }
    next();
  } catch (error) {
    console.error('Erro de autenticação:', error);
    res.status(401).json({ error: 'Reautenticação necessária' });
  }
};

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));