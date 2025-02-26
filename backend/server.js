const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const SpotifyWebApi = require('spotify-web-api-node');
require('dotenv').config();

const app = express();

const corsOptions = {
  origin: ['http://localhost:5174', 'http://localhost:3000','https://moodtunes-frontend.onrender.com'],
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
  redirectUri: process.env.SPOTIFY_REDIRECT_URI
});

const chatSessions = new Map();
let spotifyTokens = { accessToken: null, refreshToken: null, expiresAt: 0 };
const usedTracks = new Set();

const getMoodMessage = (mood) => {
  const moodMessages = {
    focado: ["🔝 Playlist turbinada para sua produtividade!", "💡 Hora de brilhar com essas tracks poderosas!", "🚀 Combustível musical para seus projetos!"],
    triste: ["☀️ Vamos trazer um pouco de luz para seu dia!", "🤗 Todo mundo tem dias assim... espero que essas músicas ajudem!", "🎵 A música é o melhor remédio para a alma"],
    estressado: ["🧘‍♂️ Respire fundo e deixe a música acalmar sua mente...", "🌿 Serenidade sonora para acalmar o coração", "💆‍♀️ Relaxe e deixe as batidas te levarem para outro lugar"],
    feliz: ["🎉 Hora de celebrar esse momento incrível!", "🥳 Playlist animada para manter a vibe positiva!", "😊 Músicas que combinam com seu bom humor!"]
  };
  return moodMessages[mood.toLowerCase()]?.[Math.floor(Math.random() * moodMessages[mood.toLowerCase()].length)] || "🎶 Aqui está sua trilha sonora personalizada!";
};

const parseGeminiResponse = (text) => {
  try {
    const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanedText);
    if (!parsed.mood || !Array.isArray(parsed.tracks) || parsed.tracks.length !== 10) throw new Error('Formato inválido');
    parsed.message = getMoodMessage(parsed.mood);
    return parsed;
  } catch (error) {
    console.error('Falha no parse:', error.message);
    return null;
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
        2. Conversar com o usuário para entender como ele está se sentindo hoje. Faça perguntas detalhadas para entender o humor e as preferências musicais do usuário.
        3. Após 4 interações, retorne **apenas** um JSON com o humor e uma lista de 10 músicas que existam no spotify. O formato deve ser:
           {
             "mood": "humor do usuário",
             "tracks": ["Música 1", "Música 2", "Música 3", ...]
           }
           **Não inclua nenhum texto adicional além do JSON.**
      `;
      chatSessions.set(userId, { chat: model.startChat({ history: [{ role: 'user', parts: [{ text: initialPrompt }] }] }), interactionCount: 0 });
    }

    const session = chatSessions.get(userId);
    const result = await session.chat.sendMessage(message);
    const responseText = await result.response.text();
    session.interactionCount++;

    if (session.interactionCount >= 4) {
      const jsonMatch = responseText.match(/```json([\s\S]*?)```/);
      if (jsonMatch) {
        const parsed = parseGeminiResponse(jsonMatch[1].trim());
        if (parsed) {
          chatSessions.delete(userId);
          const playlistResponse = await createPlaylist(parsed.mood, parsed.tracks);
          return res.json({ 
            action: 'playlist_created', 
            data: { 
              message: parsed.message, 
              playlist: playlistResponse.playlist 
            } 
          });
        }
      }
    }

    res.json({ action: 'continue_chat', response: responseText });
  } catch (error) {
    console.error('Erro no chat:', error);
    res.status(500).json({ error: 'Erro na conversação' });
  }
});

const searchTrack = async (track) => {
  try {
    const [title, artist] = track.split(/ - (.*)/s).map(s => s.trim().toLowerCase());

    const queries = [
      `track:"${title}" artist:"${artist}"`, 
      `track:"${title}"`,
      `artist:"${artist}"`,
      `${title} ${artist}`, 
    ];

    for (const query of queries) {
      const results = await spotifyApi.search(query, ['track'], { limit: 5, market: 'BR' });

      const match = results.body.tracks.items.find(item => {
        const itemTitle = item.name.toLowerCase();
        const itemArtist = item.artists.map(a => a.name.toLowerCase()).join(' ');
        return (
          (itemTitle.includes(title) || title.includes(itemTitle)) &&
          (itemArtist.includes(artist) || artist.includes(itemArtist))
        );
      });

      if (match && !usedTracks.has(match.uri)) {
        usedTracks.add(match.uri);
        return match.uri;
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

    const uris = (await Promise.all(tracks.slice(0, 10).map(searchTrack))).filter(uri => uri).slice(0, 10);

    if (uris.length < 3) {
      return { success: false, message: 'Não foi possível encontrar músicas suficientes para criar a playlist.' };
    }

    const playlistName = `MoodTunes: ${new Date().toLocaleDateString('pt-BR')}`;
    const playlist = await spotifyApi.createPlaylist(playlistName, { public: true, description: `Playlist gerada automaticamente pelo MoodTunes para o humor: ${mood}` });
    await spotifyApi.addTracksToPlaylist(playlist.body.id, uris);

    return {
      success: true,
      message: getMoodMessage(mood),
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


app.get('/auth', (req, res) => res.redirect(spotifyApi.createAuthorizeURL(['playlist-modify-public', 'user-read-private'], 'state')));

app.get('/check', (req, res) => {
  if (spotifyTokens.accessToken) {
    res.json({ isAuthenticated: true }); 
  } else {
    res.status(401).json({ isAuthenticated: false }); 
  }
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

const checkSpotifyAuth = async (req, res, next) => {
  try {
    if (Date.now() >= spotifyTokens.expiresAt) {
      const data = await spotifyApi.refreshAccessToken();
      spotifyApi.setAccessToken(data.body.access_token);
      spotifyTokens = { accessToken: data.body.access_token, expiresAt: Date.now() + (data.body.expires_in * 1000) };
    }
    next();
  } catch (error) {
    console.error('Erro de autenticação:', error);
    res.status(401).json({ error: 'Reautenticação necessária' });
  }
};

app.post('/playlist', checkSpotifyAuth, async (req, res) => {
  try {
    const { mood, tracks } = req.body;

    if (typeof mood !== 'string' || mood.trim().length === 0) {
      return res.status(400).json({ error: 'Campo mood ausente ou inválido' });
    }
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ error: 'Formato inválido para tracks. Deve ser um array de strings.' });
    }

    const uris = (await Promise.all(tracks.slice(0, 10).map(searchTrack))).filter(uri => uri).slice(0, 10);
    if (uris.length < 3) return res.status(404).json({ error: 'Músicas não encontradas', found: uris.length, required: 3 });

    const playlistName = `MoodTunes: ${new Date().toLocaleDateString('pt-BR')}`;
    const playlist = await spotifyApi.createPlaylist(playlistName, { public: true, description: `Playlist gerada automaticamente pelo MoodTunes para o humor: ${mood}` });
    await spotifyApi.addTracksToPlaylist(playlist.body.id, uris);

    res.json({ success: true, message: getMoodMessage(mood), playlist: { name: playlistName, url: playlist.body.external_urls.spotify, id: playlist.body.id, trackCount: uris.length, mood } });
  } catch (error) {
    console.error('Erro crítico:', error.stack);
    res.status(error.statusCode || 500).json({ error: 'Falha na criação da playlist', details: error.body?.error || error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));