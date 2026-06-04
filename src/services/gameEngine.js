import prisma from '../../prisma.js';
import { persistGameSession } from '../../services/analytics.js';
import { socketHandler } from '../middleware/errorHandler.js';



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
// For multiple_choice we shuffle the options per-question and remember the
// display→original index mapping on the room so submitted indices can be
// translated back before scoring (the correct answer never leaves the server).
function getPlayerQuestionData(q, room) {
  const d = q.questionData;
  if (room) room.optionOrder = null;
  switch (q.type) {
    case 'multiple_choice': {
      const options = d.options || [];
      const order = shuffleArray(options.map((_, i) => i)); // display idx → original idx
      if (room) room.optionOrder = order;
      return { options: order.map(i => options[i]) };
    }
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
      const caseSensitive = questionData.caseSensitive ?? false;
      const normalize = (s) => {
        let t = String(s).trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
        return caseSensitive ? t : t.toLowerCase();
      };
      const playerNorm = normalize(answer.text || '');
      correct = (questionData.acceptedAnswers || []).some(accepted =>
        playerNorm === normalize(accepted)
      );
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
  const db = await prisma.quiz.findUnique({
    where: { id: quizId },
    include: { questions: { orderBy: { order: 'asc' } } },
  });
  return db ? normaliseQuiz(db) : null;
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
    questionData: getPlayerQuestionData(q, room),
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

  // Server-side skip enforcement: any player without a recorded answer for this
  // question is marked incorrect (0 points). This keeps answers[] dense and
  // aligned by question index, and never trusts the client to report a skip.
  for (const p of Object.values(room.players)) {
    if (!p.answers[room.currentQ]) {
      p.answers[room.currentQ] = {
        answerData: null, correct: false, points: 0, timeMs: q.timeLimit, accuracy: 0, skipped: true,
      };
    }
  }

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
      if (player.answers[room.currentQ]) return; // already answered this question

      // Validate the answer format against the question type
      if (!validateAnswer(q.type, answer)) return;

      // Translate a shuffled multiple_choice selection back to the original index
      let scoringAnswer = answer;
      if (q.type === 'multiple_choice' && Array.isArray(room.optionOrder)) {
        const originalIndex = room.optionOrder[answer.index];
        if (originalIndex === undefined) return; // index out of range
        scoringAnswer = { ...answer, index: originalIndex };
      }

      const timeMs = Date.now() - room.questionStart;
      const { points, correct, accuracy } = calcScore(
        q.type, q.questionData, scoringAnswer, timeMs, q.timeLimit, q.points
      );

      player.score += points;
      // Store indexed by question position so a skipped question never shifts
      // later answers into the wrong slot.
      player.answers[room.currentQ] = { answerData: scoringAnswer, correct, points, timeMs, accuracy };
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
