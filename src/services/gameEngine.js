import prisma from '../../prisma.js';
import { persistGameSession } from '../../services/analytics.js';
import { socketHandler } from '../middleware/errorHandler.js';

// ── Sample quizzes using new polymorphic question format ─────────────────────
const SAMPLE_QUIZZES = [
  {
    id: 'sample_1',
    title: 'General Knowledge',
    category: 'General',
    isBuiltIn: true,
    questions: [
      { id: 's1q1', text: 'What is the capital of France?', type: 'multiple_choice', questionData: { options: ['London', 'Berlin', 'Paris', 'Madrid'], correctIndex: 2 }, timeLimit: 20000, points: 1000 },
      { id: 's1q2', text: 'The Great Wall of China is visible from space.', type: 'true_false', questionData: { correctAnswer: false }, timeLimit: 15000, points: 1000 },
      { id: 's1q3', text: 'Who wrote Romeo and Juliet?', type: 'type_answer', questionData: { acceptedAnswers: ['Shakespeare', 'William Shakespeare', 'W. Shakespeare'], caseSensitive: false }, timeLimit: 25000, points: 1000 },
      { id: 's1q4', text: 'What is the largest ocean?', type: 'multiple_choice', questionData: { options: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], correctIndex: 3 }, timeLimit: 20000, points: 1000 },
      { id: 's1q5', text: 'What element has the symbol "Au"?', type: 'type_answer', questionData: { acceptedAnswers: ['Gold', 'gold'], caseSensitive: false }, timeLimit: 20000, points: 1000 },
    ],
  },
  {
    id: 'sample_2',
    title: 'Science & Tech',
    category: 'Science',
    isBuiltIn: true,
    questions: [
      { id: 's2q1', text: 'What does CPU stand for?', type: 'multiple_choice', questionData: { options: ['Central Power Unit', 'Central Processing Unit', 'Core Processing Unit', 'Central Program Utility'], correctIndex: 1 }, timeLimit: 15000, points: 1000 },
      { id: 's2q2', text: 'HTML is a programming language.', type: 'true_false', questionData: { correctAnswer: false }, timeLimit: 15000, points: 1000 },
      { id: 's2q3', text: 'Who founded Microsoft?', type: 'type_answer', questionData: { acceptedAnswers: ['Bill Gates', 'Gates', 'Bill Gates and Paul Allen'], caseSensitive: false }, timeLimit: 20000, points: 1000 },
      { id: 's2q4', text: 'What does HTTP stand for?', type: 'multiple_choice', questionData: { options: ['HyperText Transfer Protocol', 'High Transfer Tech Protocol', 'HyperText Tech Program', 'High Text Transfer Protocol'], correctIndex: 0 }, timeLimit: 15000, points: 1000 },
      { id: 's2q5', text: 'Mars is the closest planet to the Sun.', type: 'true_false', questionData: { correctAnswer: false }, timeLimit: 15000, points: 1000 },
    ],
  },
  {
    id: 'sample_3',
    title: 'Sports Trivia',
    category: 'Sports',
    isBuiltIn: true,
    questions: [
      { id: 's3q1', text: 'How many players in a soccer team on the field?', type: 'slider', questionData: { min: 5, max: 15, step: 1, correctValue: 11, tolerance: 0 }, timeLimit: 15000, points: 1000 },
      { id: 's3q2', text: 'How many rings are on the Olympic flag?', type: 'multiple_choice', questionData: { options: ['4', '5', '6', '7'], correctIndex: 1 }, timeLimit: 15000, points: 1000 },
      { id: 's3q3', text: 'Basketball was invented in Canada.', type: 'true_false', questionData: { correctAnswer: true }, timeLimit: 15000, points: 1000 },
      { id: 's3q4', text: 'How many holes in a standard golf course?', type: 'type_answer', questionData: { acceptedAnswers: ['18', 'eighteen'], caseSensitive: false }, timeLimit: 15000, points: 1000 },
      { id: 's3q5', text: 'What is your favorite sport?', type: 'poll', questionData: { options: ['Soccer', 'Basketball', 'Tennis', 'Swimming'] }, timeLimit: 15000, points: 0 },
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

// ── Normalise a DB quiz into the in-memory format ───────────────────────────
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
      type: q.type || 'multiple_choice',
      questionData: q.questionData || {},
      timeLimit: q.timeLimit,
      points: q.points || 1000,
      imageUrl: q.imageUrl || null,
    })),
  };
}

// ── Fisher-Yates shuffle (used for ordering questions) ──────────────────────
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Strip correct answers from questionData before sending to players ───────
function getPlayerQuestionData(q) {
  const d = q.questionData;
  switch (q.type) {
    case 'multiple_choice':
      return { options: d.options };
    case 'true_false':
      return {};
    case 'type_answer':
      return { caseSensitive: d.caseSensitive ?? false };
    case 'slider':
      return { min: d.min, max: d.max, step: d.step };
    case 'poll':
      return { options: d.options };
    case 'ordering':
      return { items: shuffleArray(d.items) };
    default:
      return {};
  }
}

