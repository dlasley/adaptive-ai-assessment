# Setup Guide

## Quick Start (5 minutes)

### 1. Get Your Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up or log in
3. Navigate to API Keys section
4. Create a new API key
5. Copy the key (it starts with `sk-ant-...`)

### 2. Configure the Application

1. Open the file `.env.local` in your project root
2. Replace `your_api_key_here` with your actual API key:
   ```
   ANTHROPIC_API_KEY=sk-ant-api03-your-actual-key-here
   ```
3. Save the file

### 3. Start the Application

```bash
npm run dev
```

The application will start at [http://localhost:3000](http://localhost:3000)

## How to Use

### For Students

1. **Open the app** in your browser at http://localhost:3000
2. **Choose a unit** from the home page (Introduction, Unit 2, or Unit 3)
3. **Select a topic** you want to practice
4. **Configure your quiz**:
   - Choose number of questions (3-10)
   - Select difficulty level (beginner, intermediate, advanced)
5. **Click "Start Practice Session"**
6. **Answer questions** - you'll get:
   - Multiple choice questions
   - Fill-in-the-blank exercises
   - True/false questions
7. **Check your answer** after each question for instant feedback
8. **Review results** at the end with explanations for all answers

### Understanding Your Results

- **Green boxes**: Correct answers ✅
- **Red boxes**: Incorrect answers ❌
- **Explanations**: Each question includes an explanation of the correct answer
- **Percentage score**: Shows your overall performance

## Tips for Best Results

### For Beginners
- Start with 3-5 questions
- Choose "beginner" difficulty
- Focus on one topic at a time
- Read the explanations carefully

### For Intermediate/Advanced
- Try 7-10 questions
- Mix different topics
- Challenge yourself with "advanced" difficulty
- Review incorrect answers to identify patterns

## Troubleshooting

### "Error generating questions"
- **Check your API key**: Make sure it's correctly copied in `.env.local`
- **Restart the server**: Press Ctrl+C and run `npm run dev` again
- **Check your internet**: The app needs internet to connect to Semantic API

### Page won't load
- Make sure you ran `npm install` first
- Check that port 3000 isn't already in use
- Try `npm run build` then `npm start`

### Questions seem off-topic
- This can happen if the topic matching isn't perfect
- Try selecting a more specific topic
- The AI works best with topics that closely match the learning materials

## Customization

### Adding More Units
Edit `src/lib/units.ts` to add new units or modify topics

### Changing Question Limits
Edit `src/app/unit/[unitId]/page.tsx` to change the min/max questions:
```tsx
min="3"  // Change minimum
max="10" // Change maximum
```

### Modifying Question Types
Edit the prompt in `src/app/api/generate-questions/route.ts` to request specific question formats

## Production Deployment

### Deploy to Vercel (Recommended)

1. Push your code to GitHub
2. Go to [vercel.com](https://vercel.com)
3. Import your repository
4. Add `ANTHROPIC_API_KEY` in the Environment Variables section
5. Deploy!

Your app will be live at `your-app.vercel.app`

## Cost Considerations

The app uses Semantic API which has costs:
- **Claude 3.5 Sonnet**: ~$3 per million input tokens, ~$15 per million output tokens
- **Typical quiz**: ~2,000 input tokens + ~1,000 output tokens
- **Approximate cost per quiz**: $0.01-0.02

For a classroom of 30 students each taking 3 quizzes per week:
- Weekly cost: ~$2-3
- Monthly cost: ~$8-12

## Support

For issues or questions:
1. Check this setup guide
2. Review the README.md
3. Check the console for error messages (F12 in browser)

## Next Steps

Once you're comfortable with the app:
- Experiment with different topics and difficulty levels
- Track your progress over time
- Use the explanations to study areas where you struggle
- Challenge yourself to improve your scores

Bonne chance! 🇫🇷
