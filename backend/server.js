const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const SpotifyWebApi = require('spotify-web-api-node');
require('dotenv').config();

const app = express();

const corsOptions = {
  origin: ['http://localhost:5174','http://localhost:3000', 'https://moodtunes-frontend.onrender.com'],
  methods: 'GET,POST,PUT,DELETE,OPTIONS',
  allowedHeaders: 'Content-Type,Authorization',
  credentials: true,
  optionsSuccessStatus: 204
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
        2. Conversar com o usuário para entender como ele está se sentindo hoje.
        3. Após entender o humor do usuário, diga que está gerando uma playlist especialmente para ele.
        `;
      chatSessions.set(userId, { chat: model.startChat({ history: [{ role: 'user', parts: [{ text: initialPrompt }] }] }), interactionCount: 0 });
    }

    const session = chatSessions.get(userId);
    const result = await session.chat.sendMessage(message);
    const responseText = await result.response.text();
    session.interactionCount++;

    if (session.interactionCount >= 3) {
      const parsed = parseGeminiResponse(responseText);
      if (parsed) {
        chatSessions.delete(userId);
        return res.json({ action: 'create_playlist', data: { message: parsed.message, mood: parsed.mood, tracks: parsed.tracks } });
      }
    }

    res.json({ action: 'continue_chat', response: responseText });
  } catch (error) {
    console.error('Erro no chat:', error);
    res.status(500).json({ error: 'Erro na conversação' });
  }
});

app.get('/spotify/auth', (req, res) => res.redirect(spotifyApi.createAuthorizeURL(['playlist-modify-public', 'user-read-private'], 'state')));

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
  
     
      res.redirect('http://localhost:5174');
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

app.post('/create/playlist', checkSpotifyAuth, async (req, res) => {
  try {
    const { mood, tracks } = req.body;
    if (!mood || typeof mood !== 'string') return res.status(400).json({ error: 'Campo mood ausente ou inválido' });
    if (!tracks || !Array.isArray(tracks)) return res.status(400).json({ error: 'Formato inválido para tracks' });

    const searchTrack = async (track) => {
      const [title, artist] = track.split(/ - (.*)/s).map(s => s.trim());
      const queries = [`track:"${title}" artist:"${artist}"`, `track:"${title}"`, `artist:"${artist}"`];
      for (const query of queries) {
        const results = await spotifyApi.search(query, ['track'], { limit: 3, market: 'BR' });
        const exactMatch = results.body.tracks.items.find(item => item.artists.some(a => a.name.toLowerCase() === artist.toLowerCase()) && item.name.toLowerCase() === title.toLowerCase());
        if (exactMatch) return exactMatch.uri;
      }
      return null;
    };

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

app.get('/check/auth', (req, res) => {
    if (spotifyTokens.accessToken) {
      res.json({ isAuthenticated: true });
    } else {
      res.status(401).json({ isAuthenticated: false });
    }
  });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));