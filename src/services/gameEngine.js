import prisma from '../../prisma.js';
import { persistGameSession } from '../../services/analytics.js';
import { socketHandler } from '../middleware/errorHandler.js';

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

export { SAMPLE_QUIZZES };

// rooms[code] = room state; socketMeta[socketId] = { roomCode, role }
const rooms = {};
const socketMeta = {};

// Stale room cleanup — removes rooms inactive for >30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [code, room] of Object.entries(rooms)) {
    if (room.createdAt < cutoff && room.phase !== 'question') {
      clearTimeout(room.timer);
      delete rooms[code];
    }
  }
}, 10 * 60 * 1000);

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function calcScore(correct, timeMs, timeLimitMs) {
  if (!correct) return 0;
  const speedRatio = Math.max(0, 1 - timeMs / timeLimitMs);
  return Math.round(500 + 500 * speedRatio);
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

async function findQuiz(quizId) {
  const sample = SAMPLE_QUIZZES.find(q => q.id === quizId);
  if (sample) return sample;
  const dbQuiz = await prisma.quiz.findUnique({
    where: { id: quizId },
    include: { questions: { orderBy: { order: 'asc' } } },
  });
  return dbQuiz ? normaliseQuiz(dbQuiz) : null;
}

function startNextQuestion(io, code) {
  const room = rooms[code];
  if (!room) return;
  room.currentQ++;
  if (room.currentQ >= room.quiz.questions.length) return endGame(io, code);

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

  room.timer = setTimeout(() => showQuestionResult(io, code), q.timeLimit);
}

function showQuestionResult(io, code) {
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

  setTimeout(() => startNextQuestion(io, code), 5000);
}

async function endGame(io, code) {
  const room = rooms[code];
  if (!room) return;
  room.phase = 'ended';

  const leaderboard = Object.values(room.players)
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);

  io.to(code).emit('game:ended', { leaderboard, reason: 'complete' });

  if (!room.quiz.isBuiltIn) {
    persistGameSession({
      roomCode: code,
      quizId: room.quiz.id,
      teacherId: room.teacherId,
      players: Object.values(room.players),
    }).catch(e => console.error('persistGameSession error:', e.message));
  }

  delete rooms[code];
}

export function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    socket.on('host:create', socketHandler(async ({ quizId, hostName, teacherId }) => {
      const quiz = await findQuiz(quizId);
      if (!quiz) return socket.emit('error', 'Quiz not found');

      const code = generateRoomCode();
      rooms[code] = {
        code, quiz,
        host: socket.id,
        hostName: String(hostName).slice(0, 50),
        teacherId: teacherId || null,
        players: {},
        phase: 'lobby',
        currentQ: -1,
        questionStart: null,
        answerCount: 0,
        timer: null,
        mode: 'host',
        createdAt: Date.now(),
      };
      socketMeta[socket.id] = { roomCode: code, role: 'host' };
      socket.join(code);
      socket.emit('host:created', { code, quiz });
    }));

    socket.on('player:join', socketHandler(({ code, playerName }) => {
      const room = rooms[code];
      if (!room) return socket.emit('error', 'Room not found');
      if (room.phase !== 'lobby') return socket.emit('error', 'Game already started');

      const safeName = String(playerName).trim().slice(0, 30) || 'Player';
      room.players[socket.id] = { name: safeName, score: 0, answers: [], ready: false };
      socketMeta[socket.id] = { roomCode: code, role: 'player' };
      socket.join(code);

      socket.emit('player:joined', {
        code,
        quiz: { title: room.quiz.title, questionCount: room.quiz.questions.length },
        mode: room.mode,
      });

      io.to(code).emit('room:players', {
        players: Object.values(room.players).map(p => ({ name: p.name, score: p.score })),
      });
    }));

    socket.on('host:start', socketHandler(({ code }) => {
      const room = rooms[code];
      if (!room || room.host !== socket.id) return;
      if (Object.keys(room.players).length === 0) return socket.emit('error', 'Need at least one player');
      startNextQuestion(io, code);
    }));

    socket.on('player:answer', socketHandler(({ code, answerIndex }) => {
      const room = rooms[code];
      if (!room || room.phase !== 'question') return;
      const player = room.players[socket.id];
      if (!player) return;

      const q = room.quiz.questions[room.currentQ];
      if (player.answers.length > room.currentQ) return; // already answered

      const idx = Number(answerIndex);
      if (isNaN(idx) || idx < 0 || idx > 3) return;

      const timeMs = Date.now() - room.questionStart;
      const correct = idx === q.correct;
      const points = calcScore(correct, timeMs, q.timeLimit);

      player.score += points;
      player.answers.push({ answerIndex: idx, correct, points, timeMs });
      room.answerCount++;

      socket.emit('player:answer_ack', { correct, points, totalScore: player.score });

      if (room.answerCount >= Object.keys(room.players).length) {
        clearTimeout(room.timer);
        showQuestionResult(io, code);
      }
    }));

    socket.on('player:reconnect', socketHandler(({ code, playerName }) => {
      const room = rooms[code];
      if (!room) return socket.emit('error', 'Room not found');

      const existingEntry = Object.entries(room.players).find(([, p]) => p.name === playerName);
      if (!existingEntry) return socket.emit('error', 'Player not found in room');

      const [oldSocketId, playerData] = existingEntry;
      delete room.players[oldSocketId];
      room.players[socket.id] = playerData;
      socketMeta[socket.id] = { roomCode: code, role: 'player' };
      socket.join(code);

      socket.emit('player:reconnected', {
        score: playerData.score,
        currentQ: room.currentQ,
        phase: room.phase,
      });
    }));

    socket.on('disconnect', () => {
      const info = socketMeta[socket.id];
      if (!info) return;
      const { roomCode } = info;
      const room = rooms[roomCode];
      if (!room) return;
      delete socketMeta[socket.id];

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
}
