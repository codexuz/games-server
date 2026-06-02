import { parse } from 'csv-parse/sync';
import XLSX from 'xlsx';
import mammoth from 'mammoth';

// ── Backward-compatibility: auto-convert old format → multiple_choice ───────
function migrateOldFormat(q) {
  if (q.options && typeof q.correct === 'number' && !q.type) {
    return {
      text: q.text,
      type: 'multiple_choice',
      questionData: { options: q.options, correctIndex: q.correct },
      timeLimit: q.timeLimit || 20000,
      points: q.points || 1000,
      imageUrl: q.imageUrl || null,
    };
  }
  return q;
}

// ── Type-aware question validation ──────────────────────────────────────────
export function validateQuestions(questions) {
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q.text?.trim()) return `Question ${i + 1}: text is required`;
    const type = q.type || 'multiple_choice';
    const data = q.questionData;
    if (!data) return `Question ${i + 1}: questionData is required`;

    switch (type) {
      case 'multiple_choice':
        if (!Array.isArray(data.options) || data.options.length < 2 || data.options.length > 8)
          return `Question ${i + 1}: multiple choice needs 2-8 options`;
        if (data.options.some(o => !String(o).trim()))
          return `Question ${i + 1}: all options must be non-empty`;
        if (typeof data.correctIndex !== 'number' || data.correctIndex < 0 || data.correctIndex >= data.options.length)
          return `Question ${i + 1}: correctIndex must be valid`;
        break;
      case 'true_false':
        if (typeof data.correctAnswer !== 'boolean')
          return `Question ${i + 1}: true_false needs correctAnswer (boolean)`;
        break;
      case 'type_answer':
        if (!Array.isArray(data.acceptedAnswers) || data.acceptedAnswers.length === 0)
          return `Question ${i + 1}: type_answer needs acceptedAnswers array`;
        break;
      case 'slider':
        if (typeof data.min !== 'number' || typeof data.max !== 'number' || typeof data.correctValue !== 'number')
          return `Question ${i + 1}: slider needs min, max, correctValue`;
        break;
      case 'poll':
        if (!Array.isArray(data.options) || data.options.length < 2)
          return `Question ${i + 1}: poll needs at least 2 options`;
        break;
      case 'ordering':
        if (!Array.isArray(data.items) || data.items.length < 2)
          return `Question ${i + 1}: ordering needs at least 2 items`;
        if (!Array.isArray(data.correctOrder) || data.correctOrder.length !== data.items.length)
          return `Question ${i + 1}: ordering correctOrder must match items length`;
        break;
      default:
        return `Question ${i + 1}: unknown type '${type}'`;
    }
  }
  return null;
}

// ── JSON parser ─────────────────────────────────────────────────────────────
export function parseJSON(buffer) {
  const data = JSON.parse(buffer.toString('utf8'));
  const arr = Array.isArray(data) ? data : [data];
  // Migrate each quiz's questions from old format if needed
  return arr.map(quiz => ({
    ...quiz,
    questions: (quiz.questions || []).map(migrateOldFormat),
  }));
}

// ── CSV parser ──────────────────────────────────────────────────────────────
// Supports both old flat format and new type+questionData format.
// Old columns: quiz_title, category, question, option_a..d, correct_index, time_limit_ms
// New columns: quiz_title, category, question, type, question_data (JSON string), time_limit_ms, points
export function parseCSV(buffer) {
  const rows = parse(buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
  const quizMap = {};
  for (const row of rows) {
    const title = row.quiz_title || row.title;
    if (!title) continue;
    if (!quizMap[title]) quizMap[title] = { title, category: row.category || null, questions: [] };

    let q;
    if (row.type && row.question_data) {
      // New format with type + JSON questionData column
      let questionData;
      try { questionData = JSON.parse(row.question_data); } catch { questionData = {}; }
      q = {
        text: row.question,
        type: row.type,
        questionData,
        timeLimit: parseInt(row.time_limit_ms, 10) || 20000,
        points: parseInt(row.points, 10) || 1000,
      };
    } else {
      // Old flat format — build as old style, then migrate
      q = migrateOldFormat({
        text: row.question,
        options: [row.option_a, row.option_b, row.option_c, row.option_d].filter(Boolean),
        correct: parseInt(row.correct_index, 10),
        timeLimit: parseInt(row.time_limit_ms, 10) || 20000,
      });
    }
    quizMap[title].questions.push(q);
  }
  return Object.values(quizMap);
}

// ── Excel parser ────────────────────────────────────────────────────────────
// Same dual-format support as CSV.
export function parseExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  const quizMap = {};
  for (const row of rows) {
    const title = row.quiz_title || row.title;
    if (!title) continue;
    if (!quizMap[title]) quizMap[title] = { title, category: row.category || null, questions: [] };

    let q;
    if (row.type && row.question_data) {
      let questionData;
      try { questionData = JSON.parse(row.question_data); } catch { questionData = {}; }
      q = {
        text: row.question,
        type: row.type,
        questionData,
        timeLimit: parseInt(row.time_limit_ms, 10) || 20000,
        points: parseInt(row.points, 10) || 1000,
      };
    } else {
      q = migrateOldFormat({
        text: row.question,
        options: [row.option_a, row.option_b, row.option_c, row.option_d].map(String).filter(s => s.trim()),
        correct: parseInt(row.correct_index, 10),
        timeLimit: parseInt(row.time_limit_ms, 10) || 20000,
      });
    }
    quizMap[title].questions.push(q);
  }
  return Object.values(quizMap);
}

