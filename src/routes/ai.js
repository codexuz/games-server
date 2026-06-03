import { Router } from 'express';
import multer from 'multer';
import prisma from '../../prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { extractTextFromFile } from '../services/gameParser.js';

const router = Router();

const ALLOWED_MIMETYPES = new Set([
  'application/pdf',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);

const ALLOWED_EXTENSIONS = new Set(['pdf', 'txt', 'doc', 'docx', 'xlsx', 'xls']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    if (ALLOWED_MIMETYPES.has(file.mimetype) || ALLOWED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: .${ext}. Allowed: pdf, txt, doc, docx, xlsx, xls`));
    }
  },
});

// Submit a new AI job (optional file upload for context)
router.post('/jobs', authMiddleware, upload.single('file'), async (req, res, next) => {
  try {
    let { prompt } = req.body;

    if (!prompt && !req.file) {
      return res.status(400).json({ error: 'Prompt or file is required' });
    }

    if (req.file) {
      let fileText;
      try {
        fileText = await extractTextFromFile(req.file.buffer, req.file.mimetype, req.file.originalname);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      if (!prompt) {
        prompt = `Based on the following content, generate a quiz:\n\n${fileText}`;
      } else {
        prompt = `${prompt}\n\nUse the following content as the source material:\n\n${fileText}`;
      }
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
