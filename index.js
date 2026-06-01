require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const mammoth = require('mammoth');

const { getPrisma } = require('./prisma');
const analyticsRouter = require('./routes/analytics');
const leaderboardRouter = require('./routes/leaderboard');
const { persistGameSession } = require('./services/analytics');

const JWT_SECRET = process.env.JWT_SECRET || 'quizblitz_dev_secret';

// ── Express + Socket.io setup ─────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'DELETE', 'PUT'] },
});

// ── Multer (memory storage for uploads) ──────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── In-memory game state ──────────────────────────────────────────────────────
const rooms = {};
const sockets = {};

// ── Built-in sample quizzes (always available without DB) ─────────────────────
const SAMPLE_QUIZZES = [
  {
    id: 'sample_1',
    title: 'General Knowledge',
    category: 'General',
    isBuiltIn: true,
    questions: [
      { id: 's1q1', text: 'What is the capital of France?', timeLimit: 20000, options: ['London', 'Berlin', 'Paris', 'Madrid'], correct: 2 },
      { id: 's1q2', text: 'How many planets are in our solar system?', timeLimit: 20000, options: ['7', '8', '9', '10'], correct: 1 },
      { id: 's1q3', text: 'Who wrote Romeo and Juliet?', timeLimit: 20000, options: ['Dickens', 'Shakespeare', 'Tolstoy', 'Hemingway'], correct: 1 },
      { id: 's1q4', text: 'What is the largest ocean?', timeLimit: 20000, options: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], correct: 3 },
      { id: 's1q5', text: 'What element has symbol "Au"?', timeLimit: 20000, options: ['Silver', 'Copper', 'Gold', 'Iron'], correct: 2 },
    ],
  },
  {
    id: 'sample_2',
    title: 'Science & Tech',
    category: 'Science',
    isBuiltIn: true,
    questions: [
      { id: 's2q1', text: 'What does CPU stand for?', timeLimit: 15000, options: ['Central Power Unit', 'Central Processing Unit', 'Core Processing Unit', 'Central Program Utility'], correct: 1 },
      { id: 's2q2', text: 'What language is used for web styling?', timeLimit: 15000, options: ['HTML', 'Python', 'CSS', 'Java'], correct: 2 },
      { id: 's2q3', text: 'Who founded Microsoft?', timeLimit: 15000, options: ['Steve Jobs', 'Elon Musk', 'Bill Gates', 'Jeff Bezos'], correct: 2 },
      { id: 's2q4', text: 'What does HTTP stand for?', timeLimit: 15000, options: ['HyperText Transfer Protocol', 'High Transfer Tech Protocol', 'HyperText Tech Program', 'High Text Transfer Protocol'], correct: 0 },
      { id: 's2q5', text: 'Which planet is the Red Planet?', timeLimit: 15000, options: ['Venus', 'Jupiter', 'Mars', 'Saturn'], correct: 2 },
    ],
  },
  {
    id: 'sample_3',
    title: 'Sports',
    category: 'Sports',
    isBuiltIn: true,
    questions: [
      { id: 's3q1', text: 'How many players in a soccer team on the field?', timeLimit: 15000, options: ['9', '10', '11', '12'], correct: 2 },
      { id: 's3q2', text: 'How many rings on the Olympic flag?', timeLimit: 15000, options: ['4', '5', '6', '7'], correct: 1 },
      { id: 's3q3', text: 'Which country invented basketball?', timeLimit: 15000, options: ['UK', 'Australia', 'USA', 'Canada'], correct: 3 },
      { id: 's3q4', text: 'How many holes in a standard golf course?', timeLimit: 15000, options: ['12', '16', '18', '20'], correct: 2 },
      { id: 's3q5', text: 'In tennis, what is a "love" score?', timeLimit: 15000, options: ['1', '0', '15', '30'], correct: 1 },
    ],
  },
];

