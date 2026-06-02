import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../../prisma.js';
import { JWT_SECRET } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

router.post('/register', async (req, res, next) => {
  try {
    const { email, name, password } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await prisma.teacher.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const teacher = await prisma.teacher.create({ data: { email, name, password: hashed } });
    const token = jwt.sign({ id: teacher.id, email: teacher.email, name: teacher.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, teacher: { id: teacher.id, email: teacher.email, name: teacher.name } });
  } catch (e) {
    next(e);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const teacher = await prisma.teacher.findUnique({ where: { email } });
    if (!teacher) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, teacher.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: teacher.id, email: teacher.email, name: teacher.name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, teacher: { id: teacher.id, email: teacher.email, name: teacher.name } });
  } catch (e) {
    next(e);
  }
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({ teacher: req.teacher });
});

export default router;