// ── DOCX parser ─────────────────────────────────────────────────────────────
// Supports new TYPE: keyword alongside old A:/B:/C:/D: + CORRECT: format.
// New format keywords:
//   TYPE: multiple_choice | true_false | type_answer | slider | poll | ordering
//   DATA: { JSON questionData }
//   POINTS: 1000
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
        if (currentQ) { finaliseDocxQuestion(currentQ); currentQuiz.questions.push(currentQ); currentQ = null; }
        quizzes.push(currentQuiz);
      }
      currentQuiz = { title: line.slice(5).trim(), category: null, questions: [] };
    } else if (line.toUpperCase().startsWith('CATEGORY:')) {
      if (currentQuiz) currentQuiz.category = line.slice(9).trim();
    } else if (line.toUpperCase().startsWith('Q:')) {
      if (currentQ && currentQuiz) { finaliseDocxQuestion(currentQ); currentQuiz.questions.push(currentQ); }
      currentQ = {
        text: line.slice(2).trim(),
        // Temp fields for parsing old A:/B:/CORRECT: format
        _options: [],
        _correct: 0,
        // New format fields
        type: null,
        questionData: null,
        timeLimit: 20000,
        points: 1000,
      };
    } else if (/^[A-D]:/i.test(line) && currentQ) {
      currentQ._options.push(line.slice(2).trim());
    } else if (line.toUpperCase().startsWith('CORRECT:') && currentQ) {
      const letter = line.slice(8).trim().toUpperCase();
      currentQ._correct = ['A', 'B', 'C', 'D'].indexOf(letter);
    } else if (line.toUpperCase().startsWith('TIME:') && currentQ) {
      currentQ.timeLimit = parseInt(line.slice(5).trim(), 10) || 20000;
    } else if (line.toUpperCase().startsWith('TYPE:') && currentQ) {
      currentQ.type = line.slice(5).trim().toLowerCase();
    } else if (line.toUpperCase().startsWith('DATA:') && currentQ) {
      try { currentQ.questionData = JSON.parse(line.slice(5).trim()); } catch { /* ignore parse errors */ }
    } else if (line.toUpperCase().startsWith('POINTS:') && currentQ) {
      currentQ.points = parseInt(line.slice(7).trim(), 10) || 1000;
    }
  }
  if (currentQ && currentQuiz) { finaliseDocxQuestion(currentQ); currentQuiz.questions.push(currentQ); }
  if (currentQuiz) quizzes.push(currentQuiz);
  return quizzes;
}

/**
 * Finalise a DOCX question: if no explicit type/questionData was provided,
 * fall back to old A:/B:/CORRECT: format and migrate to multiple_choice.
 */
function finaliseDocxQuestion(q) {
  if (!q.type || !q.questionData) {
    // Old format — convert using collected options
    const migrated = migrateOldFormat({
      text: q.text,
      options: q._options,
      correct: q._correct,
      timeLimit: q.timeLimit,
      points: q.points,
    });
    q.type = migrated.type;
    q.questionData = migrated.questionData;
    q.timeLimit = migrated.timeLimit;
    q.points = migrated.points;
  }
  // Clean up temp parsing fields
  delete q._options;
  delete q._correct;
}
