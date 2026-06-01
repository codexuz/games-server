const express = require('express');
const router = express.Router();
const { getPrisma } = require('../prisma');

// GET /api/leaderboard/quiz/:quizId?limit=20
// Top players for a specific quiz (all-time best single-game scores)
router.get('/quiz/:quizId', async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  const limit = Math.min(parseInt(req.query.limit) || 20, 100);

  try {
    const quiz = await db.quiz.findUnique({
      where: { id: req.params.quizId },
      select: { id: true, title: true, category: true },
    });
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });

    // Best score per player name across all sessions for this quiz
    const results = await db.playerResult.findMany({
      where: { session: { quizId: req.params.quizId } },
      orderBy: { score: 'desc' },
      take: limit * 3, // over-fetch to deduplicate by player name
      include: { session: { select: { playedAt: true, roomCode: true } } },
    });

    // Keep only the best result per player name
    const seen = new Set();
    const deduplicated = [];
    for (const r of results) {
      if (!seen.has(r.playerName)) {
        seen.add(r.playerName);
        deduplicated.push(r);
        if (deduplicated.length >= limit) break;
      }
    }

    res.json({
      quiz,
      leaderboard: deduplicated.map((r, i) => ({
        rank: i + 1,
        playerName: r.playerName,
        score: r.score,
        correctAnswers: r.correctAnswers,
        totalQuestions: r.totalQuestions,
        accuracy: r.totalQuestions > 0 ? Math.round((r.correctAnswers / r.totalQuestions) * 100) : 0,
        avgAnswerTimeMs: r.avgAnswerTimeMs,
        achievedAt: r.session.playedAt,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load quiz leaderboard' });
  }
});

// GET /api/leaderboard/category/:category?limit=20
// Top players for a quiz category
router.get('/category/:category', async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const category = decodeURIComponent(req.params.category);

  try {
    // Get all quizzes in this category
    const quizIds = await db.quiz.findMany({
      where: { category },
      select: { id: true },
    });
    if (quizIds.length === 0) return res.json({ category, leaderboard: [] });

    const quizIdList = quizIds.map(q => q.id);

    const results = await db.playerResult.findMany({
      where: { session: { quizId: { in: quizIdList } } },
      orderBy: { score: 'desc' },
      take: limit * 3,
      include: {
        session: {
          select: {
            playedAt: true,
            quiz: { select: { title: true } },
          },
        },
      },
    });

    const seen = new Set();
    const deduplicated = [];
    for (const r of results) {
      if (!seen.has(r.playerName)) {
        seen.add(r.playerName);
        deduplicated.push(r);
        if (deduplicated.length >= limit) break;
      }
    }

    res.json({
      category,
      leaderboard: deduplicated.map((r, i) => ({
        rank: i + 1,
        playerName: r.playerName,
        score: r.score,
        correctAnswers: r.correctAnswers,
        totalQuestions: r.totalQuestions,
        accuracy: r.totalQuestions > 0 ? Math.round((r.correctAnswers / r.totalQuestions) * 100) : 0,
        quizTitle: r.session.quiz.title,
        achievedAt: r.session.playedAt,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load category leaderboard' });
  }
});

// GET /api/leaderboard/global?limit=20
// All-time top players across all quizzes
router.get('/global', async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  const limit = Math.min(parseInt(req.query.limit) || 20, 100);

  try {
    const results = await db.playerResult.findMany({
      orderBy: { score: 'desc' },
      take: limit * 3,
      include: {
        session: {
          select: {
            playedAt: true,
            quiz: { select: { title: true, category: true } },
          },
        },
      },
    });

    const seen = new Set();
    const deduplicated = [];
    for (const r of results) {
      if (!seen.has(r.playerName)) {
        seen.add(r.playerName);
        deduplicated.push(r);
        if (deduplicated.length >= limit) break;
      }
    }

    res.json({
      leaderboard: deduplicated.map((r, i) => ({
        rank: i + 1,
        playerName: r.playerName,
        score: r.score,
        correctAnswers: r.correctAnswers,
        totalQuestions: r.totalQuestions,
        accuracy: r.totalQuestions > 0 ? Math.round((r.correctAnswers / r.totalQuestions) * 100) : 0,
        quizTitle: r.session.quiz.title,
        category: r.session.quiz.category,
        achievedAt: r.session.playedAt,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load global leaderboard' });
  }
});

// GET /api/leaderboard/recent?limit=10
// Most recent game winners (latest sessions)
router.get('/recent', async (req, res) => {
  const db = await getPrisma();
  if (!db) return res.status(503).json({ error: 'Database unavailable' });

  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  try {
    const sessions = await db.gameSession.findMany({
      orderBy: { playedAt: 'desc' },
      take: limit,
      include: {
        quiz: { select: { title: true, category: true } },
        playerResults: {
          where: { rank: 1 },
          take: 1,
        },
      },
    });

    res.json(sessions
      .filter(s => s.playerResults.length > 0)
      .map(s => ({
        sessionId: s.id,
        quizTitle: s.quiz.title,
        category: s.quiz.category,
        winner: s.playerResults[0].playerName,
        winnerScore: s.playerResults[0].score,
        playerCount: s.playerCount,
        playedAt: s.playedAt,
      }))
    );
  } catch (e) {
    res.status(500).json({ error: 'Failed to load recent winners' });
  }
});

module.exports = router;
