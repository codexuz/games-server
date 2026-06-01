const { getPrisma } = require('../prisma');

/**
 * Persist a completed game session and update all aggregated analytics.
 * Called from Socket.io endGame handler.
 *
 * @param {{
 *   roomCode: string,
 *   quizId: string,
 *   teacherId?: string,
 *   players: Array<{ name: string, score: number, answers: Array<{ correct: boolean, timeMs: number }> }>
 * }} gameData
 */
async function persistGameSession(gameData) {
  const db = await getPrisma();
  if (!db) return;

  const { roomCode, quizId, teacherId, players } = gameData;

  // Sort by score descending to assign ranks
  const ranked = [...players].sort((a, b) => b.score - a.score);

  try {
    // 1. Create GameSession + PlayerResults in one transaction
    const session = await db.gameSession.create({
      data: {
        roomCode,
        quizId,
        teacherId: teacherId || null,
        playerCount: ranked.length,
        playerResults: {
          create: ranked.map((p, i) => {
            const correctAnswers = p.answers.filter(a => a.correct).length;
            const totalQuestions = p.answers.length;
            const avgTimeMs = totalQuestions > 0
              ? Math.round(p.answers.reduce((s, a) => s + a.timeMs, 0) / totalQuestions)
              : 0;
            return {
              playerName: p.name,
              score: p.score,
              rank: i + 1,
              correctAnswers,
              totalQuestions,
              avgAnswerTimeMs: avgTimeMs,
            };
          }),
        },
      },
      include: { playerResults: true },
    });

    // 2. Update QuizAnalytics (upsert)
    const allScores = ranked.map(p => p.score);
    const allAccuracies = ranked.map(p =>
      p.answers.length > 0 ? p.answers.filter(a => a.correct).length / p.answers.length : 0
    );
    const newHighScore = Math.max(...allScores);
    const highScorePlayer = ranked[0]?.name ?? null;

    const existing = await db.quizAnalytics.findUnique({ where: { quizId } });

    if (existing) {
      const totalPlayers = existing.totalPlayers + ranked.length;
      const timesPlayed = existing.timesPlayed + 1;
      // Rolling average for score and accuracy
      const avgScore = (existing.avgScore * existing.totalPlayers + allScores.reduce((s, v) => s + v, 0)) / totalPlayers;
      const avgAccuracy = (existing.avgAccuracy * existing.totalPlayers + allAccuracies.reduce((s, v) => s + v, 0)) / totalPlayers;

      await db.quizAnalytics.update({
        where: { quizId },
        data: {
          timesPlayed,
          totalPlayers,
          avgScore,
          avgAccuracy,
          highScore: Math.max(existing.highScore, newHighScore),
          highScorePlayer: newHighScore >= existing.highScore ? highScorePlayer : existing.highScorePlayer,
        },
      });
    } else {
      const avgScore = allScores.reduce((s, v) => s + v, 0) / ranked.length;
      const avgAccuracy = allAccuracies.reduce((s, v) => s + v, 0) / ranked.length;
      await db.quizAnalytics.create({
        data: {
          quizId,
          timesPlayed: 1,
          totalPlayers: ranked.length,
          avgScore,
          avgAccuracy,
          highScore: newHighScore,
          highScorePlayer,
        },
      });
    }

    // 3. Update CategoryAnalytics (upsert by category)
    const quiz = await db.quiz.findUnique({ where: { id: quizId }, select: { category: true } });
    if (quiz?.category) {
      const category = quiz.category;
      const catExisting = await db.categoryAnalytics.findUnique({ where: { category } });

      if (catExisting) {
        const totalPlayers = catExisting.totalPlayers + ranked.length;
        const timesPlayed = catExisting.timesPlayed + 1;
        const avgScore = (catExisting.avgScore * catExisting.totalPlayers + allScores.reduce((s, v) => s + v, 0)) / totalPlayers;
        const newTop = newHighScore > catExisting.topScore;

        await db.categoryAnalytics.update({
          where: { category },
          data: {
            timesPlayed,
            totalPlayers,
            avgScore,
            topScore: newTop ? newHighScore : catExisting.topScore,
            topPlayer: newTop ? highScorePlayer : catExisting.topPlayer,
          },
        });
      } else {
        const avgScore = allScores.reduce((s, v) => s + v, 0) / ranked.length;
        await db.categoryAnalytics.create({
          data: {
            category,
            timesPlayed: 1,
            totalPlayers: ranked.length,
            avgScore,
            topScore: newHighScore,
            topPlayer: highScorePlayer,
          },
        });
      }
    }

    console.log(`✅ Session ${session.id} persisted for quiz ${quizId}`);
    return session;
  } catch (e) {
    console.error('Failed to persist game session:', e.message);
  }
}

module.exports = { persistGameSession };