// ── Auth middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    req.teacher = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Mount routers ─────────────────────────────────────────────────────────────
app.use('/api/analytics', analyticsRouter);
app.use('/api/leaderboard', leaderboardRouter);

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  const { email, name, password } = req.body;
  if (!email || !name || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const existing = await db.teacher.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const teacher = await db.teacher.create({ data: { email, name, password: hashed } });
    const token = jwt.sign({ id: teacher.id, email: teacher.email, name: teacher.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, teacher: { id: teacher.id, email: teacher.email, name: teacher.name } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const teacher = await db.teacher.findUnique({ where: { email } });
    if (!teacher) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, teacher.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: teacher.id, email: teacher.email, name: teacher.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, teacher: { id: teacher.id, email: teacher.email, name: teacher.name } });
  } catch (e) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  res.json({ teacher: req.teacher });
});

// ─────────────────────────────────────────────────────────────────────────────
// QUIZ ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/quizzes', async (req, res) => {
  res.json(SAMPLE_QUIZZES);
});

app.get('/api/teacher/quizzes', authMiddleware, async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.json([]);

  try {
    const quizzes = await db.quiz.findMany({
      where: { teacherId: req.teacher.id },
      include: {
        questions: { orderBy: { order: 'asc' } },
        _count: { select: { questions: true, sessions: true } },
        analytics: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(quizzes.map(q => ({
      ...normaliseQuiz(q),
      sessionsPlayed: q._count.sessions,
      analytics: q.analytics ?? null,
    })));
  } catch (e) {
    res.status(500).json({ error: 'Failed to load quizzes' });
  }
});

app.post('/api/teacher/quizzes', authMiddleware, async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  const { title, category, questions } = req.body;
  if (!title || !questions?.length) return res.status(400).json({ error: 'Title and questions required' });

  const validationError = validateQuestions(questions);
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    const quiz = await db.quiz.create({
      data: {
        title,
        category: category || null,
        teacherId: req.teacher.id,
        questions: {
          create: questions.map((q, i) => ({
            text: q.text,
            options: q.options,
            correct: Number(q.correct),
            timeLimit: q.timeLimit || 20000,
            order: i,
          })),
        },
      },
      include: { questions: { orderBy: { order: 'asc' } } },
    });
    res.json(normaliseQuiz(quiz));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create quiz' });
  }
});

app.delete('/api/teacher/quizzes/:id', authMiddleware, async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const quiz = await db.quiz.findUnique({ where: { id: req.params.id } });
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    if (quiz.teacherId !== req.teacher.id) return res.status(403).json({ error: 'Not your quiz' });
    await db.quiz.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete quiz' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BULK IMPORT ROUTE
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/teacher/quizzes/import', authMiddleware, upload.single('file'), async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  let parsed;

  try {
    if (ext === '.json') parsed = parseJSON(req.file.buffer);
    else if (ext === '.csv') parsed = parseCSV(req.file.buffer);
    else if (ext === '.xlsx' || ext === '.xls') parsed = parseExcel(req.file.buffer);
    else if (ext === '.docx' || ext === '.doc') parsed = await parseDOCX(req.file.buffer);
    else return res.status(400).json({ error: 'Unsupported file type. Use JSON, CSV, XLSX, or DOCX.' });
  } catch (e) {
    return res.status(400).json({ error: `Parse error: ${e.message}` });
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return res.status(400).json({ error: 'No quizzes found in file' });
  }

  const created = [];
  const errors = [];

  for (const quizData of parsed) {
    if (!quizData.title || !quizData.questions?.length) {
      errors.push(`Skipped quiz "${quizData.title || '(no title)'}" — missing title or questions`);
      continue;
    }
    const validationError = validateQuestions(quizData.questions);
    if (validationError) { errors.push(`Quiz "${quizData.title}": ${validationError}`); continue; }
    try {
      const quiz = await db.quiz.create({
        data: {
          title: quizData.title,
          category: quizData.category || null,
          teacherId: req.teacher.id,
          questions: {
            create: quizData.questions.map((q, i) => ({
              text: q.text, options: q.options,
              correct: Number(q.correct), timeLimit: q.timeLimit || 20000, order: i,
            })),
          },
        },
        include: { questions: { orderBy: { order: 'asc' } } },
      });
      created.push(normaliseQuiz(quiz));
    } catch (e) {
      errors.push(`Quiz "${quizData.title}": DB error — ${e.message}`);
    }
  }

  res.json({ imported: created.length, quizzes: created, errors });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE DOWNLOADS
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATE_DATA = [
  {
    title: 'My Quiz Title',
    category: 'Science',
    questions: [
      { text: 'What is 2+2?', options: ['1', '2', '3', '4'], correct: 3, timeLimit: 15000 },
      { text: 'Capital of Japan?', options: ['Beijing', 'Seoul', 'Tokyo', 'Bangkok'], correct: 2, timeLimit: 20000 },
    ],
  },
];

app.get('/api/templates/json', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="quiz_template.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(TEMPLATE_DATA, null, 2));
});

