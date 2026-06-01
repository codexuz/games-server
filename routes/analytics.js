const express = require('express');
const router = express.Router();
const { getPrisma } = require('../prisma');

// GET /api/analytics/overview
// Global stats: total sessions, total players, avg score across all quizzes
router.get('/overview', async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const [sessionCount, playerCount, quizCount, analyticsAgg] = await Promise.all([
      db.gameSession.count(),
      db.playerResult.count(),
      db.quiz.count(),
      db.quizAnalytics.aggregate({ _avg: { avgScore: true, avgAccuracy: true } }),
    ]);

    res.json({
      totalSessions: sessionCount,
      totalPlayers: playerCount,
      totalQuizzes: quizCount,
      avgScore: Math.round((analyticsAgg._avg.avgScore ?? 0) * 10) / 10,
      avgAccuracy: Math.round((analyticsAgg._avg.avgAccuracy ?? 0) * 1000) / 10, // as %
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

// GET /api/analytics/quiz/:quizId
// Full analytics for a single quiz
router.get('/quiz/:quizId', async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const [quiz, analytics, sessions] = await Promise.all([
      db.quiz.findUnique({
        where: { id: req.params.quizId },
        select: { id: true, title: true, category: true },
      }),
      db.quizAnalytics.findUnique({ where: { quizId: req.params.quizId } }),
      db.gameSession.findMany({
        where: { quizId: req.params.quizId },
        orderBy: { playedAt: 'desc' },
        take: 10,
        include: {
          playerResults: { orderBy: { rank: 'asc' } },
        },
      }),
    ]);

    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });

    res.json({
      quiz,
      analytics: analytics ?? {
        timesPlayed: 0,
        totalPlayers: 0,
        avgScore: 0,
        highScore: 0,
        highScorePlayer: null,
        avgAccuracy: 0,
      },
      recentSessions: sessions.map(s => ({
        id: s.id,
        roomCode: s.roomCode,
        playerCount: s.playerCount,
        playedAt: s.playedAt,
        topPlayer: s.playerResults[0]?.playerName ?? null,
        topScore: s.playerResults[0]?.score ?? 0,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load quiz analytics' });
  }
});

// GET /api/analytics/category/:category
// Analytics for a quiz category
router.get('/category/:category', async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const category = decodeURIComponent(req.params.category);
    const [analytics, quizzes] = await Promise.all([
      db.categoryAnalytics.findUnique({ where: { category } }),
      db.quiz.findMany({
        where: { category },
        include: { analytics: true, _count: { select: { sessions: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json({
      category,
      analytics: analytics ?? {
        timesPlayed: 0,
        totalPlayers: 0,
        avgScore: 0,
        topPlayer: null,
        topScore: 0,
      },
      quizzes: quizzes.map(q => ({
        id: q.id,
        title: q.title,
        sessionsPlayed: q._count.sessions,
        avgScore: q.analytics?.avgScore ?? 0,
        highScore: q.analytics?.highScore ?? 0,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load category analytics' });
  }
});

// GET /api/analytics/categories
// All categories with analytics
router.get('/categories', async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  try {
    const categories = await db.categoryAnalytics.findMany({
      orderBy: { timesPlayed: 'desc' },
    });
    res.json(categories);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

// GET /api/analytics/sessions?quizId=&limit=20
// Recent game sessions, optionally filtered by quiz
router.get('/sessions', async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const where = req.query.quizId ? { quizId: req.query.quizId } : {};

  try {
    const sessions = await db.gameSession.findMany({
      where,
      orderBy: { playedAt: 'desc' },
      take: limit,
      include: {
        quiz: { select: { title: true, category: true } },
        playerResults: { orderBy: { rank: 'asc' }, take: 3 },
      },
    });

    res.json(sessions.map(s => ({
      id: s.id,
      roomCode: s.roomCode,
      quizTitle: s.quiz.title,
      category: s.quiz.category,
      playerCount: s.playerCount,
      playedAt: s.playedAt,
      podium: s.playerResults.map(p => ({ name: p.playerName, score: p.score, rank: p.rank })),
    })));
  } catch (e) {
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

module.exports = router;
