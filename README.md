# French Assessment Tool 🇫🇷

An AI-powered French language learning assessment application built with Next.js and Semantic API.

## Features

- **AI-Generated Questions**: Uses Semantic API to generate personalized practice questions from your French learning materials
- **Multiple Question Types**: Multiple choice, fill-in-the-blank, and true/false questions
- **Three Units**: Practice with Introduction, Unit 2, or Unit 3 materials
- **Topic-Specific Practice**: Focus on specific topics within each unit
- **Difficulty Levels**: Choose between beginner, intermediate, and advanced difficulty
- **Instant Feedback**: Get immediate explanations for correct and incorrect answers
- **Progress Tracking**: See your results and review all answers at the end

## Getting Started

### Prerequisites

- Node.js 18+ installed
- An Anthropic API key (get one at [console.anthropic.com](https://console.anthropic.com))

### Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env.local` file in the root directory:
   ```bash
   cp .env.example .env.local
   ```

4. Add your Anthropic API key to `.env.local`:
   ```
   ANTHROPIC_API_KEY=your_api_key_here
   ```

5. Start the development server:
   ```bash
   npm run dev
   ```

6. Open [http://localhost:3000](http://localhost:3000) in your browser

## How It Works

1. **Choose a Unit**: Select from Introduction, Unit 2, or Unit 3
2. **Pick a Topic**: Focus on specific vocabulary or grammar topics
3. **Configure Your Quiz**: Choose the number of questions (3-10) and difficulty level
4. **Practice**: Answer AI-generated questions with instant feedback
5. **Review**: See your score and review all answers with explanations

## Project Structure

```
french-assessment-claude-1/
├── learnings/              # French learning materials (Markdown files)
│   ├── French 1 Introduction.md
│   ├── French 1 Unit 2.md
│   ├── French 1 Unit 3.md
│   └── Ongoing Unit 2 Slides.md
├── src/
│   ├── app/               # Next.js app directory
│   │   ├── api/           # API routes
│   │   │   └── generate-questions/  # Semantic API integration
│   │   ├── quiz/          # Quiz interface
│   │   └── unit/          # Unit selection
│   ├── components/        # React components
│   ├── lib/              # Utility functions
│   │   ├── units.ts      # Unit definitions
│   │   └── learning-materials.ts  # Material loading
│   └── types/            # TypeScript types
└── package.json
```

## Technologies Used

- **Next.js 15**: React framework with App Router
- **TypeScript**: Type-safe development
- **Tailwind CSS**: Utility-first styling
- **Semantic API**: AI question generation
- **Anthropic SDK**: Official SDK for Claude

## Development

```bash
# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run linter
npm run lint
```

## License

This project is for educational purposes.

## Credits

Built with Claude Code and powered by Anthropic's Semantic API.