app.get('/api/templates/csv', (req, res) => {
  const rows = [
    'quiz_title,category,question,option_a,option_b,option_c,option_d,correct_index,time_limit_ms',
    'My Quiz Title,Science,What is 2+2?,1,2,3,4,3,15000',
    'My Quiz Title,Science,Capital of Japan?,Beijing,Seoul,Tokyo,Bangkok,2,20000',
  ].join('\n');
  res.setHeader('Content-Disposition', 'attachment; filename="quiz_template.csv"');
  res.setHeader('Content-Type', 'text/csv');
  res.send(rows);
});

app.get('/api/templates/xlsx', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['quiz_title', 'category', 'question', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_index', 'time_limit_ms'],
    ['My Quiz Title', 'Science', 'What is 2+2?', '1', '2', '3', '4', 3, 15000],
    ['My Quiz Title', 'Science', 'Capital of Japan?', 'Beijing', 'Seoul', 'Tokyo', 'Bangkok', 2, 20000],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Quizzes');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="quiz_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('/api/templates/docx', (req, res) => {
  const text = `QUIZ: My Quiz Title\nCATEGORY: Science\n\nQ: What is 2+2?\nA: 1\nB: 2\nC: 3\nD: 4\nCORRECT: D\nTIME: 15000\n\nQ: Capital of Japan?\nA: Beijing\nB: Seoul\nC: Tokyo\nD: Bangkok\nCORRECT: C\nTIME: 20000\n`;
  res.setHeader('Content-Disposition', 'attachment; filename="quiz_template.txt"');
  res.setHeader('Content-Type', 'text/plain');
  res.send(text);
});

// ─────────────────────────────────────────────────────────────────────────────
// PARSE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function parseJSON(buffer) {
  const data = JSON.parse(buffer.toString('utf8'));
  return Array.isArray(data) ? data : [data];
}

function parseCSV(buffer) {
  const rows = parse(buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  const quizMap = {};
  for (const row of rows) {
    const title = row.quiz_title || row.title;
    if (!title) continue;
    if (!quizMap[title]) quizMap[title] = { title, category: row.category || null, questions: [] };
    quizMap[title].questions.push({
      text: row.question,
      options: [row.option_a, row.option_b, row.option_c, row.option_d],
      correct: parseInt(row.correct_index, 10),
      timeLimit: parseInt(row.time_limit_ms, 10) || 20000,
    });
  }
  return Object.values(quizMap);
}

function parseExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  const quizMap = {};
  for (const row of rows) {
    const title = row.quiz_title || row.title;
    if (!title) continue;
    if (!quizMap[title]) quizMap[title] = { title, category: row.category || null, questions: [] };
    quizMap[title].questions.push({
      text: row.question,
      options: [row.option_a, row.option_b, row.option_c, row.option_d].map(String),
      correct: parseInt(row.correct_index, 10),
      timeLimit: parseInt(row.time_limit_ms, 10) || 20000,
    });
  }
  return Object.values(quizMap);
}

