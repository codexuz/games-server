import { Router } from 'express';
import prisma from '../prisma.js';

const router = Router();

const PAGE_SIZE = 20;

// ── helpers ──────────────────────────────────────────────────────────────────

function parsePage(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(Math.max(1, parseInt(query.limit) || PAGE_SIZE), 100);
  return { page, limit };
}

// Deduplicate results by player name (keep best score), returns { items, total }
function deduplicateByPlayer(results, limit, offset) {
  const bestByPlayer = new Map();
  for (const r of results) {
    const existing = bestByPlayer.get(r.playerName);
    if (!existing || r.score > existing.score) bestByPlayer.set(r.playerName, r);
  }
  const sorted = [...bestByPlayer.values()].sort((a, b) => b.score - a.score);
  const total = sorted.length;
  const page = sorted.slice(offset, offset + limit);
  return { items: page, total };
}

// ── Quiz leaderboard ──────────────────────────────────────────────────────────

router.get('/quiz/:quizId', async (req, res) => {
  const { page, limit } = parsePage(req.query);
  const offset = (page - 1) * limit;

  try {
    const quiz = await prisma.quiz.findUnique({
      where: { id: req.params.quizId },
      select: { id: true, title: true, category: true },
    });
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });

    // Fetch enough rows to deduplicate across pages (cap at 5000)
    const raw = await prisma.playerResult.findMany({
      where: { session: { quizId: req.params.quizId } },
      orderBy: { score: 'desc' },
      take: 5000,
      include: { session: { select: { playedAt: true, roomCode: true } } },
    });

    const { items, total } = deduplicateByPlayer(raw, limit, offset);
    const totalPages = Math.ceil(total / limit);

    res.json({
      quiz,
      leaderboard: items.map((r, i) => ({
        rank: offset + i + 1,
        playerName: r.playerName,
        score: r.score,
        correctAnswers: r.correctAnswers,
        totalQuestions: r.totalQuestions,
        accuracy: r.totalQuestions > 0 ? Math.round((r.correctAnswers / r.totalQuestions) * 100) : 0,
        avgAnswerTimeMs: r.avgAnswerTimeMs,
        achievedAt: r.session.playedAt,
      })),
      pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load quiz leaderboard' });
  }
});

// ── Category leaderboard ──────────────────────────────────────────────────────

router.get('/category/:category', async (req, res) => {
  const { page, limit } = parsePage(req.query);
  const offset = (page - 1) * limit;
  const category = decodeURIComponent(req.params.category);

  try {
    const quizIds = await prisma.quiz.findMany({
      where: { category },
      select: { id: true },
    });
    if (quizIds.length === 0) {
      return res.json({ category, leaderboard: [], pagination: { page: 1, limit, total: 0, totalPages: 0, hasMore: false } });
    }

    const raw = await prisma.playerResult.findMany({
      where: { session: { quizId: { in: quizIds.map(q => q.id) } } },
      orderBy: { score: 'desc' },
      take: 5000,
      include: {
        session: {
          select: { playedAt: true, quiz: { select: { title: true } } },
        },
      },
    });

    const { items, total } = deduplicateByPlayer(raw, limit, offset);
    const totalPages = Math.ceil(total / limit);

    res.json({
      category,
      leaderboard: items.map((r, i) => ({
        rank: offset + i + 1,
        playerName: r.playerName,
        score: r.score,
        correctAnswers: r.correctAnswers,
        totalQuestions: r.totalQuestions,
        accuracy: r.totalQuestions > 0 ? Math.round((r.correctAnswers / r.totalQuestions) * 100) : 0,
        quizTitle: r.session.quiz.title,
        achievedAt: r.session.playedAt,
      })),
      pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load category leaderboard' });
  }
});

// ── Global leaderboard ────────────────────────────────────────────────────────

router.get('/global', async (req, res) => {
  const { page, limit } = parsePage(req.query);
  const offset = (page - 1) * limit;

  try {
    const raw = await prisma.playerResult.findMany({
      orderBy: { score: 'desc' },
      take: 5000,
      include: {
        session: {
          select: { playedAt: true, quiz: { select: { title: true, category: true } } },
        },
      },
    });

    const { items, total } = deduplicateByPlayer(raw, limit, offset);
    const totalPages = Math.ceil(total / limit);

    res.json({
      leaderboard: items.map((r, i) => ({
        rank: offset + i + 1,
        playerName: r.playerName,
        score: r.score,
        correctAnswers: r.correctAnswers,
        totalQuestions: r.totalQuestions,
        accuracy: r.totalQuestions > 0 ? Math.round((r.correctAnswers / r.totalQuestions) * 100) : 0,
        quizTitle: r.session.quiz.title,
        category: r.session.quiz.category,
        achievedAt: r.session.playedAt,
      })),
      pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load global leaderboard' });
  }
});

// ── Recent winners ────────────────────────────────────────────────────────────

router.get('/recent', async (req, res) => {
  const { page, limit } = parsePage(req.query);
  const offset = (page - 1) * limit;

  try {
    const [total, sessions] = await prisma.$transaction([
      prisma.gameSession.count({ where: { playerResults: { some: { rank: 1 } } } }),
      prisma.gameSession.findMany({
        where: { playerResults: { some: { rank: 1 } } },
        orderBy: { playedAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          quiz: { select: { title: true, category: true } },
          playerResults: { where: { rank: 1 }, take: 1 },
        },
      }),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      recent: sessions.map(s => ({
        sessionId: s.id,
        quizTitle: s.quiz.title,
        category: s.quiz.category,
        winner: s.playerResults[0].playerName,
        winnerScore: s.playerResults[0].score,
        playerCount: s.playerCount,
        playedAt: s.playedAt,
      })),
      pagination: { page, limit, total, totalPages, hasMore: page < totalPages },
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load recent winners' });
  }
});

export default router;
