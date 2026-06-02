import { Router } from 'express';
import XLSX from 'xlsx';

const router = Router();

// ── Template data showcasing all supported question types ───────────────────
const TEMPLATE_DATA = [
  {
    title: 'My Quiz Title',
    category: 'Science',
    questions: [
      {
        text: 'What is 2+2?',
        type: 'multiple_choice',
        questionData: { options: ['1', '2', '3', '4'], correctIndex: 3 },
        timeLimit: 15000,
        points: 1000,
      },
      {
        text: 'The Earth is flat.',
        type: 'true_false',
        questionData: { correctAnswer: false },
        timeLimit: 15000,
        points: 1000,
      },
      {
        text: 'What is the chemical symbol for water?',
        type: 'type_answer',
        questionData: { acceptedAnswers: ['H2O', 'h2o'], caseSensitive: false },
        timeLimit: 20000,
        points: 1000,
      },
      {
        text: 'How many bones are in the adult human body?',
        type: 'slider',
        questionData: { min: 100, max: 300, step: 1, correctValue: 206, tolerance: 5 },
        timeLimit: 20000,
        points: 1000,
      },
      {
        text: 'Which science topic is most interesting?',
        type: 'poll',
        questionData: { options: ['Physics', 'Chemistry', 'Biology', 'Astronomy'] },
        timeLimit: 15000,
        points: 0,
      },
      {
        text: 'Order these planets from closest to farthest from the Sun.',
        type: 'ordering',
        questionData: { items: ['Mercury', 'Venus', 'Earth', 'Mars'], correctOrder: [0, 1, 2, 3] },
        timeLimit: 30000,
        points: 1000,
      },
    ],
  },
];

// ── JSON template ───────────────────────────────────────────────────────────
router.get('/json', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="quiz_template.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(TEMPLATE_DATA, null, 2));
});

// ── CSV template ────────────────────────────────────────────────────────────
// Uses type + question_data (JSON string) columns for full type support
router.get('/csv', (_req, res) => {
  const rows = [
    'quiz_title,category,question,type,question_data,time_limit_ms,points',
    `My Quiz Title,Science,What is 2+2?,multiple_choice,"${esc({ options: ['1', '2', '3', '4'], correctIndex: 3 })}",15000,1000`,
    `My Quiz Title,Science,The Earth is flat.,true_false,"${esc({ correctAnswer: false })}",15000,1000`,
    `My Quiz Title,Science,What is the chemical symbol for water?,type_answer,"${esc({ acceptedAnswers: ['H2O', 'h2o'], caseSensitive: false })}",20000,1000`,
    `My Quiz Title,Science,How many bones in the adult human body?,slider,"${esc({ min: 100, max: 300, step: 1, correctValue: 206, tolerance: 5 })}",20000,1000`,
    `My Quiz Title,Science,Which science topic is most interesting?,poll,"${esc({ options: ['Physics', 'Chemistry', 'Biology', 'Astronomy'] })}",15000,0`,
  ].join('\n');
  res.setHeader('Content-Disposition', 'attachment; filename="quiz_template.csv"');
  res.setHeader('Content-Type', 'text/csv');
  res.send(rows);
});

/** Escape JSON for CSV embedding (double-quote inner quotes) */
function esc(obj) {
  return JSON.stringify(obj).replace(/"/g, '""');
}

// ── Excel template ──────────────────────────────────────────────────────────
router.get('/xlsx', (_req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['quiz_title', 'category', 'question', 'type', 'question_data', 'time_limit_ms', 'points'],
    ['My Quiz Title', 'Science', 'What is 2+2?', 'multiple_choice', JSON.stringify({ options: ['1', '2', '3', '4'], correctIndex: 3 }), 15000, 1000],
    ['My Quiz Title', 'Science', 'The Earth is flat.', 'true_false', JSON.stringify({ correctAnswer: false }), 15000, 1000],
    ['My Quiz Title', 'Science', 'Chemical symbol for water?', 'type_answer', JSON.stringify({ acceptedAnswers: ['H2O', 'h2o'], caseSensitive: false }), 20000, 1000],
    ['My Quiz Title', 'Science', 'Bones in human body?', 'slider', JSON.stringify({ min: 100, max: 300, step: 1, correctValue: 206, tolerance: 5 }), 20000, 1000],
    ['My Quiz Title', 'Science', 'Favorite science topic?', 'poll', JSON.stringify({ options: ['Physics', 'Chemistry', 'Biology', 'Astronomy'] }), 15000, 0],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Quizzes');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="quiz_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── DOCX / text template ───────────────────────────────────────────────────
// Shows both traditional A:/B:/CORRECT: format and new TYPE:/DATA: format
router.get('/docx', (_req, res) => {
  const text = [
    'QUIZ: My Quiz Title',
    'CATEGORY: Science',
    '',
    '# Multiple Choice (traditional format still works)',
    'Q: What is 2+2?',
    'A: 1',
    'B: 2',
    'C: 3',
    'D: 4',
    'CORRECT: D',
    'TIME: 15000',
    '',
    '# True/False (new TYPE + DATA format)',
    'Q: The Earth is flat.',
    'TYPE: true_false',
    'DATA: {"correctAnswer": false}',
    'TIME: 15000',
    '',
    '# Type Answer',
    'Q: What is the chemical symbol for water?',
    'TYPE: type_answer',
    'DATA: {"acceptedAnswers": ["H2O", "h2o"], "caseSensitive": false}',
    'TIME: 20000',
    '',
    '# Slider',
    'Q: How many bones in the adult human body?',
    'TYPE: slider',
    'DATA: {"min": 100, "max": 300, "step": 1, "correctValue": 206, "tolerance": 5}',
    'TIME: 20000',
    '',
    '# Poll (no correct answer)',
    'Q: Which science topic is most interesting?',
    'TYPE: poll',
    'DATA: {"options": ["Physics", "Chemistry", "Biology", "Astronomy"]}',
    'TIME: 15000',
    'POINTS: 0',
    '',
  ].join('\n');
  res.setHeader('Content-Disposition', 'attachment; filename="quiz_template.txt"');
  res.setHeader('Content-Type', 'text/plain');
  res.send(text);
});

export default router;
