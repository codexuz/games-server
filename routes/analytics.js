import { Router } from 'express';
import prisma from '../prisma.js';

const router = Router();

router.get('/overview', async (req, res) => {
  try {
    const [sessionCount, playerCount, quizCount, analyticsAgg] = await Promise.all([
      prisma.gameSession.count(),
      prisma.playerResult.count(),
      prisma.quiz.count(),
      prisma.quizAnalytics.aggregate({ _avg: { avgScore: true, avgAccuracy: true } }),
    ]);

    res.json({
      totalSessions: sessionCount,
      totalPlayers: playerCount,
      totalQuizzes: quizCount,
      avgScore: Math.round((analyticsAgg._avg.avgScore ?? 0) * 10) / 10,
      avgAccuracy: Math.round((analyticsAgg._avg.avgAccuracy ?? 0) * 1000) / 10,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

router.get('/quiz/:quizId', async (req, res) => {
  try {
    const [quiz, analytics, sessions] = await Promise.all([
      prisma.quiz.findUnique({
        where: { id: req.params.quizId },
        select: { id: true, title: true, category: true },
      }),
      prisma.quizAnalytics.findUnique({ where: { quizId: req.params.quizId } }),
      prisma.gameSession.findMany({
        where: { quizId: req.params.quizId },
        orderBy: { playedAt: 'desc' },
        take: 10,
        include: { playerResults: { orderBy: { rank: 'asc' } } },
      }),
    ]);

    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });

    res.json({
      quiz,
      analytics: analytics ?? {
        timesPlayed: 0, totalPlayers: 0, avgScore: 0,
        highScore: 0, highScorePlayer: null, avgAccuracy: 0,
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

router.get('/category/:category', async (req, res) => {
  try {
    const category = decodeURIComponent(req.params.category);
    const [analytics, quizzes] = await Promise.all([
      prisma.categoryAnalytics.findUnique({ where: { category } }),
      prisma.quiz.findMany({
        where: { category },
        include: { analytics: true, _count: { select: { sessions: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json({
      category,
      analytics: analytics ?? { timesPlayed: 0, totalPlayers: 0, avgScore: 0, topPlayer: null, topScore: 0 },
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

router.get('/categories', async (req, res) => {
  try {
    const categories = await prisma.categoryAnalytics.findMany({
      orderBy: { timesPlayed: 'desc' },
    });
    res.json(categories);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

router.get('/sessions', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const where = req.query.quizId ? { quizId: req.query.quizId } : {};

  try {
    const sessions = await prisma.gameSession.findMany({
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

export default router;