async function parseDOCX(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value;
  const quizzes = [];
  let currentQuiz = null;
  let currentQ = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toUpperCase().startsWith('QUIZ:')) {
      if (currentQuiz) { if (currentQ) { currentQuiz.questions.push(currentQ); currentQ = null; } quizzes.push(currentQuiz); }
      currentQuiz = { title: line.slice(5).trim(), category: null, questions: [] };
    } else if (line.toUpperCase().startsWith('CATEGORY:')) {
      if (currentQuiz) currentQuiz.category = line.slice(9).trim();
    } else if (line.toUpperCase().startsWith('Q:')) {
      if (currentQ && currentQuiz) currentQuiz.questions.push(currentQ);
      currentQ = { text: line.slice(2).trim(), options: [], correct: 0, timeLimit: 20000 };
    } else if (/^[A-D]:/i.test(line) && currentQ) {
      currentQ.options.push(line.slice(2).trim());
    } else if (line.toUpperCase().startsWith('CORRECT:') && currentQ) {
      const letter = line.slice(8).trim().toUpperCase();
      currentQ.correct = ['A', 'B', 'C', 'D'].indexOf(letter);
    } else if (line.toUpperCase().startsWith('TIME:') && currentQ) {
      currentQ.timeLimit = parseInt(line.slice(5).trim(), 10) || 20000;
    }
  }
  if (currentQ && currentQuiz) currentQuiz.questions.push(currentQ);
  if (currentQuiz) quizzes.push(currentQuiz);
  return quizzes;
}

function validateQuestions(questions) {
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q.text?.trim()) return `Question ${i + 1}: text is required`;
    if (!Array.isArray(q.options) || q.options.length !== 4) return `Question ${i + 1}: must have exactly 4 options`;
    if (q.options.some(o => !String(o).trim())) return `Question ${i + 1}: all options must be non-empty`;
    const c = Number(q.correct);
    if (isNaN(c) || c < 0 || c > 3) return `Question ${i + 1}: correct must be 0–3`;
  }
  return null;
}