// ── Type-aware scoring ──────────────────────────────────────────────────────
function calcScore(type, questionData, answer, timeMs, timeLimitMs, maxPoints) {
  // Polls never score
  if (type === 'poll') return { points: 0, correct: false, accuracy: 0 };

  let correct = false;
  let accuracy = 0; // 0..1 for partial-credit types

  switch (type) {
    case 'multiple_choice':
      correct = answer.index === questionData.correctIndex;
      accuracy = correct ? 1 : 0;
      break;

    case 'true_false':
      correct = answer.value === questionData.correctAnswer;
      accuracy = correct ? 1 : 0;
      break;

    case 'type_answer': {
      const playerText = String(answer.text || '').trim();
      const caseSensitive = questionData.caseSensitive ?? false;
      correct = (questionData.acceptedAnswers || []).some(accepted => {
        if (caseSensitive) return playerText === accepted;
        return playerText.toLowerCase() === accepted.toLowerCase();
      });
      accuracy = correct ? 1 : 0;
      break;
    }

    case 'slider': {
      const dist = Math.abs(answer.value - questionData.correctValue);
      const tolerance = questionData.tolerance ?? 0;
      if (dist <= tolerance) {
        correct = true;
        accuracy = 1;
      } else {
        // Partial credit based on proximity within the range
        const range = Math.abs(questionData.max - questionData.min);
        accuracy = Math.max(0, 1 - (dist - tolerance) / range);
        correct = false;
      }
      break;
    }

    case 'ordering': {
      const correctOrder = questionData.correctOrder;
      const playerOrder = answer.order || [];
      if (playerOrder.length !== correctOrder.length) {
        accuracy = 0;
        break;
      }
      let matching = 0;
      for (let i = 0; i < correctOrder.length; i++) {
        if (playerOrder[i] === correctOrder[i]) matching++;
      }
      accuracy = matching / correctOrder.length;
      correct = accuracy === 1;
      break;
    }

    default:
      accuracy = 0;
  }

  // Score formula: base 50% + speed bonus 50%, multiplied by accuracy
  const speedRatio = Math.max(0, 1 - timeMs / timeLimitMs);
  const points = Math.round((maxPoints / 2 + (maxPoints / 2) * speedRatio) * accuracy);
  return { points, correct, accuracy };
}

// ── Validate that the answer payload matches the question type ───────────────
function validateAnswer(type, answer) {
  if (!answer || typeof answer !== 'object') return false;
  switch (type) {
    case 'multiple_choice':
      return typeof answer.index === 'number' && Number.isFinite(answer.index);
    case 'true_false':
      return typeof answer.value === 'boolean';
    case 'type_answer':
      return typeof answer.text === 'string';
    case 'slider':
      return typeof answer.value === 'number' && Number.isFinite(answer.value);
    case 'poll':
      return typeof answer.index === 'number' && Number.isFinite(answer.index);
    case 'ordering':
      return Array.isArray(answer.order);
    default:
      return false;
  }
}

// ── Compute poll vote distribution ──────────────────────────────────────────
function computePollResults(room, qIndex) {
  const q = room.quiz.questions[qIndex];
  const options = q.questionData.options || [];
  const counts = new Array(options.length).fill(0);

  for (const player of Object.values(room.players)) {
    const ans = player.answers[qIndex];
    if (ans && typeof ans.answerData?.index === 'number' && ans.answerData.index < options.length) {
      counts[ans.answerData.index]++;
    }
  }

  return options.map((label, i) => ({ label, count: counts[i] }));
}

// ── Quiz lookup ─────────────────────────────────────────────────────────────
async function findQuiz(quizId) {
  const sample = SAMPLE_QUIZZES.find(q => q.id === quizId);
  if (sample) return sample;
  const dbQuiz = await prisma.quiz.findUnique({
    where: { id: quizId },
    include: { questions: { orderBy: { order: 'asc' } } },
  });
  return dbQuiz ? normaliseQuiz(dbQuiz) : null;
}

// ── Advance to the next question ────────────────────────────────────────────
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
    type: q.type,
    questionData: getPlayerQuestionData(q),
    timeLimit: q.timeLimit,
    points: q.points,
    imageUrl: q.imageUrl,
  });

  room.timer = setTimeout(() => showQuestionResult(io, code), q.timeLimit);
}

// ── Show results after a question ends ──────────────────────────────────────
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
    type: q.type,
    questionData: q.questionData, // Full data WITH answers for result display
    leaderboard: [...playerResults].sort((a, b) => b.score - a.score),
    isLast: room.currentQ === room.quiz.questions.length - 1,
    // For polls, include vote distribution
    ...(q.type === 'poll' && { pollResults: computePollResults(room, room.currentQ) }),
  });

  setTimeout(() => startNextQuestion(io, code), 5000);
}

// ── End game and persist results ────────────────────────────────────────────
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

// ── Socket.io handler registration ──────────────────────────────────────────
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

    // ── Type-aware answer handler ─────────────────────────────────────────
    socket.on('player:answer', socketHandler(({ code, answer }) => {
      const room = rooms[code];
      if (!room || room.phase !== 'question') return;
      const player = room.players[socket.id];
      if (!player) return;

      const q = room.quiz.questions[room.currentQ];
      if (player.answers.length > room.currentQ) return; // already answered

      // Validate the answer format against the question type
      if (!validateAnswer(q.type, answer)) return;

      const timeMs = Date.now() - room.questionStart;
      const { points, correct, accuracy } = calcScore(
        q.type, q.questionData, answer, timeMs, q.timeLimit, q.points
      );

      player.score += points;
      player.answers.push({ answerData: answer, correct, points, timeMs, accuracy });
      room.answerCount++;

      socket.emit('player:answer_ack', { correct, points, totalScore: player.score, accuracy });

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
