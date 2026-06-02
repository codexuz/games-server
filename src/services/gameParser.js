import { parse } from 'csv-parse/sync';
import XLSX from 'xlsx';
import mammoth from 'mammoth';

export function validateQuestions(questions) {
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q.text?.trim()) return `Question ${i + 1}: text is required`;
    if (!Array.isArray(q.options) || q.options.length !== 4) return `Question ${i + 1}: must have exactly 4 options`;
    if (q.options.some(o => !String(o).trim())) return `Question ${i + 1}: all options must be non-empty`;
    const c = Number(q.correct);
    if (isNaN(c) || c < 0 || c > 3) return `Question ${i + 1}: correct must be 0–3`;
  }
  return null;
}

export function parseJSON(buffer) {
  const data = JSON.parse(buffer.toString('utf8'));
  return Array.isArray(data) ? data : [data];
}

export function parseCSV(buffer) {
  const rows = parse(buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  const quizMap = {};
  for (const row of rows) {
    const title = row.quiz_title || row.title;
    if (!title) continue;
    if (!quizMap[title]) quizMap[title] = { title, category: row.category || null, questions: [] };
    quizMap[title].questions.push({
      text: row.question,
      options: [row.option_a, row.option_b, row.option_c, row.option_d],
      correct: parseInt(row.correct_index, 10),
      timeLimit: parseInt(row.time_limit_ms, 10) || 20000,
    });
  }
  return Object.values(quizMap);
}

export function parseExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  const quizMap = {};
  for (const row of rows) {
    const title = row.quiz_title || row.title;
    if (!title) continue;
    if (!quizMap[title]) quizMap[title] = { title, category: row.category || null, questions: [] };
    quizMap[title].questions.push({
      text: row.question,
      options: [row.option_a, row.option_b, row.option_c, row.option_d].map(String),
      correct: parseInt(row.correct_index, 10),
      timeLimit: parseInt(row.time_limit_ms, 10) || 20000,
    });
  }
  return Object.values(quizMap);
}

export async function parseDOCX(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value;
  const quizzes = [];
  let currentQuiz = null;
  let currentQ = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.toUpperCase().startsWith('QUIZ:')) {
      if (currentQuiz) {
        if (currentQ) { currentQuiz.questions.push(currentQ); currentQ = null; }
        quizzes.push(currentQuiz);
      }
      currentQuiz = { title: line.slice(5).trim(), category: null, questions: [] };
    } else if (line.toUpperCase().startsWith('CATEGORY:')) {
      if (currentQuiz) currentQuiz.category = line.slice(9).trim();
    } else if (line.toUpperCase().startsWith('Q:')) {
      if (currentQ && currentQuiz) currentQuiz.questions.push(currentQ);
      currentQ = { text: line.slice(2).trim(), options: [], correct: 0, timeLimit: 20000 };
    } else if (/^[A-D]:/i.test(line) && currentQ) {
      currentQ.options.push(line.slice(2).trim());
    } else if (line.toUpperCase().startsWith('CORRECT:') && currentQ) {
      const letter = line.slice(8).trim().toUpperCase();
      currentQ.correct = ['A', 'B', 'C', 'D'].indexOf(letter);
    } else if (line.toUpperCase().startsWith('TIME:') && currentQ) {
      currentQ.timeLimit = parseInt(line.slice(5).trim(), 10) || 20000;
    }
  }
  if (currentQ && currentQuiz) currentQuiz.questions.push(currentQ);
  if (currentQuiz) quizzes.push(currentQuiz);
  return quizzes;
}
