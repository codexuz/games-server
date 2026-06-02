import { Router } from 'express';
import prisma from '../../prisma.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// Submit a new AI job
router.post('/jobs', authMiddleware, async (req, res, next) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const job = await prisma.aiJob.create({
      data: {
        prompt,
        teacherId: req.teacher.id,
      },
    });

    res.status(201).json({ jobId: job.id, status: job.status });
  } catch (err) {
    next(err);
  }
});

// Check status of a job
router.get('/jobs/:id', authMiddleware, async (req, res, next) => {
  try {
    const job = await prisma.aiJob.findUnique({
      where: { id: req.params.id },
    });

    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.teacherId !== req.teacher.id) return res.status(403).json({ error: 'Not your job' });

    res.json({
      id: job.id,
      status: job.status,
      quizId: job.quizId,
      error: job.error,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
