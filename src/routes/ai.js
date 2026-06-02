import { Router } from 'express';
import OpenAI from 'openai';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
const openai = new OpenAI(); // Automatically uses OPENAI_API_KEY from .env

router.post('/generate', authMiddleware, async (req, res, next) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

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
          content: `Generate a quiz about: ${prompt}`,
        },
      ],
    });

    const resultString = completion.choices[0].message.content;
    const resultJson = JSON.parse(resultString);

    // Provide default formatting in case AI missed something
    const formattedQuestions = (resultJson.questions || []).map(q => ({
      text: q.text || 'Untitled Question',
      type: q.type || 'multiple_choice',
      questionData: q.questionData || {},
      timeLimit: q.timeLimit || 20000,
      points: q.points || 1000,
    }));

    res.json({
      title: resultJson.title || 'AI Generated Quiz',
      category: resultJson.category || 'General',
      questions: formattedQuestions,
    });
  } catch (err) {
    console.error('AI Generation Error:', err);
    res.status(500).json({ error: 'Failed to generate quiz with AI' });
  }
});

export default router;
