import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import prisma from '../../prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  validateQuestions, parseJSON, parseCSV, parseExcel, parseDOCX,
} from '../services/gameParser.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.json', '.csv', '.xlsx', '.xls', '.docx', '.doc'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// ── Normalise a DB quiz for API responses ───────────────────────────────────
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

// Public quizzes
router.get('/', async (req, res, next) => {
  try {
    const quizzes = await prisma.quiz.findMany({
      include: { questions: { orderBy: { order: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(quizzes.map(normaliseQuiz));
  } catch (e) {
    next(e);
  }
});

// Teacher's own quizzes
router.get('/mine', authMiddleware, async (req, res, next) => {
  try {
    const quizzes = await prisma.quiz.findMany({
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
    next(e);
  }
});

// Create quiz
router.post('/', authMiddleware, async (req, res, next) => {
  try {
    const { title, category, questions } = req.body;
    if (!title || !questions?.length) return res.status(400).json({ error: 'Title and questions required' });

    const validationError = validateQuestions(questions);
    if (validationError) return res.status(400).json({ error: validationError });

    const quiz = await prisma.quiz.create({
      data: {
        title,
        category: category || null,
        teacherId: req.teacher.id,
        questions: {
          create: questions.map((q, i) => ({
            text: q.text,
            type: q.type || 'multiple_choice',
            questionData: q.questionData || {},
            timeLimit: q.timeLimit || 20000,
            points: q.points || 1000,
            order: i,
            imageUrl: q.imageUrl || null,
          })),
        },
      },
      include: { questions: { orderBy: { order: 'asc' } } },
    });
    res.status(201).json(normaliseQuiz(quiz));
  } catch (e) {
    next(e);
  }
});

// Update quiz
router.put('/:id', authMiddleware, async (req, res, next) => {
  try {
    const existing = await prisma.quiz.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Quiz not found' });
    if (existing.teacherId !== req.teacher.id) return res.status(403).json({ error: 'Not your quiz' });

    const { title, category, questions } = req.body;
    if (!title && !questions) return res.status(400).json({ error: 'Nothing to update' });
    if (questions) {
      const validationError = validateQuestions(questions);
      if (validationError) return res.status(400).json({ error: validationError });
    }

    await prisma.$transaction(async (tx) => {
      if (questions) await tx.question.deleteMany({ where: { quizId: req.params.id } });
      await tx.quiz.update({
        where: { id: req.params.id },
        data: {
          ...(title && { title }),
          ...(category !== undefined && { category: category || null }),
          ...(questions && {
            questions: {
              create: questions.map((q, i) => ({
                text: q.text,
                type: q.type || 'multiple_choice',
                questionData: q.questionData || {},
                timeLimit: q.timeLimit || 20000,
                points: q.points || 1000,
                order: i,
                imageUrl: q.imageUrl || null,
              })),
            },
          }),
        },
      });
    });

    const updated = await prisma.quiz.findUnique({
      where: { id: req.params.id },
      include: { questions: { orderBy: { order: 'asc' } } },
    });
    res.json(normaliseQuiz(updated));
  } catch (e) {
    next(e);
  }
});

// Delete quiz
router.delete('/:id', authMiddleware, async (req, res, next) => {
  try {
    const quiz = await prisma.quiz.findUnique({ where: { id: req.params.id } });
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    if (quiz.teacherId !== req.teacher.id) return res.status(403).json({ error: 'Not your quiz' });
    await prisma.quiz.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Bulk import
router.post('/import', authMiddleware, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    let parsed;

    if (ext === '.json') parsed = parseJSON(req.file.buffer);
    else if (ext === '.csv') parsed = parseCSV(req.file.buffer);
    else if (ext === '.xlsx' || ext === '.xls') parsed = parseExcel(req.file.buffer);
    else if (ext === '.docx' || ext === '.doc') parsed = await parseDOCX(req.file.buffer);
    else return res.status(400).json({ error: 'Unsupported file type. Use JSON, CSV, XLSX, or DOCX.' });

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
        const quiz = await prisma.quiz.create({
          data: {
            title: quizData.title,
            category: quizData.category || null,
            teacherId: req.teacher.id,
            questions: {
              create: quizData.questions.map((q, i) => ({
                text: q.text,
                type: q.type || 'multiple_choice',
                questionData: q.questionData || {},
                timeLimit: q.timeLimit || 20000,
                points: q.points || 1000,
                order: i,
                imageUrl: q.imageUrl || null,
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
  } catch (e) {
    next(e);
  }
});

export default router;
