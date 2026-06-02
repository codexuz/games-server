import { Router } from 'express';
import XLSX from 'xlsx';

const router = Router();

const TEMPLATE_DATA = [
  {
    title: 'My Quiz Title',
    category: 'Science',
    questions: [
      { text: 'What is 2+2?', options: ['1', '2', '3', '4'], correct: 3, timeLimit: 15000 },
      { text: 'Capital of Japan?', options: ['Beijing', 'Seoul', 'Tokyo', 'Bangkok'], correct: 2, timeLimit: 20000 },
    ],
  },
];

router.get('/json', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="quiz_template.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(TEMPLATE_DATA, null, 2));
});

router.get('/csv', (_req, res) => {
  const rows = [
    'quiz_title,category,question,option_a,option_b,option_c,option_d,correct_index,time_limit_ms',
    'My Quiz Title,Science,What is 2+2?,1,2,3,4,3,15000',
    'My Quiz Title,Science,Capital of Japan?,Beijing,Seoul,Tokyo,Bangkok,2,20000',
  ].join('\n');
  res.setHeader('Content-Disposition', 'attachment; filename="quiz_template.csv"');
  res.setHeader('Content-Type', 'text/csv');
  res.send(rows);
});

router.get('/xlsx', (_req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['quiz_title', 'category', 'question', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_index', 'time_limit_ms'],
    ['My Quiz Title', 'Science', 'What is 2+2?', '1', '2', '3', '4', 3, 15000],
    ['My Quiz Title', 'Science', 'Capital of Japan?', 'Beijing', 'Seoul', 'Tokyo', 'Bangkok', 2, 20000],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Quizzes');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="quiz_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/docx', (_req, res) => {
  const text = `QUIZ: My Quiz Title\nCATEGORY: Science\n\nQ: What is 2+2?\nA: 1\nB: 2\nC: 3\nD: 4\nCORRECT: D\nTIME: 15000\n\nQ: Capital of Japan?\nA: Beijing\nB: Seoul\nC: Tokyo\nD: Bangkok\nCORRECT: C\nTIME: 20000\n`;
  res.setHeader('Content-Disposition', 'attachment; filename="quiz_template.txt"');
  res.setHeader('Content-Type', 'text/plain');
  res.send(text);
});

export default router;