function normaliseQuiz(dbQuiz) {
  return {
    id: dbQuiz.id,
    title: dbQuiz.title,
    category: dbQuiz.category,
    teacherId: dbQuiz.teacherId,
    createdAt: dbQuiz.createdAt,
    questions: (dbQuiz.questions || []).map(q => ({
      id: q.id,
      text: q.text,
      options: q.options,
      correct: q.correct,
      timeLimit: q.timeLimit,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET.IO — game engine
// ─────────────────────────────────────────────────────────────────────────────

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function calcScore(correct, timeMs, timeLimitMs) {
  if (!correct) return 0;
  const speedRatio = Math.max(0, 1 - timeMs / timeLimitMs);
  return Math.round(500 + 500 * speedRatio);
}

async function findQuiz(quizId) {
  const sample = SAMPLE_QUIZZES.find(q => q.id === quizId);
  if (sample) return sample;
  const db = await getPrisma();
  if (!db) return null;
  const dbQuiz = await db.quiz.findUnique({
    where: { id: quizId },
    include: { questions: { orderBy: { order: 'asc' } } },
  });
  return dbQuiz ? normaliseQuiz(dbQuiz) : null;
}

io.on('connection', (socket) => {
  console.log('connect:', socket.id);

  socket.on('host:create', async ({ quizId, hostName, teacherId }) => {
    const quiz = await findQuiz(quizId);
    if (!quiz) return socket.emit('error', 'Quiz not found');

    const code = generateRoomCode();
    rooms[code] = {
      code, quiz, host: socket.id, hostName,
      teacherId: teacherId || null,
      players: {}, phase: 'lobby', currentQ: -1,
      questionStart: null, answerCount: 0, timer: null, mode: 'host',
    };
    sockets[socket.id] = { roomCode: code, playerName: hostName, role: 'host' };
    socket.join(code);
    socket.emit('host:created', { code, quiz });
    console.log(`Room ${code} created by ${hostName}`);
  });

  socket.on('player:join', ({ code, playerName }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', 'Room not found');
    if (room.phase !== 'lobby') return socket.emit('error', 'Game already started');

    room.players[socket.id] = { name: playerName, score: 0, answers: [], ready: false };
    sockets[socket.id] = { roomCode: code, playerName, role: 'player' };
    socket.join(code);

    socket.emit('player:joined', {
      code,
      quiz: { title: room.quiz.title, questionCount: room.quiz.questions.length },
      mode: room.mode,
    });

    io.to(code).emit('room:players', {
      players: Object.values(room.players).map(p => ({ name: p.name, score: p.score })),
    });
    console.log(`${playerName} joined room ${code}`);
  });

  socket.on('host:start', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (Object.keys(room.players).length === 0) return socket.emit('error', 'Need at least one player');
    startNextQuestion(code);
  });

  socket.on('player:answer', ({ code, answerIndex }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'question') return;
    const player = room.players[socket.id];
    if (!player) return;

    const q = room.quiz.questions[room.currentQ];
    if (player.answers.length > room.currentQ) return;

    const timeMs = Date.now() - room.questionStart;
    const correct = answerIndex === q.correct;
    const points = calcScore(correct, timeMs, q.timeLimit);

    player.score += points;
    player.answers.push({ answerIndex, correct, points, timeMs });
    room.answerCount++;

    socket.emit('player:answer_ack', { correct, points, totalScore: player.score });

    if (room.answerCount >= Object.keys(room.players).length) {
      clearTimeout(room.timer);
      showQuestionResult(code);
    }
  });

  socket.on('disconnect', () => {
    const info = sockets[socket.id];
    if (!info) return;
    const { roomCode } = info;
    const room = rooms[roomCode];
    if (!room) return;
    delete sockets[socket.id];

    if (room.host === socket.id) {
      io.to(roomCode).emit('game:ended', { reason: 'Host disconnected' });
      clearTimeout(room.timer);
      delete rooms[roomCode];
      return;
    }

    delete room.players[socket.id];
    io.to(roomCode).emit('room:players', {
      players: Object.values(room.players).map(p => ({ name: p.name, score: p.score })),
    });
  });
});

function startNextQuestion(code) {
  const room = rooms[code];
  if (!room) return;
  room.currentQ++;
  if (room.currentQ >= room.quiz.questions.length) return endGame(code);

  const q = room.quiz.questions[room.currentQ];
  room.phase = 'question';
  room.questionStart = Date.now();
  room.answerCount = 0;

  io.to(code).emit('game:question', {
    index: room.currentQ,
    total: room.quiz.questions.length,
    text: q.text,
    options: q.options,
    timeLimit: q.timeLimit,
  });

  room.timer = setTimeout(() => showQuestionResult(code), q.timeLimit);
}

function showQuestionResult(code) {
  const room = rooms[code];
  if (!room || room.phase !== 'question') return;
  room.phase = 'result';

  const q = room.quiz.questions[room.currentQ];
  const playerResults = Object.values(room.players).map(p => {
    const ans = p.answers[room.currentQ];
    return { name: p.name, score: p.score, correct: ans?.correct ?? false, points: ans?.points ?? 0 };
  });

  io.to(code).emit('game:result', {
    correctIndex: q.correct,
    leaderboard: [...playerResults].sort((a, b) => b.score - a.score),
    isLast: room.currentQ === room.quiz.questions.length - 1,
  });

  setTimeout(() => startNextQuestion(code), 5000);
}

async function endGame(code) {
  const room = rooms[code];
  if (!room) return;
  room.phase = 'ended';

  const leaderboard = Object.values(room.players)
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

  io.to(code).emit('game:ended', { leaderboard, reason: 'complete' });

  // Persist session and update analytics (non-blocking — don't hold up the client)
  const isBuiltIn = room.quiz.isBuiltIn === true;
  if (!isBuiltIn) {
    persistGameSession({
      roomCode: code,
      quizId: room.quiz.id,
      teacherId: room.teacherId,
      players: Object.values(room.players),
    }).catch(e => console.error('persistGameSession error:', e.message));
  }

  delete rooms[code];
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
