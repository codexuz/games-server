import OpenAI from 'openai';
import prisma from '../../prisma.js';

let openai;
try {
  openai = new OpenAI();
} catch (e) {
  console.error('Failed to initialize OpenAI (missing key?). AI Worker disabled.');
}

const POLL_INTERVAL = 3000;

async function processAiJobs() {
  if (!openai) return;

  try {
    // Find next pending job
    const job = await prisma.aiJob.findFirst({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });

    if (!job) return;

    // Lock job
    await prisma.aiJob.update({
      where: { id: job.id },
      data: { status: 'processing' },
    });

    console.log(`[AI Worker] Processing job ${job.id}: "${job.prompt}"`);

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are an expert quiz creator. Generate a complete quiz based on the user's prompt. 
Respond ONLY with a JSON object in the following format:
{
  "title": "A short, engaging title for the quiz",
  "category": "A short category name",
  "questions": [
    {
      "text": "The question text",
      "type": "multiple_choice",
      "questionData": { "options": ["Option 1", "Option 2", "Option 3", "Option 4"], "correctIndex": 0 },
      "timeLimit": 20000,
      "points": 1000
    },
    {
      "text": "A true or false question",
      "type": "true_false",
      "questionData": { "correctAnswer": true },
      "timeLimit": 15000,
      "points": 1000
    },
    {
      "text": "A typing question",
      "type": "type_answer",
      "questionData": { "acceptedAnswers": ["Answer1", "Answer 1"], "caseSensitive": false },
      "timeLimit": 25000,
      "points": 1000
    },
    {
      "text": "A slider question guessing a number",
      "type": "slider",
      "questionData": { "min": 0, "max": 100, "step": 1, "correctValue": 50, "tolerance": 5 },
      "timeLimit": 20000,
      "points": 1000
    },
    {
      "text": "An ordering question",
      "type": "ordering",
      "questionData": { "items": ["First", "Second", "Third"], "correctOrder": [0, 1, 2] },
      "timeLimit": 30000,
      "points": 1000
    }
  ]
}

CRITICAL RULES:
1. Include between 5 and 10 questions.
2. Mix the question types! Do not just use multiple_choice. Try to use true_false, type_answer, slider, and ordering where they make sense.
3. For 'multiple_choice', ensure options has 2-8 strings, and correctIndex is an integer.
4. For 'slider', ensure min, max, step, correctValue, and tolerance are all numbers.
5. For 'ordering', correctOrder should always be [0, 1, 2, ...] corresponding to the correctly ordered items.
`,
        },
        {
          role: 'user',
          content: `Generate a quiz about: ${job.prompt}`,
        },
      ],
    });

    const resultString = completion.choices[0].message.content;
    const resultJson = JSON.parse(resultString);

    const questions = (resultJson.questions || []).map((q, i) => ({
      text: q.text || 'Untitled Question',
      type: q.type || 'multiple_choice',
      questionData: q.questionData || {},
      timeLimit: q.timeLimit || 20000,
      points: q.points || 1000,
      order: i,
    }));

    // Save generated quiz to DB
    const quiz = await prisma.quiz.create({
      data: {
        title: resultJson.title || 'AI Generated Quiz',
        category: resultJson.category || 'General',
        teacherId: job.teacherId,
        questions: {
          create: questions,
        },
      },
    });

    // Mark job as completed and attach quizId
    await prisma.aiJob.update({
      where: { id: job.id },
      data: {
        status: 'completed',
        quizId: quiz.id,
      },
    });

    console.log(`[AI Worker] Job ${job.id} completed. Quiz ${quiz.id} created.`);

  } catch (err) {
    console.error(`[AI Worker] Error processing job:`, err.message);
    
    // Find any processing job and mark it failed (simplistic recovery)
    try {
      const processingJob = await prisma.aiJob.findFirst({ where: { status: 'processing' } });
      if (processingJob) {
        await prisma.aiJob.update({
          where: { id: processingJob.id },
          data: { status: 'failed', error: err.message || 'Unknown error' },
        });
      }
    } catch (recoverErr) {
      console.error('[AI Worker] Failed to update job status to failed:', recoverErr.message);
    }
  }
}

let workerInterval = null;

export function startAiWorker() {
  if (workerInterval) return;
  console.log('[AI Worker] Starting background worker loop...');
  workerInterval = setInterval(processAiJobs, POLL_INTERVAL);
}

export function stopAiWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('[AI Worker] Stopped.');
  }
}
